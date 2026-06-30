import { cleanText } from "./classifyMx.js";
import { normalizeDomainSetting } from "./normalizeDomainSetting.js";

export type DomainSetting = "SMTP" | "CatchAll";

export type CampaignTarget = { workspaceId: string; campaignId: string };

export type CampaignsConfig = {
  smtp: CampaignTarget;
  catchAll: CampaignTarget;
};

export type RouteResult =
  | { ok: true; setting: DomainSetting; target: CampaignTarget }
  | { ok: false; reason: "unknown_domain_setting"; rawValue: string };

export type RouteCampaignOptions = {
  /** When true, blank domain_settings routes to the SMTP campaign (TryKitt-discovered emails). */
  treatEmptyAsSmtp?: boolean;
};

export function routeCampaign(
  rawDomainSetting: unknown,
  config: CampaignsConfig,
  opts: RouteCampaignOptions = {}
): RouteResult {
  const raw = cleanText(rawDomainSetting);
  const mapped = normalizeDomainSetting(raw);
  if (mapped === "smtp") {
    return { ok: true, setting: "SMTP", target: config.smtp };
  }
  if (mapped === "catchall") {
    return { ok: true, setting: "CatchAll", target: config.catchAll };
  }
  if (mapped === "unknown" && opts.treatEmptyAsSmtp) {
    return { ok: true, setting: "SMTP", target: config.smtp };
  }
  return { ok: false, reason: "unknown_domain_setting", rawValue: raw };
}
