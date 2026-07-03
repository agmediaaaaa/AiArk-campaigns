import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { classifyCompanyType } from "./classifyCompanyType.js";
import { classifyGtmMotion } from "./classifyGtmMotion.js";
import { buildSaasLeadContext, type SaasLeadInput } from "./buildSaasLeadContext.js";
import { quickNormalizeCompanyName } from "./enrichMaLeadFast.js";
import { assembleColdEmailHtml, validateColdEmailHtml, validateOpeningLine } from "./validateColdEmail.js";

export type SaasSequentialResult = {
  company_name_normalized: string;
  company_type: string;
  gtm_motion: string;
  north_star_metric: string;
  offer_metric: string;
  account_list_size: number;
  opening_line: string;
  offer_line: string;
  cta: string;
  cold_email_html: string;
};

const GLOBAL_BANS = `
Never use:
- "I noticed", "I saw", "Looks like you specialize in", "Your company is aligned with"
- Empty compliments ("impressive", "stands out", "unique approach")
- Restating what their product does as the opening
- Salutations besides the first name in the body
- Signatures
`;

const COPY_TEMP = 0.85;
const MAX_RETRIES = 2;

async function generateSection(label: string, system: string, user: string): Promise<string> {
  const openai = getOpenAI();
  const out = await withRetry(
    () =>
      openai.chat.completions.create({
        model: DEFAULT_CHAT_MODEL,
        temperature: COPY_TEMP,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      }),
    { label: `openai.${label}` }
  );
  return cleanLine(out.choices[0]?.message?.content ?? "");
}

function cleanLine(text: string): string {
  return text.replace(/^["']|["']$/g, "").trim();
}

export async function enrichSaasOutreachSequential(
  input: SaasLeadInput,
  productDescription: string
): Promise<SaasSequentialResult> {
  const companyNameNormalized = quickNormalizeCompanyName(
    input.company_name_normalized || input.company_name
  );
  const companyType = await classifyCompanyType({
    companyNameNormalized,
    companyDescription: input.company_description,
    companyProductsServices: input.company_products_services
  });
  const gtm = await classifyGtmMotion({
    companyName: companyNameNormalized,
    companyDescription: input.company_description,
    companyProductsServices: input.company_products_services,
    companyIndustry: input.company_industry,
    companySize: input.company_size,
    title: input.title
  });

  const ctx = buildSaasLeadContext({ ...input, company_name_normalized: companyNameNormalized, gtm });
  const firstName = ctx.firstName;

  let openingLine = "";
  let offerLine = "";
  let cta = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    openingLine = await generateSection(
      `saas-opening "${firstName}"`,
      `Write the opening line of a cold email to a B2B SaaS leader. It comes right after their first name.
${GLOBAL_BANS}
- Reference a market trend, buyer behavior shift, or industry observation — NOT their product
- Sound like one operator talking to another
- Under 22 words
- Return only the opening line`,
      `${ctx.promptBlock}

${ctx.gtmBlock}
${attempt > 0 ? "Rewrite — previous opening complimented or restated their product." : ""}`
    );

    const openingVal = validateOpeningLine(openingLine, firstName);
    if (!openingVal.ok && attempt < MAX_RETRIES) continue;

    offerLine = await generateSection(
      `saas-offer "${firstName}"`,
      `Write the value proposition line of the same cold email. It must build on the opening.
${GLOBAL_BANS}
- Align the promise to their revenue motion and north star metric
- Use this offer framing: ${gtm.offer_metric}
- Do not mention pilots, retainers, refunds, or how we make money
- One sentence, under 28 words
- Return only the offer line`,
      `Opening already written: "${openingLine}"

${ctx.promptBlock}
${ctx.gtmBlock}
Our service (context only): ${productDescription}
${attempt > 0 ? "Rewrite — offer did not match their GTM motion." : ""}`
    );

    cta = await generateSection(
      `saas-cta "${firstName}"`,
      `Write the closing CTA of the same cold email.
${GLOBAL_BANS}
- Offer a brief call to walk through how we target their ICP
- Include a free scouted account list of ${gtm.account_list_size} accounts matched to their buyer profile
- Do NOT claim leads are actively looking for their product
- One sentence, casual, under 30 words
- Return only the CTA`,
      `Opening: "${openingLine}"
Offer: "${offerLine}"
${ctx.gtmBlock}
${attempt > 0 ? "Rewrite — CTA felt templated or overpromised intent." : ""}`
    );

    const html = assembleColdEmailHtml(firstName, openingLine, offerLine, cta);
    const emailVal = validateColdEmailHtml(html, firstName);
    if (emailVal.ok || attempt === MAX_RETRIES) {
      return {
        company_name_normalized: companyNameNormalized,
        company_type: companyType,
        gtm_motion: gtm.motion,
        north_star_metric: gtm.north_star_metric,
        offer_metric: gtm.offer_metric,
        account_list_size: gtm.account_list_size,
        opening_line: openingLine,
        offer_line: offerLine,
        cta,
        cold_email_html: html
      };
    }
  }

  const html = assembleColdEmailHtml(firstName, openingLine, offerLine, cta);
  return {
    company_name_normalized: companyNameNormalized,
    company_type: companyType,
    gtm_motion: gtm.motion,
    north_star_metric: gtm.north_star_metric,
    offer_metric: gtm.offer_metric,
    account_list_size: gtm.account_list_size,
    opening_line: openingLine,
    offer_line: offerLine,
    cta,
    cold_email_html: html
  };
}
