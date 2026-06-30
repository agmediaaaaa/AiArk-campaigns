import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";

export type ColdEmailInput = {
  firstName?: string;
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
  /\b(commendable|impressive|inspiring|innovative approach|great reputation|prime location|paving the way|sets a high standard|making a real difference|your commitment|well done|good work|proudly|leading the way)\b/i;

const BANNED_TEASER_RE =
  /\b(discover|imagine|exceptional|top-tier|elevate|dedicated professionals|skilled professionals ready|access to|await you)\b/i;

const FEW_SHOT_OPENERS = `GOOD openers (operational pain, no compliments):
- Dennis, filling residential beds across three states means counselor gaps hit census before marketing does.
- Vincent, thirteen Warren-area clinics mean one empty therapist slot ripples across your whole week.
- Laney, partner onboarding speed depends on people who speak both admissions workflow and EMR integration.
- Jordan, sleep clinics stall when scoring techs quit mid-quarter and DME orders pile up.

BAD openers (never write like this):
- Elina, your commitment to accessible obesity treatment is commendable.
- Ricardo, your therapy platform's potential in Portland is impressive.`;

const FEW_SHOT_TEASERS = `GOOD teasers (8-10 words, blind, credential-style):
- Twelve-year dual diagnosis counselor, residential ready, Florida licensed
- Ortho and neuro DPT, Warren commutable, floats across multi-site
- RPSGT with home testing workflow, clinic seasoned, two-week notice
- Admissions workflow lead, CRM and EMR fluent, remote

BAD teasers (never write like this):
- Exceptional talent ready to elevate care standards
- Discover top-tier candidates ready to make a difference`;

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

async function chat(system: string, user: string, temperature = 0.75): Promise<string> {
  const openai = getOpenAI();
  const out = await withRetry(
    () =>
      openai.chat.completions.create({
        model: COLD_EMAIL_MODEL,
        temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      }),
    { label: "openai.coldEmail.step" }
  );
  return (out.choices[0]?.message?.content ?? "").trim().replace(/^["']|["']$/g, "");
}

async function generateOpener(input: ColdEmailInput, feedback?: string): Promise<string> {
  const firstName = cleanText(input.firstName);
  const system = `You write line 1 only of a healthcare staffing cold email.

Return ONE sentence only. No HTML. No greeting words like Hi or Hello.

Rules:
- Must start with "${firstName}," then describe a specific operational pain or bottleneck tied to their facility type, services, size, or location.
- Outcome-focused for the prospect. Never compliment them. Never say commendable, impressive, inspiring, innovative, great reputation, prime location.
- Sound human and specific, not templated.

${FEW_SHOT_OPENERS}`;

  const user = [
    contextBlock(input),
    feedback ? `\nREJECTED — fix this:\n${feedback}` : ""
  ].join("\n");

  return chat(system, user, 0.8);
}

async function generateProof(input: ColdEmailInput, opener: string, feedback?: string): Promise<string> {
  const system = `You write line 2 only of a healthcare staffing cold email.

Return ONE sentence only. No HTML.

Rules:
- Brief social proof framed as a result for a similar operator (not agency bragging).
- Do NOT start with "We are" or list credentials. Prefer "Someone we placed..." or "A similar clinic..." style.
- Under 18 words.`;

  const user = [
    contextBlock(input),
    `Line 1 already written: ${opener}`,
    feedback ? `\nREJECTED — fix this:\n${feedback}` : ""
  ].join("\n");

  return chat(system, user, 0.7);
}

async function generateTeaser(input: ColdEmailInput, opener: string, proof: string, feedback?: string): Promise<string> {
  const system = `You write line 3 only — a blind candidate teaser.

Return ONLY the teaser phrase. No HTML. No names. Exactly 8-10 words.

Rules:
- Credential-style: years, specialty, license, region, availability, setting.
- Pull from talent_type and facility context.
- Never use discover, imagine, exceptional, top-tier, elevate.

${FEW_SHOT_TEASERS}`;

  const user = [
    contextBlock(input),
    `Line 1: ${opener}`,
    `Line 2: ${proof}`,
    feedback ? `\nREJECTED — fix this:\n${feedback}` : ""
  ].join("\n");

  return chat(system, user, 0.65);
}

async function generateCta(input: ColdEmailInput, opener: string, proof: string, teaser: string): Promise<string> {
  const system = `You write line 4 only — the CTA.

Return ONE sentence only. No HTML. Ends with ?

Rules:
- Vague. Ask what roles they are hiring for OR assume one role from talent_type and ask if they are hiring for it.
- Do NOT promise shortlists, instant intros, or guaranteed candidates.
- Vary phrasing. Under 14 words.`;

  const user = [
    contextBlock(input),
    `Line 1: ${opener}`,
    `Line 2: ${proof}`,
    `Line 3: ${teaser}`
  ].join("\n");

  return chat(system, user, 0.85);
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
  if (BANNED_OPENER_RE.test(opener ?? "")) {
    reasons.push("opener uses compliment or banned phrasing");
  }
  if ((proof ?? "").length < 20) {
    reasons.push("proof line too short");
  }
  const teaserWords = wordCount(teaser ?? "");
  if (teaserWords < 6 || teaserWords > 12) {
    reasons.push(`teaser must be 8-10 words (got ${teaserWords})`);
  }
  if (BANNED_TEASER_RE.test(teaser ?? "")) {
    reasons.push("teaser uses vague marketing language");
  }
  if (!(cta ?? "").includes("?")) {
    reasons.push("CTA must be a question");
  }
  const total = wordCount(lines.join(" "));
  if (total > 62) {
    reasons.push(`total word count too high (${total})`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function assembleColdEmailHtml(lines: string[]): string {
  const clean = lines.map((l) => l.trim().replace(/<[^>]+>/g, "")).filter(Boolean).slice(0, 4);
  return `<div>${clean.join("<br></br>")}</div>`;
}

export async function generateColdEmail(input: ColdEmailInput): Promise<string> {
  const firstName = cleanText(input.firstName);
  if (!firstName) return "";

  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      let openerFeedback = "";
      let proofFeedback = "";
      let teaserFeedback = "";

      let opener = "";
      for (let i = 0; i < 2; i++) {
        opener = await generateOpener(input, openerFeedback || undefined);
        if (!BANNED_OPENER_RE.test(opener) && opener.toLowerCase().startsWith(`${firstName.toLowerCase()},`)) {
          break;
        }
        openerFeedback = `Avoid compliments. Start with "${firstName}," and name a staffing or operations pain.`;
      }

      let proof = "";
      for (let i = 0; i < 2; i++) {
        proof = await generateProof(input, opener, proofFeedback || undefined);
        if (proof.length >= 20 && !/^we are\b/i.test(proof)) break;
        proofFeedback = "Use a result for a similar operator, not agency credentials.";
      }

      let teaser = "";
      for (let i = 0; i < 2; i++) {
        teaser = await generateTeaser(input, opener, proof, teaserFeedback || undefined);
        const tw = wordCount(teaser);
        if (tw >= 6 && tw <= 12 && !BANNED_TEASER_RE.test(teaser)) break;
        teaserFeedback = "Write 8-10 words, credential-style, no discover/exceptional/top-tier.";
      }

      const cta = await generateCta(input, opener, proof, teaser);
      const lines = [opener, proof, teaser, cta];
      const validation = validateLines(firstName, lines);

      if (validation.ok) {
        return assembleColdEmailHtml(lines);
      }

      if (attempt === maxAttempts - 1) {
        console.warn(
          `[generateColdEmail] ${firstName} validation failed after retries: ${validation.reasons.join("; ")}`
        );
        return assembleColdEmailHtml(lines);
      }
    } catch (err) {
      console.warn(`[generateColdEmail] attempt ${attempt + 1} failed: ${(err as Error).message}`);
      if (attempt === maxAttempts - 1) return "";
    }
  }

  return "";
}
