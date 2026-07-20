import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";

export type SaasMotion = "b2b" | "enterprise" | "plg";
export type PrimaryCta = "demos" | "signups" | "demos_and_signups";

export type SaasOutreachInput = {
  firstName?: string;
  companyName?: string;
  companyDescription?: string;
  companyProductsServices?: string;
  companyIndustry?: string;
  title?: string;
  companySize?: string;
  vendorCompanyName?: string;
  vendorCompanyDescription?: string;
  vendorProductName?: string;
  vendorProductDescription?: string;
};

export type SaasOutreachResult = {
  saas_motion: SaasMotion;
  customer_type: string;
  primary_cta: PrimaryCta;
  lead_icp: string;
  value_prop: string;
  cold_email_body: string;
};

const SPAM_WORDS = [
  "guaranteed",
  "free",
  "act now",
  "limited time",
  "revolutionary",
  "game-changing",
  "game changing",
  "10x",
  "unlock",
  "skyrocket",
  "crush",
  "dominate",
  "best-in-class",
  "best in class",
  "cutting-edge",
  "cutting edge",
  "world-class",
  "world class",
  "unprecedented",
  "click here",
  "risk-free",
  "risk free",
  "no obligation"
];

function resolveFirstName(input: SaasOutreachInput): string {
  const raw = cleanText(input.firstName);
  if (!raw) return "there";
  const word = raw.split(/\s+/)[0] ?? raw;
  if (!word) return "there";
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

const systemPrompt = (firstName: string) => `You write cold outreach for Zillion Systems (zillionsystems.com) to SaaS founders.
Return strict JSON only. No markdown.

Zillion Systems helps SaaS founders get qualified demos and warm intros to buyers in their ICP. We are NOT pitching our own SaaS product — we are offering to help THEM grow pipeline (demos, intros, signups depending on their motion).

Before writing, infer the founder's dream outcome, what they want, and what they fear (flat MRR, ghosted demos, empty calendar, founder still doing all sales, no warm intros).

Rules:
- saas_motion: exactly one of "plg", "b2b", "enterprise"
- customer_type: short phrase (who THEY sell to)
- lead_icp: one sentence, THEIR ideal customer profile
- value_prop: max 55 words on how Zillion Systems can help THIS founder get demos/intros/signups for their product; specific, no hype. Never mention AI Ark.
- cold_email_body: HTML only (no subject). Start with "<div></div>${firstName},<br></br>" using real first name "${firstName}" — no merge tags. Line 2: outcome-based hook (tension they feel). Then their dream vs fear. Then how Zillion Systems books demos or warm intros to similar buyers. Soft CTA. Only <br></br> for breaks. Max 55 words excluding HTML tags.
- Never mention AI Ark. Sender is Zillion Systems / "we" at Zillion Systems.
- No spam words: guaranteed, free, act now, limited time, revolutionary, game-changing, 10x, unlock, skyrocket, crush, dominate, best-in-class, cutting-edge, world-class, unprecedented, click here, risk-free, no obligation
- Tone: peer-to-peer, specific to their product and buyers`;

const USER = (input: SaasOutreachInput, firstName: string) => `Lead first name: ${firstName}
Company: ${cleanText(input.companyName)}
Title: ${cleanText(input.title)}
Industry: ${cleanText(input.companyIndustry)}
Size: ${cleanText(input.companySize)}
Description: ${cleanText(input.companyDescription)}
Products/Services: ${cleanText(input.companyProductsServices)}

Vendor: ${cleanText(input.vendorCompanyName)}
Vendor description: ${cleanText(input.vendorCompanyDescription)}
Product: ${cleanText(input.vendorProductName)}
Product description: ${cleanText(input.vendorProductDescription)}

Return JSON:
{
  "saas_motion": "plg" | "b2b" | "enterprise",
  "customer_type": string,
  "lead_icp": string,
  "value_prop": string,
  "cold_email_body": string
}`;

const strictRetry = (firstName: string) => `Your previous output failed validation. Fix it.
- cold_email_body MUST start with "<div></div>${firstName},<br></br>" using the real first name "${firstName}"
- Never use {{first_name}} or any merge tags
- Never mention AI Ark — sender is Zillion Systems (demos and warm intros for the founder's product)
- Max 55 words in value_prop and cold_email_body (excluding HTML tags)
- No banned spam words
- Return JSON only`;

export async function enrichSaasOutreach(input: SaasOutreachInput): Promise<SaasOutreachResult> {
  const company = cleanText(input.companyName) || "your company";
  const firstName = resolveFirstName(input);

  let parsed: Partial<SaasOutreachResult> = {};
  try {
    parsed = await callModel(input, firstName, false);
    let result = buildResult(parsed, company, input, firstName);
    if (!validateResult(result).ok) {
      parsed = await callModel(input, firstName, true);
      result = buildResult(parsed, company, input, firstName);
    }
    if (!validateResult(result).ok) {
      return fallbackResult(company, input, firstName);
    }
    return result;
  } catch (err) {
    console.warn(`[enrichSaasOutreach] fallback: ${(err as Error).message}`);
    return fallbackResult(company, input, firstName);
  }
}

async function callModel(
  input: SaasOutreachInput,
  firstName: string,
  strict: boolean
): Promise<Partial<SaasOutreachResult>> {
  const openai = getOpenAI();
  const out = await withRetry(
    () =>
      openai.chat.completions.create({
        model: DEFAULT_CHAT_MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt(firstName) },
          { role: "user", content: USER(input, firstName) },
          ...(strict ? [{ role: "user" as const, content: strictRetry(firstName) }] : [])
        ]
      }),
    { label: `openai.enrichSaas "${cleanText(input.companyName).slice(0, 40)}"` }
  );
  const raw = out.choices[0]?.message?.content?.trim() ?? "{}";
  return parseJson(raw);
}

