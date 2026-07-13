import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { buildMaLeadContext, type MaLeadInput } from "./buildMaLeadContext.js";
import { enrichMaIcp, type MaIcp } from "./enrichMaIcp.js";
import { classifyMaServiceType } from "./classifyMaServiceType.js";
import { quickNormalizeCompanyName } from "./enrichMaLeadFast.js";
import {
  assembleColdEmailHtmlNoTeaser,
  validateColdEmailHtmlNoTeaser,
  validateConnectLine,
  validateObservationLine
} from "./validateColdEmail.js";

export type MaNoTeaserResult = {
  company_name_normalized: string;
  ma_service_type: string;
  icp: MaIcp;
  narrative_angle: string;
  observation: string;
  connect_line: string;
  cold_email_html: string;
};

const COPY_TEMP = 0.85;
const MAX_RETRIES = 2;

const GLOBAL_BANS = `
Never use:
- Empty compliments ("impressive", "excels", "stands out", "unique approach", "truly", "powerful")
- "You focus on" / "Noticed you" / "I came across"
- Template filler or marketing speak ("unlock", "enhance", "growth strategies")
- Implied possession of a live deal ("we have a company", "ready to sell", "on my desk")
- Salutations (Hi/Hello) or signatures
- Do not start with "Exploring"
`;

async function generateSection(
  label: string,
  system: string,
  user: string,
  temperature = COPY_TEMP
): Promise<string> {
  const openai = getOpenAI();
  const out = await withRetry(
    () =>
      openai.chat.completions.create({
        model: DEFAULT_CHAT_MODEL,
        temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      }),
    { label: `openai.${label}` }
  );
  return cleanLine(out.choices[0]?.message?.content ?? "");
}

export async function enrichMaOutreachNoTeaser(
  input: MaLeadInput,
  productDescription: string
): Promise<MaNoTeaserResult> {
  const companyNameNormalized = quickNormalizeCompanyName(
    input.company_name_normalized || input.company_name
  );

  const maServiceType = await classifyMaServiceType({
    companyNameNormalized,
    companyDescription: input.company_description,
    companyProductsServices: input.company_products_services,
    title: input.title,
    companyWebsite: input.company_website
  });

  const icp = await enrichMaIcp({
    ...input,
    company_name_normalized: companyNameNormalized,
    ma_service_type: maServiceType
  });

  const ctx = buildMaLeadContext({
    ...input,
    company_name_normalized: companyNameNormalized,
    ma_service_type: maServiceType,
    ma_icp: icp
  });

  const firstName = ctx.firstName || "there";
  let narrativeAngle = "";
  let observation = "";
  let connectLine = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    narrativeAngle = await generateSection(
      `narrative "${firstName}"`,
      `You pick one specific, credible angle for a cold email to an M&A/capital advisory contact. Return one short sentence describing the angle only — not the email text. ${GLOBAL_BANS}`,
      `${ctx.promptBlock}

Pick a narrative angle grounded in their sector, mandate, geography, or deal focus. No flattery. Return one sentence only.`
    );

    observation = await generateSection(
      `observation "${firstName}"`,
      `You write ONE sentence for a cold email — an observation about the market, ICP, or work this advisory firm does. It comes right after their first name. Do NOT include their name.

${GLOBAL_BANS}
- Ground it in their sector, geography, deal size, or mandate
- Sound like someone who read about their firm briefly — not a compliment, not a pitch
- 1-2 sentences max, under 35 words
- No blinded company names, no fake deal
- Return only the observation`,
      `Narrative angle: ${narrativeAngle}

${ctx.promptBlock}
${ctx.icpBlock}

Our context (do not pitch directly): ${productDescription}
${attempt > 0 ? "Rewrite — previous observation felt generic or complimentary." : ""}`
    );

    const obsVal = validateObservationLine(observation, firstName);
    if (!obsVal.ok && attempt < MAX_RETRIES) continue;

    connectLine = await generateSection(
      `connect "${firstName}"`,
      `You write the closing sentence of the same cold email. It must follow naturally from the observation.

${GLOBAL_BANS}
- One sentence, casual and human
- Signal we have access to opportunities in this space and can connect/intro them with relevant companies
- Vague only — never claim we hold a specific account or live deal
- No teaser company profile
- Return only the connect line`,
      `Observation already written:
"${observation}"

Narrative angle: ${narrativeAngle}
Their portfolio focus: ${icp.portfolio_imagination}

Our offer: ${productDescription}
The connect line should close this specific thread — not a generic sign-off.
${attempt > 0 ? "Rewrite — previous connect line felt templated." : ""}`
    );

    const connectVal = validateConnectLine(connectLine);
    if (!connectVal.ok && attempt < MAX_RETRIES) continue;

    const html = assembleColdEmailHtmlNoTeaser(firstName, observation, connectLine);
    const emailVal = validateColdEmailHtmlNoTeaser(html, firstName);
    if (emailVal.ok || attempt === MAX_RETRIES) {
      return {
        company_name_normalized: companyNameNormalized,
        ma_service_type: maServiceType,
        icp,
        narrative_angle: narrativeAngle,
        observation,
        connect_line: connectLine,
        cold_email_html: html
      };
    }
  }

  const html = assembleColdEmailHtmlNoTeaser(
    firstName,
    observation,
    connectLine || "Happy to connect you with companies in this space if it's relevant."
  );
  return {
    company_name_normalized: companyNameNormalized,
    ma_service_type: maServiceType,
    icp,
    narrative_angle: narrativeAngle,
    observation,
    connect_line: connectLine,
    cold_email_html: html
  };
}

function cleanLine(text: string): string {
  return text
    .replace(/^["']|["']$/g, "")
    .replace(/^(observation|connect|narrative)\s*:\s*/i, "")
    .trim();
}
