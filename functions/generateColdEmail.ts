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

const SYSTEM = `You write short outcome-focused healthcare staffing cold emails.

Return ONLY the email body HTML using exactly this structure:
<div>line1<br></br>line2<br></br>teaser line<br></br>CTA line</div>

Rules:
- Under 60 words total across all four lines.
- Start line 1 with the prospect first name only. No Hi, Hello, or other salutation.
- No signature. No company name of the sender. No spam words or symbols.
- Outcome-focused for the prospect. Talk about what they get, not how good the sender is.
- Line 2: brief social proof as a result (not agency credentials).
- Line 3: blind candidate teaser, 8-10 words, no names.
- Line 4: vague CTA. Ask what roles they are hiring for OR assume a role from talent_type and ask if they are hiring for it. Do NOT promise immediate shortlists, instant connects, or guaranteed candidates.
- Human tone. Not templated or robotic. Unique phrasing each time.
- Use facility_type, talent_type, location, size, and company context naturally.`;

function prompt(input: ColdEmailInput): string {
  return [
    `First Name: ${cleanText(input.firstName)}`,
    `Title: ${cleanText(input.title)}`,
    `Company: ${cleanText(input.companyNameNormalized) || cleanText(input.companyName)}`,
    `City: ${cleanText(input.city)}`,
    `State: ${cleanText(input.state)}`,
    `Company Size: ${cleanText(input.companySize)}`,
    `Facility Type: ${cleanText(input.facilityType)}`,
    `Talent Type: ${cleanText(input.talentType)}`,
    `Products/Services: ${cleanText(input.companyProductsServices)}`,
    `Description: ${cleanText(input.companyDescription)}`
  ].join("\n");
}

export async function generateColdEmail(input: ColdEmailInput): Promise<string> {
  const firstName = cleanText(input.firstName);
  if (!firstName) return "";

  try {
    const openai = getOpenAI();
    const out = await withRetry(
      () =>
        openai.chat.completions.create({
          model: DEFAULT_CHAT_MODEL,
          temperature: 0.9,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: prompt(input) }
          ]
        }),
      { label: `openai.coldEmail "${firstName}"` }
    );

    const raw = out.choices[0]?.message?.content?.trim() ?? "";
    return sanitizeColdEmail(raw, firstName);
  } catch (err) {
    console.warn(`[generateColdEmail] fallback empty: ${(err as Error).message}`);
    return "";
  }
}

function sanitizeColdEmail(raw: string, firstName: string): string {
  let html = raw.replace(/^```html?\s*/i, "").replace(/```\s*$/i, "").trim();
  if (!html.startsWith("<div>")) {
    html = `<div>${html}</div>`;
  }
  if (!html.endsWith("</div>")) {
    html = `${html}</div>`;
  }
  html = html.replace(/<br\s*\/?>/gi, "<br></br>");
  if (!html.includes(firstName)) {
    html = html.replace(/^<div>/, `<div>${firstName}, `);
  }
  return html;
}
