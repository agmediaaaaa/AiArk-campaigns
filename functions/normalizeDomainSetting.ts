import { cleanText } from "./classifyMx.js";

export type NormalizedDomainSetting = "smtp" | "catchall" | "unknown";

/** Map sheet values like SMTP_VALID / CATCH_ALL_VALID to pipeline routing labels. */
export function normalizeDomainSetting(raw: unknown): NormalizedDomainSetting {
  const norm = cleanText(raw).toLowerCase().replace(/[^a-z]/g, "");
  if (!norm) return "unknown";
  if (norm.includes("catchall")) return "catchall";
  if (norm.includes("smtp")) return "smtp";
  return "unknown";
}

export function isCatchAllDomainSetting(raw: unknown): boolean {
  return normalizeDomainSetting(raw) === "catchall";
}

export function isSmtpDomainSetting(raw: unknown): boolean {
  return normalizeDomainSetting(raw) === "smtp";
}
