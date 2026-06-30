import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";
import { generateColdEmailTemplate } from "./generateColdEmailTemplate.js";

export type ColdEmailInput = {
  firstName?: string;
  email?: string;
  companyName?: string;
  companyNameNormalized?: string;
  title?: string;
  city?: string;
  state?: string;
  companySize?: string;
  companyProductsServices?: string;
  companyDescription?: string;
  facilityType?: string;
  talentType?: string;
};

const COLD_EMAIL_MODEL = process.env.COLD_EMAIL_MODEL ?? DEFAULT_CHAT_MODEL;

const BANNED_OPENER_RE =
  /\b(commendable|impressive|inspiring|innovative approach|great reputation|prime location|paving the way|sets a high standard|making a real difference|your commitment|uniquely positioned|well done|good work|excelling at|enhancing client outcomes)\b/i;

const BANNED_TEASER_RE =
  /\b(discover|imagine|exceptional|top-tier|elevate|dedicated professionals|skilled professionals ready|access to|await you|ready to connect)\b/i;

const FEW_SHOT = `EXAMPLE 1:
LINE1: Dennis, filling residential beds across three states means counselor gaps hit census before marketing does.
LINE2: We placed someone last month who walked into a Florida site on day four.
LINE3: Twelve-year dual diagnosis counselor, residential ready, Florida licensed
LINE4: Are you currently hiring for dual-diagnosis counselors or RN support this quarter?

EXAMPLE 2:
LINE1: Vincent, thirteen Warren-area clinics mean one empty therapist slot ripples across your whole week.
LINE2: We filled an outpatient DPT role at a multi-site Ohio group last month.
LINE3: Ortho and neuro DPT, Warren commutable, floats across multi-site
LINE4: Are your current openings mainly DPT, OT, or clinic float coverage?

NEVER write compliment openers like "your commitment is commendable" or vague teasers like "discover top-tier talent".`;

function contextBlock(input: ColdEmailInput): string {
  return [
    `First Name: ${cleanText(input.firstName)}`,
    `Title: ${cleanText(input.title)}`,
    `Company: ${cleanText(input.companyNameNormalized) || cleanText(input.companyName)}`,
    `City: ${cleanText(input.city)}`,
    `State: ${cleanText(input.state)}`,
    `Company Size: ${cleanText(input.companySize)}`,
    `Facility Type: ${cleanText(input.facilityType)}`,
    `Talent Type: ${cleanText(input.talentType)}`,
    `Products/Services: ${cleanText(input.companyProductsServices).slice(0, 500)}`,
    `Description: ${cleanText(input.companyDescription).slice(0, 800)}`
  ].join("\n");
}

function parseLines(raw: string): string[] {
  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^LINE[1-4]\s*:\s*(.+)$/i);
    if (m?.[1]) lines.push(m[1].trim());
  }
  if (lines.length === 4) return lines;

  const htmlParts = raw
    .replace(/^```html?\s*/i, "")
    .replace(/```\s*$/i, "")
    .replace(/<\/?div>/gi, "")
    .split(/<br\s*\/?>/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (htmlParts.length >= 4) return htmlParts.slice(0, 4);

  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function validateLines(firstName: string, lines: string[]): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const [opener, proof, teaser, cta] = lines;

  if (!opener?.toLowerCase().startsWith(`${firstName.toLowerCase()},`)) {
    reasons.push("opener must start with first name and comma");
  }
  if (BANNED_OPENER_RE.test(opener ?? "")) reasons.push("opener uses compliment phrasing");
  if ((proof ?? "").length < 15) reasons.push("proof line too short");
  if (BANNED_TEASER_RE.test(teaser ?? "")) reasons.push("teaser too vague");
  const tw = wordCount(teaser ?? "");
  if (tw < 6 || tw > 12) reasons.push(`teaser word count ${tw}`);
  if (!(cta ?? "").includes("?")) reasons.push("CTA must be a question");
  if (wordCount(lines.join(" ")) > 62) reasons.push("total too long");
  return { ok: reasons.length === 0, reasons };
}

export function assembleColdEmailHtml(lines: string[]): string {
  const clean = lines
    .map((l) => l.trim().replace(/<[^>]+>/g, "").replace(/^[-–•]\s*/, ""))
    .filter(Boolean)
    .slice(0, 4);
  return `<div>${clean.join("<br></br>")}</div>`;
}

async function generateOnce(input: ColdEmailInput, feedback?: string): Promise<string[]> {
  const firstName = cleanText(input.firstName);
  const system = `You write healthcare staffing cold emails as exactly four labeled lines.

Return ONLY:
LINE1: <opener>
LINE2: <proof>
LINE3: <teaser>
LINE4: <cta>

Rules:
- Under 60 words total.
- LINE1 starts with "${firstName}," then a specific operational pain (not a compliment).
- LINE2: result for a similar operator, not agency bragging.
- LINE3: blind teaser, 8-10 words, credential-style, no names.
- LINE4: vague hiring question. No shortlist promises.

${FEW_SHOT}`;

  const user = [contextBlock(input), feedback ? `Fix: ${feedback}` : ""].filter(Boolean).join("\n\n");
  const openai = getOpenAI();
  const out = await withRetry(
    () =>
      openai.chat.completions.create({
        model: COLD_EMAIL_MODEL,
        temperature: 0.85,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      }),
    { label: `openai.coldEmail "${firstName}"` }
  );
  return parseLines(out.choices[0]?.message?.content?.trim() ?? "");
}

export async function generateColdEmail(input: ColdEmailInput): Promise<string> {
  const firstName = cleanText(input.firstName);
  if (!firstName) return "";

  if (process.env.TEMPLATE_COLD_EMAIL === "true") {
    return generateColdEmailTemplate(input);
  }

  let feedback = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const lines = await generateOnce(input, feedback || undefined);
      const validation = validateLines(firstName, lines);
      if (validation.ok && lines.length === 4) return assembleColdEmailHtml(lines);
      feedback = validation.reasons.join("; ");
      if (attempt === 2) {
        console.warn(`[generateColdEmail] ${firstName} validation: ${feedback}`);
        if (lines.length === 4) return assembleColdEmailHtml(lines);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("429") || msg.includes("quota")) {
        console.warn(`[generateColdEmail] ${firstName} OpenAI quota hit, using template fallback`);
        return generateColdEmailTemplate(input);
      }
      console.warn(`[generateColdEmail] ${firstName} attempt ${attempt + 1}: ${msg}`);
    }
  }
  return generateColdEmailTemplate(input);
}
