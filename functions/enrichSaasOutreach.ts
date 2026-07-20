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
  identified_fit_count: number;
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

const MOTION_RANGES: Record<SaasMotion, [number, number]> = {
  plg: [90, 150],
  b2b: [45, 85],
  enterprise: [12, 35]
};

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function identifiedFitCount(motion: SaasMotion, companyName: string): number {
  const seed = hashSeed(`${motion}:${companyName.toLowerCase().trim()}`);
  const [min, max] = MOTION_RANGES[motion];
  return min + (seed % (max - min + 1));
}

function resolveFirstName(input: SaasOutreachInput): string {
  const raw = cleanText(input.firstName);
  if (!raw) return "there";
  const word = raw.split(/\s+/)[0] ?? raw;
  if (!word) return "there";
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

const systemPrompt = (
  firstName: string,
  fitCount?: number,
  motion?: SaasMotion
) => `You write short cold outreach to SaaS founders. Return strict JSON only. No markdown.

Background (for your understanding only — NEVER name this vendor or website in output): we help founders book demos, warm intros, and product signups with lookalike accounts in their ICP.

Infer the founder's dream outcome, wants, and fears (flat MRR, ghosted demos, empty calendar, founder-led sales burnout).

Rules:
- saas_motion: exactly one of "plg", "b2b", "enterprise"
- customer_type: short phrase (who THEY sell to)
- lead_icp: one sentence, THEIR ideal customer profile
- value_prop: max 55 words on what we can do for THEM (identified fit accounts, warm intros, booked demos/signups). No vendor/company name. No hype.
- cold_email_body: HTML only. Start "<div></div>${firstName},<br></br>" — real first name, no merge tags. Structure: (1) outcome hook / tension (2) dream vs fear (3) "We've identified ${fitCount ?? "N"} companies/accounts that fit [their product/ICP]" using the EXACT number ${fitCount ?? "(see motion ranges)"} (4) plan to turn them into signups (plg), demos (enterprise), or demos and signups (b2b). Soft CTA. Only <br></br> breaks. Max 55 words excluding HTML.
- NEVER mention Zillion Systems, zillionsystems, AI Ark, or any vendor name. Use "we" only.
- No spam words: guaranteed, free, act now, limited time, revolutionary, game-changing, 10x, unlock, skyrocket, crush, dominate, best-in-class, cutting-edge, world-class, unprecedented, click here, risk-free, no obligation
${fitCount && motion ? `- LOCKED: saas_motion="${motion}", identified_fit_count=${fitCount} must appear verbatim in cold_email_body` : ""}`;

const USER = (input: SaasOutreachInput, firstName: string) => `Lead first name: ${firstName}
Company: ${cleanText(input.companyName)}
Title: ${cleanText(input.title)}
Industry: ${cleanText(input.companyIndustry)}
Size: ${cleanText(input.companySize)}
Description: ${cleanText(input.companyDescription)}
Products/Services: ${cleanText(input.companyProductsServices)}

Fit-count ranges by motion (use exact count from your chosen motion — pick one motion first):
- plg: 90-150 companies, CTA = product signups
- b2b: 45-85 companies, CTA = demos and signups
- enterprise: 12-35 accounts, CTA = qualified demos

Return JSON:
{
  "saas_motion": "plg" | "b2b" | "enterprise",
  "customer_type": string,
  "lead_icp": string,
  "value_prop": string,
  "cold_email_body": string
}`;

const strictRetry = (firstName: string, fitCount: number, motion: SaasMotion) => `Validation failed. Fix output.
- saas_motion must be "${motion}"
- cold_email_body MUST include the number ${fitCount} verbatim
- Start with "<div></div>${firstName},<br></br>"
- No merge tags, no vendor names (Zillion, zillionsystems, AI Ark)
- Max 55 words excluding HTML tags
- Return JSON only`;

export async function enrichSaasOutreach(input: SaasOutreachInput): Promise<SaasOutreachResult> {
  const company = cleanText(input.companyName) || "your company";
  const firstName = resolveFirstName(input);

  try {
    let parsed = await callModel(input, firstName, false);
    let result = buildResult(parsed, company, input, firstName);
    if (!validateResult(result).ok) {
      parsed = await callModel(input, firstName, true, result.saas_motion, result.identified_fit_count);
      result = buildResult(parsed, company, input, firstName);
    }
    if (!validateResult(result).ok) {
      return fallbackResult(company, input, firstName, result.saas_motion);
    }
    return result;
  } catch (err) {
    console.warn(`[enrichSaasOutreach] fallback: ${(err as Error).message}`);
    return fallbackResult(company, input, firstName, "b2b");
  }
}

async function callModel(
  input: SaasOutreachInput,
  firstName: string,
  strict: boolean,
  lockedMotion?: SaasMotion,
  lockedFitCount?: number
): Promise<Partial<SaasOutreachResult>> {
  const openai = getOpenAI();
  const out = await withRetry(
    () =>
      openai.chat.completions.create({
        model: DEFAULT_CHAT_MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: systemPrompt(firstName, lockedFitCount, lockedMotion)
          },
          { role: "user", content: USER(input, firstName) },
          ...(strict && lockedMotion && lockedFitCount !== undefined
            ? [{ role: "user" as const, content: strictRetry(firstName, lockedFitCount, lockedMotion) }]
            : [])
        ]
      }),
    { label: `openai.enrichSaas "${cleanText(input.companyName).slice(0, 40)}"` }
  );
  const raw = out.choices[0]?.message?.content?.trim() ?? "{}";
  return parseJson(raw, lockedMotion);
}