function parseJson(raw: string): Partial<SaasOutreachResult> {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const motion = normalizeMotion(obj.saas_motion);
    return {
      saas_motion: motion,
      customer_type: String(obj.customer_type ?? "").trim(),
      lead_icp: String(obj.lead_icp ?? "").trim(),
      value_prop: String(obj.value_prop ?? "").trim(),
      cold_email_body: String(obj.cold_email_body ?? "").trim()
    };
  } catch {
    return {};
  }
}

function normalizeMotion(value: unknown): SaasMotion {
  const v = String(value ?? "").toLowerCase().trim();
  if (v === "plg") return "plg";
  if (v === "enterprise") return "enterprise";
  return "b2b";
}

function ctaForMotion(motion: SaasMotion): PrimaryCta {
  if (motion === "plg") return "signups";
  if (motion === "enterprise") return "demos";
  return "demos_and_signups";
}

function buildResult(
  parsed: Partial<SaasOutreachResult>,
  company: string,
  input: SaasOutreachInput,
  firstName: string
): SaasOutreachResult {
  const motion = parsed.saas_motion ?? "b2b";
  const customerType = parsed.customer_type || cleanText(input.companyIndustry) || "SaaS buyers";
  const leadIcp = parsed.lead_icp || `Teams that need ${customerType}`;
  let valueProp = stripSpam(stripWrongVendor(parsed.value_prop || ""));
  let coldBody = finalizeColdEmailBody(
    stripWrongVendor(parsed.cold_email_body || ""),
    firstName,
    company,
    motion
  );

  valueProp = truncateWords(valueProp, 60);
  coldBody = truncateWords(stripHtmlForCount(coldBody), 60, coldBody);

  return {
    saas_motion: motion,
    customer_type: customerType,
    primary_cta: ctaForMotion(motion),
    lead_icp: leadIcp,
    value_prop: valueProp,
    cold_email_body: coldBody
  };
}

