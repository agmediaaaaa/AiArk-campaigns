import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";

export type StaffingEmailInput = {
  firstName?: string;
  title?: string;
  companyName?: string;
  companyDescription?: string;
  companyProductsServices?: string;
  companyIndustry?: string;
  city?: string;
  state?: string;
  talentType?: string;
  rowIndex?: number;
};

export type StaffingEmailResult = {
  body: string;
  wordCount: number;
};

const MAX_WORDS = 60;

const HOOK_PATTERNS = [
  (first: string, talent: string) =>
    `${first}, we've identified a few companies looking for ${talent} — is that a lane your team covers?`,
  (first: string, talent: string) =>
    `${first}, we have access to a few companies that need staffing help for ${talent} roles — open to a conversation?`,
  (first: string, talent: string) =>
    `${first}, we can connect you to a few companies hiring ${talent} — worth a look for your bench?`,
  (first: string, talent: string) =>
    `${first}, we've surfaced a few companies that may need ${talent} placement support — is that your lane?`,
  (first: string, talent: string) =>
    `${first}, we have access to a few companies looking for ${talent} talent — are you open to new placement conversations?`,
  (first: string, talent: string) =>
    `${first}, we've identified a few companies that need staffing help for ${talent} roles — something your team takes on?`,
  (first: string, talent: string) =>
    `${first}, we can connect you to a few companies looking for ${talent} — open to new work right now?`,
  (first: string, talent: string) =>
    `${first}, we have access to a few companies hiring ${talent} — could your team help place that talent?`,
  (first: string, talent: string) =>
    `${first}, we've identified a few companies looking for ${talent} talent — is that a fit for your bench?`,
  (first: string, talent: string) =>
    `${first}, we can connect you to a few companies that need ${talent} placement support — worth exploring?`
];

const CTA_PATTERNS = [
  "Happy to share more on a quick call.",
  "Would be glad to walk you through what we've found on a short call.",
  "Let me know if a quick call to compare notes makes sense.",
  "Can share the details over a ten-minute call if useful.",
  "Happy to walk you through what we've identified on a quick call.",
  "Would be glad to share more on a short call.",
  "Let me know if a quick call works for you.",
  "Happy to share what we've found on a quick call.",
  "Can walk you through the details on a short call if useful.",
  "Would be glad to compare notes on a quick call."
];

function firstNameOnly(raw?: string): string {
  const name = cleanText(raw);
  if (!name) return "there";
  return name.split(/\s+/)[0]!.replace(/[^a-zA-Z'-]/g, "") || "there";
}

export function countWords(text: string): number {
  const plain = text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.split(/\s+/).filter(Boolean).length;
}

function inferTalent(input: StaffingEmailInput): string {
  const explicit = cleanText(input.talentType);
  if (explicit) return explicit.toLowerCase();

  const text = `${cleanText(input.companyProductsServices)} ${cleanText(input.companyDescription)} ${cleanText(input.companyIndustry)}`.toLowerCase();
  if (/\bnurs|rn|lpn|cna|lvn|clinical/.test(text)) return "nursing talent";
  if (/\bnanny|household|domestic|estate/.test(text)) return "household staff";
  if (/\bphysician|crna|anesthesia|advanced practice/.test(text)) return "advanced practice providers";
  if (/\bit\b|software|engineer|sap|java|cloud|developer/.test(text)) return "IT contractors";
  if (/\bfinance|accounting|controller|cfo/.test(text)) return "finance leaders";
  if (/\bwarehouse|logistics|industrial|manufacturing/.test(text)) return "warehouse and logistics talent";
  if (/\bexecutive|c-suite|retained|search/.test(text)) return "executive leadership";
  if (/\bhealth|hospital|medical|therapy/.test(text)) return "healthcare staff";
  if (/\bcreative|marketing|design|copy/.test(text)) return "creative contractors";
  if (/\bcleared|defense|federal/.test(text)) return "cleared consultants";
  if (/\bscreening|background/.test(text)) return "high-volume screening support";
  return "contract talent";
}

export function personalizeStaffingEmailLocal(input: StaffingEmailInput): StaffingEmailResult {
  const rowIndex = input.rowIndex ?? 0;
  const first = firstNameOnly(input.firstName);
  const talent = inferTalent(input);
  const hook = HOOK_PATTERNS[rowIndex % HOOK_PATTERNS.length]!(first, talent);
  const cta = CTA_PATTERNS[rowIndex % CTA_PATTERNS.length]!;
  const inner = `${hook}<br></br>${cta}`;
  const body = `<div>${inner}</div>`;
  return { body, wordCount: countWords(body) };
}

export async function personalizeStaffingEmail(
  input: StaffingEmailInput,
  opts: { fallbackOnly?: boolean } = {}
): Promise<StaffingEmailResult> {
  if (opts.fallbackOnly) return personalizeStaffingEmailLocal(input);

  const local = personalizeStaffingEmailLocal(input);
  const first = firstNameOnly(input.firstName);

  try {
    const openai = getOpenAI();
    const out = await withRetry(
      () =>
        openai.chat.completions.create({
          model: DEFAULT_CHAT_MODEL,
          temperature: 0.9,
          messages: [
            {
              role: "system",
              content: `Write a 2-line cold email for staffing firm founders. Return ONLY inner HTML (no outer div).
Format: {hook line}<br></br>{CTA line}
Rules: under 60 words, first line starts with first name and comma, no Hi/Hello, outcome-focused, one talent type only.
NEVER claim existing clients, live job orders, or companies we already work with. Use prospective framing only:
- "we've identified a few companies looking for {talent}"
- "we have access to a few companies that need staffing help for {talent} roles"
- "we can connect you to a few companies hiring {talent}"
CTA invites a quick call to share what we've found — never mention briefs, accounts, or assignment details. Use <br></br> between lines.`
            },
            {
              role: "user",
              content: `First name: ${first}
Company: ${cleanText(input.companyName)}
Industry: ${cleanText(input.companyIndustry)}
Products: ${cleanText(input.companyProductsServices).slice(0, 200)}
Talent lane: ${inferTalent(input)}
Required CTA (adapt slightly): ${CTA_PATTERNS[(input.rowIndex ?? 0) % CTA_PATTERNS.length]}`
            }
          ]
        }),
      { label: `openai.staffingEmail "${first}"` }
    );

    let inner = (out.choices[0]?.message?.content ?? "").trim();
    inner = inner.replace(/^<div>/i, "").replace(/<\/div>$/i, "").trim();
    inner = inner.replace(/<br\s*\/?>/gi, "<br></br>");
    if (countWords(inner) > MAX_WORDS || !inner.includes("<br></br>")) {
      return local;
    }
    const body = `<div>${inner}</div>`;
    return { body, wordCount: countWords(body) };
  } catch {
    return local;
  }
}
