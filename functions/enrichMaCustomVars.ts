import { classifyMaServiceType } from "./classifyMaServiceType.js";
import { enrichMaIcp, type MaIcp } from "./enrichMaIcp.js";
import { quickNormalizeCompanyName } from "./enrichMaLeadFast.js";
import type { MaLeadInput } from "./buildMaLeadContext.js";

export type MaCustomVars = {
  company_name_normalized: string;
  ma_service_type: string;
  investment_focus: string;
  teaser: string;
  icp: string;
  icp_raw: MaIcp;
};

export function formatMaIcpSummary(icp: MaIcp): string {
  const parts: string[] = [];
  if (icp.target_industries.length) parts.push(`Industries: ${icp.target_industries.join("; ")}`);
  if (icp.deal_size_bands.length) parts.push(`Deal sizes: ${icp.deal_size_bands.join("; ")}`);
  if (icp.target_company_types.length) parts.push(`Company types: ${icp.target_company_types.join("; ")}`);
  if (icp.geographies.length) parts.push(`Geographies: ${icp.geographies.join("; ")}`);
  if (icp.deal_types.length) parts.push(`Deal types: ${icp.deal_types.join("; ")}`);
  if (icp.portfolio_imagination) parts.push(icp.portfolio_imagination);
  return parts.join(" | ");
}

export async function enrichMaCustomVars(input: MaLeadInput): Promise<MaCustomVars> {
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

  const investmentFocus =
    icp.portfolio_imagination ||
    [icp.target_industries[0], icp.deal_size_bands[0]].filter(Boolean).join(" — ") ||
    maServiceType;

  const teaser = icp.example_blinded_teaser || buildFallbackTeaser(icp);
  const icpSummary = formatMaIcpSummary(icp);

  return {
    company_name_normalized: companyNameNormalized,
    ma_service_type: maServiceType,
    investment_focus: investmentFocus,
    teaser,
    icp: icpSummary,
    icp_raw: icp
  };
}

function buildFallbackTeaser(icp: MaIcp): string {
  const ind = icp.target_industries[0];
  const type = icp.target_company_types[0];
  const size = icp.deal_size_bands[0];
  if (type && ind) return `${type} in ${ind}`;
  if (size && ind) return `${size} ${ind} company`;
  return "Founder-led niche platform business";
}
