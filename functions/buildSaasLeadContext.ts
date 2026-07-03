import { cleanText } from "./classifyMx.js";
import type { GtmClassification } from "./classifyGtmMotion.js";

export type SaasLeadInput = {
  first_name?: string;
  last_name?: string;
  title?: string;
  company_name?: string;
  company_name_normalized?: string;
  company_description?: string;
  company_products_services?: string;
  company_industry?: string;
  company_size?: string;
  city?: string;
  state?: string;
  country?: string;
  company_website?: string;
  company_linkedin?: string;
  gtm?: GtmClassification;
};

export function buildSaasLeadContext(input: SaasLeadInput): {
  firstName: string;
  promptBlock: string;
  gtmBlock: string;
} {
  const firstName = firstNameOnly(input.first_name);
  const lines = [
    `First name: ${firstName}`,
    `Title: ${cleanText(input.title) || "(unknown)"}`,
    `Company: ${cleanText(input.company_name_normalized || input.company_name) || "(unknown)"}`,
    `Industry: ${cleanText(input.company_industry) || "(unknown)"}`,
    `Size: ${cleanText(input.company_size) || "(unknown)"}`,
    `Location: ${[cleanText(input.city), cleanText(input.state), cleanText(input.country)].filter(Boolean).join(", ") || "(unknown)"}`,
    `Description: ${cleanText(input.company_description).slice(0, 450)}`,
    `Products: ${cleanText(input.company_products_services).slice(0, 250)}`,
    `Website: ${cleanText(input.company_website)}`
  ];
  const gtm = input.gtm;
  const gtmBlock = gtm
    ? `GTM motion: ${gtm.motion}
North star metric: ${gtm.north_star_metric}
Offer framing: ${gtm.offer_metric}
Scouted account list size: ${gtm.account_list_size}
Why: ${gtm.rationale}`
    : "";
  return { firstName, promptBlock: lines.join("\n"), gtmBlock };
}

function firstNameOnly(raw?: string): string {
  const name = cleanText(raw);
  if (!name) return "there";
  return name.split(/\s+/)[0]!.replace(/[^a-zA-Z'-]/g, "") || "there";
}
