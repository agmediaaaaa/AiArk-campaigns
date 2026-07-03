import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";

export type GtmMotion =
  | "enterprise_sales"
  | "sales_led_b2b"
  | "hybrid_plg_sales"
  | "marketplace"
  | "plg";

export type GtmClassification = {
  motion: GtmMotion;
  north_star_metric: string;
  offer_metric: string;
  account_list_size: number;
  rationale: string;
};

const MOTION_DEFAULTS: Record<
  GtmMotion,
  { north_star_metric: string; offer_metric: string; account_list_size: number }
> = {
  enterprise_sales: {
    north_star_metric: "qualified buying conversations",
    offer_metric: "4-6 qualified buying conversations per quarter",
    account_list_size: 60
  },
  sales_led_b2b: {
    north_star_metric: "qualified demos/intros",
    offer_metric: "15-20 qualified demos/intros in 60 days",
    account_list_size: 175
  },
  hybrid_plg_sales: {
    north_star_metric: "qualified SQLs",
    offer_metric: "8 qualified SQLs in 60 days",
    account_list_size: 175
  },
  marketplace: {
    north_star_metric: "qualified activation conversations",
    offer_metric: "12-18 qualified activation conversations in 60 days",
    account_list_size: 200
  },
  plg: {
    north_star_metric: "qualified signups",
    offer_metric: "30 qualified signups in 60 days",
    account_list_size: 300
  }
};

export async function classifyGtmMotion(input: {
  companyName?: string;
  companyDescription?: string;
  companyProductsServices?: string;
  companyIndustry?: string;
  companySize?: string;
  title?: string;
}): Promise<GtmClassification> {
  const openai = getOpenAI();
  const prompt = `Classify this B2B company's primary revenue motion. Return JSON only:
{
  "motion": "enterprise_sales" | "sales_led_b2b" | "hybrid_plg_sales" | "marketplace" | "plg",
  "rationale": "one short sentence"
}

Company: ${cleanText(input.companyName)}
Industry: ${cleanText(input.companyIndustry)}
Size: ${cleanText(input.companySize)}
Title: ${cleanText(input.title)}
Description: ${cleanText(input.companyDescription).slice(0, 500)}
Products: ${cleanText(input.companyProductsServices).slice(0, 300)}

Rules:
- enterprise_sales: long cycles, named accounts, procurement/committee buying
- sales_led_b2b: demo-led SMB/mid-market SaaS or B2B services
- hybrid_plg_sales: self-serve plus sales-assist
- marketplace: platform connecting buyers and sellers
- plg: product-led signup/trial motion`;

  try {
    const out = await withRetry(
      () =>
        openai.chat.completions.create({
          model: DEFAULT_CHAT_MODEL,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "Return valid JSON only." },
            { role: "user", content: prompt }
          ]
        }),
      { label: "openai.classifyGtmMotion" }
    );
    const raw = JSON.parse(out.choices[0]?.message?.content ?? "{}") as {
      motion?: string;
      rationale?: string;
    };
    const motion = normalizeMotion(raw.motion);
    const defaults = MOTION_DEFAULTS[motion];
    return {
      motion,
      north_star_metric: defaults.north_star_metric,
      offer_metric: defaults.offer_metric,
      account_list_size: defaults.account_list_size,
      rationale: cleanText(raw.rationale) || defaults.offer_metric
    };
  } catch {
    return {
      motion: "sales_led_b2b",
      ...MOTION_DEFAULTS.sales_led_b2b,
      rationale: "default sales-led classification"
    };
  }
}

function normalizeMotion(raw?: string): GtmMotion {
  const m = cleanText(raw).toLowerCase();
  if (m.includes("enterprise")) return "enterprise_sales";
  if (m.includes("hybrid")) return "hybrid_plg_sales";
  if (m.includes("marketplace")) return "marketplace";
  if (m === "plg" || m.includes("product_led")) return "plg";
  return "sales_led_b2b";
}
