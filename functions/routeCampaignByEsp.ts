import type { Esp } from "./classifyMx.js";

export type CampaignTarget = { workspaceId: string; campaignId: string };

export type EspCampaignsConfig = {
  googleAndOthers: CampaignTarget;
  outlook: CampaignTarget;
};

export type EspCampaignBucket = "google_and_others" | "outlook";

export type EspRouteResult =
  | { ok: true; bucket: EspCampaignBucket; target: CampaignTarget }
  | { ok: false; reason: "unknown_esp"; esp: string };

export function routeCampaignByEsp(esp: Esp, config: EspCampaignsConfig): EspRouteResult {
  if (esp === "outlook") {
    return { ok: true, bucket: "outlook", target: config.outlook };
  }
  if (esp === "google" || esp === "others" || esp === "empty") {
    return { ok: true, bucket: "google_and_others", target: config.googleAndOthers };
  }
  return { ok: false, reason: "unknown_esp", esp };
}