function finalizeColdEmailBody(
  raw: string,
  firstName: string,
  company: string,
  motion: SaasMotion
): string {
  let body = raw.trim().replace(/\{\{first_name\}\}/gi, firstName);
  if (!body.startsWith("<div></div>")) {
    body = `<div></div>${body}`;
  }
  body = body.replace(/\n/g, "<br></br>");

  const brIdx = body.indexOf("<br></br>");
  const rest = brIdx >= 0 ? body.slice(brIdx) : `<br></br>${body.slice("<div></div>".length)}`;
  body = `<div></div>${firstName},${rest}`;

  if (!validateResult({ cold_email_body: body }).ok) {
    return fallbackColdEmail(company, motion, firstName);
  }
  return body;
}

function stripWrongVendor(text: string): string {
  return text
    .replace(/\bAI\s*Ark\b/gi, "Zillion Systems")
    .replace(/\bAIArk\b/gi, "Zillion Systems");
}

function stripSpam(text: string): string {
  let out = text;
  for (const word of SPAM_WORDS) {
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    out = out.replace(re, "");
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

function stripHtmlForCount(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

function truncateWords(text: string, max: number, originalHtml?: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= max) return originalHtml ?? text;
  return (originalHtml ?? text).split(/\s+/).slice(0, max).join(" ");
}

function hasSpam(text: string): boolean {
  const lower = text.toLowerCase();
  return SPAM_WORDS.some((w) => lower.includes(w));
}

function validateResult(r: Partial<SaasOutreachResult>): { ok: boolean; reason?: string } {
  const body = r.cold_email_body ?? "";
  if (!body.startsWith("<div></div>")) {
    return { ok: false, reason: "cold_email format" };
  }
  if (!body.includes("<br></br>")) {
    return { ok: false, reason: "cold_email format" };
  }
  if (body.includes("{{")) {
    return { ok: false, reason: "merge tag" };
  }
  if (/\bai\s*ark\b/i.test(body) || /\bai\s*ark\b/i.test(r.value_prop ?? "")) {
    return { ok: false, reason: "wrong vendor" };
  }
  if (wordCount(stripHtmlForCount(body)) > 60) {
    return { ok: false, reason: "cold_email word count" };
  }
  if (r.value_prop && wordCount(r.value_prop) > 60) {
    return { ok: false, reason: "value_prop word count" };
  }
  if (hasSpam(r.value_prop ?? "") || hasSpam(stripHtmlForCount(body))) {
    return { ok: false, reason: "spam word" };
  }
  return { ok: true };
}

function fallbackColdEmail(company: string, motion: SaasMotion, firstName: string): string {
  if (motion === "plg") {
    return `<div></div>${firstName},<br></br>Most founders in your space see signups stall after the first security review—growth never compounds.<br></br>You want teams trying ${company} without a six-month procurement cycle. At Zillion Systems we warm-intro you to similar buyers and turn interest into product signups.<br></br>Worth a short call?`;
  }
  if (motion === "enterprise") {
    return `<div></div>${firstName},<br></br>Most enterprise pilots die in procurement—months pass with no meeting on the calendar.<br></br>You need ops leaders who already feel the pain, not cold lists. Zillion Systems books qualified demos and warm intros to peer executives ready to evaluate ${company}.<br></br>Open to a brief call?`;
  }
  return `<div></div>${firstName},<br></br>Most SMB buyers ghost after the demo—your pipeline looks full but revenue stays flat.<br></br>You want demos that close and trials that stick. Zillion Systems reaches founders and leaders at lookalike accounts and books demos plus signups for ${company}.<br></br>Worth 15 minutes to compare notes?`;
}

function fallbackResult(
  company: string,
  input: SaasOutreachInput,
  firstName: string
): SaasOutreachResult {
  const motion: SaasMotion = "b2b";
  return {
    saas_motion: motion,
    customer_type: cleanText(input.companyIndustry) || "SaaS buyers",
    primary_cta: ctaForMotion(motion),
    lead_icp: `Companies that need ${cleanText(input.companyProductsServices) || "your product"}`,
    value_prop: `Zillion Systems helps ${company} book qualified demos and warm intros to buyers in your ICP.`,
    cold_email_body: fallbackColdEmail(company, motion, firstName)
  };
}

export { wordCount, stripHtmlForCount, validateResult, SPAM_WORDS, resolveFirstName };
