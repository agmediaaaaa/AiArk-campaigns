import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";

import { cleanText } from "../functions/classifyMx.js";

export type EnrichedCacheEntry = {
  email: string;
  client_type: string;
  talent_type: string;
  domain_settings: string;
  email_source: string;
  first_name: string;
  last_name: string;
  company_name: string;
  linkedin: string;
  company_website: string;
  city: string;
  state: string;
};

export type RemovedCacheEntry = {
  reason: string;
  detail?: string;
  email: string;
  first_name: string;
  last_name: string;
  company_name: string;
  linkedin: string;
};

export type PriorCaches = {
  enriched: Map<string, EnrichedCacheEntry>;
  removed: Map<string, RemovedCacheEntry>;
  enrichedCount: number;
  removedCount: number;
};

export function lookupKeys(parts: {
  email?: string;
  linkedin?: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
}): string[] {
  const keys: string[] = [];
  const email = cleanText(parts.email).toLowerCase();
  if (email) keys.push(`email:${email}`);
  const linkedin = cleanText(parts.linkedin).toLowerCase();
  if (linkedin) keys.push(`linkedin:${linkedin}`);
  const name =
    `${cleanText(parts.firstName)}|${cleanText(parts.lastName)}|${cleanText(parts.companyName)}`.toLowerCase();
  if (name.replace(/\|/g, "")) keys.push(`name:${name}`);
  return keys;
}

function indexEntry<T>(map: Map<string, T>, keys: string[], value: T): void {
  for (const key of keys) map.set(key, value);
}

export function loadPriorCaches(dirs: string[]): PriorCaches {
  const enriched = new Map<string, EnrichedCacheEntry>();
  const removed = new Map<string, RemovedCacheEntry>();
  let enrichedCount = 0;
  let removedCount = 0;

  for (const dir of dirs) {
    const uploadedPath = path.join(dir, "uploaded_leads.csv");
    if (fs.existsSync(uploadedPath)) {
      const rows = parse(fs.readFileSync(uploadedPath, "utf-8"), {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true
      }) as Record<string, string>[];
      for (const r of rows) {
        if (String(r.upload_ok).toLowerCase() === "false") continue;
        const entry: EnrichedCacheEntry = {
          email: cleanText(r.email).toLowerCase(),
          client_type: cleanText(r.client_type),
          talent_type: cleanText(r.talent_type),
          domain_settings: cleanText(r.domain_settings),
          email_source: cleanText(r.email_source) || "csv",
          first_name: cleanText(r.first_name),
          last_name: cleanText(r.last_name),
          company_name: cleanText(r.company_name),
          linkedin: cleanText(r.linkedin),
          company_website: cleanText(r.company_website),
          city: cleanText(r.city),
          state: cleanText(r.state)
        };
        if (!entry.email) continue;
        enrichedCount++;
        indexEntry(
          enriched,
          lookupKeys({
            email: entry.email,
            linkedin: entry.linkedin,
            firstName: entry.first_name,
            lastName: entry.last_name,
            companyName: entry.company_name
          }),
          entry
        );
      }
    }

    const removedPath = path.join(dir, "removed_leads.csv");
    if (fs.existsSync(removedPath)) {
      const rows = parse(fs.readFileSync(removedPath, "utf-8"), {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true
      }) as Record<string, string>[];
      for (const r of rows) {
        const entry: RemovedCacheEntry = {
          reason: cleanText(r.reason) || "prior_removed",
          detail: cleanText(r.detail) || undefined,
          email: cleanText(r.email).toLowerCase(),
          first_name: cleanText(r.first_name),
          last_name: cleanText(r.last_name),
          company_name: cleanText(r.company_name),
          linkedin: cleanText(r.linkedin)
        };
        removedCount++;
        indexEntry(
          removed,
          lookupKeys({
            email: entry.email,
            linkedin: entry.linkedin,
            firstName: entry.first_name,
            lastName: entry.last_name,
            companyName: entry.company_name
          }),
          entry
        );
      }
    }
  }

  return { enriched, removed, enrichedCount, removedCount };
}

export function findEnriched(
  caches: PriorCaches,
  parts: {
    email?: string;
    linkedin?: string;
    firstName?: string;
    lastName?: string;
    companyName?: string;
  }
): EnrichedCacheEntry | undefined {
  for (const key of lookupKeys(parts)) {
    const hit = caches.enriched.get(key);
    if (hit) return hit;
  }
  return undefined;
}

export function findRemoved(
  caches: PriorCaches,
  parts: {
    email?: string;
    linkedin?: string;
    firstName?: string;
    lastName?: string;
    companyName?: string;
  }
): RemovedCacheEntry | undefined {
  for (const key of lookupKeys(parts)) {
    const hit = caches.removed.get(key);
    if (hit) return hit;
  }
  return undefined;
}