function parseJson(raw: string, lockedMotion?: SaasMotion): Partial<SaasOutreachResult> {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const motion = lockedMotion ?? normalizeMotion(obj.saas_motion);
    return {
      saas_motion: motion,
      customer_type: String(obj.customer_type ?? "").trim(),
      lead_icp: String(obj.lead_icp ?? "").trim(),
      value_prop: String(obj.value_prop ?? "").trim(),
      cold_email_body: String(obj.cold_email_body ?? "").trim()
    };
  } catch {
    return { saas_motion: lockedMotion ?? "b2b" };
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
  const fitCount = identifiedFitCount(motion, company);
  const customerType = parsed.customer_type || cleanText(input.companyIndustry) || "SaaS buyers";
  const leadIcp = parsed.lead_icp || `Teams that need ${customerType}`;
  let valueProp = stripSpam(stripWrongVendor(parsed.value_prop || ""));
  let coldBody = finalizeColdEmailBody(
    stripWrongVendor(parsed.cold_email_body || ""),
    firstName,
    company,
    motion,
    fitCount
  );

  valueProp = truncateWords(valueProp, 60);
  coldBody = truncateWords(stripHtmlForCount(coldBody), 60, coldBody);

  return {
    saas_motion: motion,
    customer_type: customerType,
    primary_cta: ctaForMotion(motion),
    lead_icp: leadIcp,
    value_prop: valueProp,
    cold_email_body: coldBody,
    identified_fit_count: fitCount
  };
}

function finalizeColdEmailBody(
  raw: string,
  firstName: string,
  company: string,
  motion: SaasMotion,
  fitCount: number
): string {
  let body = raw.trim().replace(/\{\{first_name\}\}/gi, firstName);
  if (!body.startsWith("<div></div>")) {
    body = `<div></div>${body}`;
  }
  body = body.replace(/\n/g, "<br></br>");

  const brIdx = body.indexOf("<br></br>");
  const rest = brIdx >= 0 ? body.slice(brIdx) : `<br></br>${body.slice("<div></div>".length)}`;
  body = `<div></div>${firstName},${rest}`;
  body = stripWrongVendor(body);

  const draft = { cold_email_body: body, identified_fit_count: fitCount, value_prop: "" };
  if (!validateResult(draft).ok) {
    return fallbackColdEmail(company, motion, firstName, fitCount);
  }
  return body;
}

function stripWrongVendor(text: string): string {
  return text
    .replace(/\bZillion\s*Systems\b/gi, "")
    .replace(/\bzillionsystems(?:\.com)?\b/gi, "")
    .replace(/\bAI\s*Ark\b/gi, "")
    .replace(/\bAIArk\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
}

function hasBrandLeak(text: string): boolean {
  return /\bzillion\b/i.test(text) || /\bzillionsystems\b/i.test(text) || /\bai\s*ark\b/i.test(text);
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
  if (hasBrandLeak(body) || hasBrandLeak(r.value_prop ?? "")) {
    return { ok: false, reason: "brand leak" };
  }
  if (r.identified_fit_count !== undefined && !body.includes(String(r.identified_fit_count))) {
    return { ok: false, reason: "fit count missing" };
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

function fallbackColdEmail(
  company: string,
  motion: SaasMotion,
  firstName: string,
  fitCount: number
): string {
  if (motion === "plg") {
    return `<div></div>${firstName},<br></br>Most tools in your space stall after security review—signups never compound.<br></br>You want teams adopting without waiting on procurement. We've identified ${fitCount} companies that fit your ideal buyer—and a plan to turn them into product signups.<br></br>Worth a quick look?`;
  }
  if (motion === "enterprise") {
    return `<div></div>${firstName},<br></br>Most enterprise pilots die in procurement—months pass with nothing on the calendar.<br></br>You need buyers who already feel the pain, not cold lists. We've mapped ${fitCount} accounts that match your ICP and a plan to land qualified demos with the right leaders.<br></br>Open to a brief call?`;
  }
  return `<div></div>${firstName},<br></br>Most buyers ghost after the demo—pipeline looks full but revenue stays flat.<br></br>You want meetings that convert and trials that stick. We've identified ${fitCount} lookalike accounts in your space and a plan to get them to demo or sign up.<br></br>Worth 15 minutes?`;
}

function fallbackResult(
  company: string,
  input: SaasOutreachInput,
  firstName: string,
  motion: SaasMotion
): SaasOutreachResult {
  const fitCount = identifiedFitCount(motion, company);
  return {
    saas_motion: motion,
    customer_type: cleanText(input.companyIndustry) || "SaaS buyers",
    primary_cta: ctaForMotion(motion),
    lead_icp: `Companies that need ${cleanText(input.companyProductsServices) || "your product"}`,
    value_prop: `We've identified ${fitCount} fit accounts in your ICP and a plan to turn them into demos and signups for ${company}.`,
    cold_email_body: fallbackColdEmail(company, motion, firstName, fitCount),
    identified_fit_count: fitCount
  };
}

export { wordCount, stripHtmlForCount, validateResult, SPAM_WORDS, resolveFirstName };
