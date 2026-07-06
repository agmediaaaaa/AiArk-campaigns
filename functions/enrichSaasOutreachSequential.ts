import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { classifyCompanyType } from "./classifyCompanyType.js";
import { classifyGtmMotion } from "./classifyGtmMotion.js";
import { buildSaasLeadContext, type SaasLeadInput } from "./buildSaasLeadContext.js";
import { quickNormalizeCompanyName } from "./enrichMaLeadFast.js";
import {
  assembleSaasColdEmailHtml,
  validateSaasColdEmailHtml,
  validateSaasColdEmailParts
} from "./validateColdEmail.js";
import { humanizeSaasColdEmail } from "./humanizeSaasColdEmail.js";
import { buildCtaTemplate, buildValueLineTemplate, gtmOutreachFrame } from "./gtmOutreachFraming.js";

export type SaasSequentialResult = {
  company_name_normalized: string;
  company_type: string;
  gtm_motion: string;
  north_star_metric: string;
  offer_metric: string;
  account_list_size: number;
  opening_line: string;
  value_line: string;
  offer_line: string;
  cta: string;
  cold_email_html: string;
};

const GLOBAL_BANS = `
Never use:
- "I noticed", "I saw", "Looks like you specialize in", "Your company is aligned with"
- "specialize", "specialized", "specializing"
- Empty compliments ("impressive", "stands out", "unique approach", "innovative")
- Restating what their product does as the opening
- Salutations besides the first name in the body
- Signatures
- Claiming leads are actively looking for their product
`;

const COPY_TEMP = 0.7;
const MAX_RETRIES = 2;

async function generateDraft(
  firstName: string,
  companyName: string,
  ctx: ReturnType<typeof buildSaasLeadContext>,
  frame: ReturnType<typeof gtmOutreachFrame>,
  accountListSize: number,
  attempt: number
): Promise<{ opening_line: string; value_line: string; cta: string }> {
  const openai = getOpenAI();
  const valueTemplate = buildValueLineTemplate(frame, "qualified buyers in their market");
  const ctaTemplate = buildCtaTemplate(frame, companyName, accountListSize);

  const prompt = `Write a 3-part cold email for a B2B SaaS leader. Return strict JSON only:
{
  "opening_line": "market/buyer insight — NOT about their product",
  "value_line": "We can connect you with [outcome]. [performance-basis sentence]",
  "cta": "quick call ask + ${accountListSize} flagged accounts for ${companyName}"
}

${GLOBAL_BANS}

Approved style examples:
- Opening: buyer/market pressure insight in their industry (1-2 sentences, conversational)
- Value line must start with "We can connect you with" and include performance-basis pay model
- CTA must ask for a quick call and reference ${accountListSize} high-value accounts our system flagged

Target connect outcome: ${frame.connectOutcome}
Performance model hint: ${frame.performanceLine}
CTA pattern hint: ${ctaTemplate}
Buyer context: ${frame.buyerPersonaHint}

${ctx.promptBlock}
${ctx.gtmBlock}
${attempt > 0 ? "Rewrite — previous draft was robotic, off-template, or failed validation." : ""}`;

  const out = await withRetry(
    () =>
      openai.chat.completions.create({
        model: DEFAULT_CHAT_MODEL,
        temperature: COPY_TEMP,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Return only valid JSON with opening_line, value_line, cta." },
          { role: "user", content: prompt }
        ]
      }),
    { label: `openai.saas-draft "${firstName}"` }
  );

  try {
    const obj = JSON.parse(out.choices[0]?.message?.content ?? "{}") as Record<string, string>;
    let valueLine = String(obj.value_line ?? "").trim();
    if (!/^we can connect you with/i.test(valueLine)) {
      valueLine = valueTemplate;
    }
    let cta = String(obj.cta ?? "").trim();
    if (!/\b\d+\b/.test(cta)) {
      cta = ctaTemplate;
    }
    return {
      opening_line: String(obj.opening_line ?? "").trim(),
      value_line: valueLine,
      cta
    };
  } catch {
    return {
      opening_line: "",
      value_line: valueTemplate,
      cta: ctaTemplate
    };
  }
}

export async function enrichSaasOutreachSequential(
  input: SaasLeadInput,
  productDescription: string
): Promise<SaasSequentialResult> {
  void productDescription;
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
  const frame = gtmOutreachFrame(gtm.motion, gtm.account_list_size);

  let openingLine = "";
  let valueLine = "";
  let cta = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const draft = await generateDraft(
      firstName,
      companyNameNormalized,
      ctx,
      frame,
      gtm.account_list_size,
      attempt
    );

    const humanized = await humanizeSaasColdEmail(draft, {
      firstName,
      companyName: companyNameNormalized,
      accountListSize: gtm.account_list_size
    });

    openingLine = humanized.opening_line;
    valueLine = humanized.value_line;
    cta = humanized.cta;

    const partsVal = validateSaasColdEmailParts(openingLine, valueLine, cta, firstName, gtm.account_list_size);
    const html = assembleSaasColdEmailHtml(firstName, openingLine, valueLine, cta);
    const emailVal = validateSaasColdEmailHtml(html, firstName);

    if ((partsVal.ok && emailVal.ok) || attempt === MAX_RETRIES) {
      return buildResult({
        companyNameNormalized,
        companyType,
        gtm,
        openingLine,
        valueLine,
        cta,
        html
      });
    }
  }

  const html = assembleSaasColdEmailHtml(firstName, openingLine, valueLine, cta);
  return buildResult({
    companyNameNormalized,
    companyType,
    gtm,
    openingLine,
    valueLine,
    cta,
    html
  });
}

function buildResult(args: {
  companyNameNormalized: string;
  companyType: string;
  gtm: Awaited<ReturnType<typeof classifyGtmMotion>>;
  openingLine: string;
  valueLine: string;
  cta: string;
  html: string;
}): SaasSequentialResult {
  return {
    company_name_normalized: args.companyNameNormalized,
    company_type: args.companyType,
    gtm_motion: args.gtm.motion,
    north_star_metric: args.gtm.north_star_metric,
    offer_metric: args.gtm.offer_metric,
    account_list_size: args.gtm.account_list_size,
    opening_line: args.openingLine,
    value_line: args.valueLine,
    offer_line: args.valueLine,
    cta: args.cta,
    cold_email_html: args.html
  };
}
