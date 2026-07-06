import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { withRetry } from "./openai.js";
import { cleanText, domainFromWebsite } from "../functions/classifyMx.js";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL/SUPABASE_KEY not set; the startup gate should have caught this.");
  }
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return client;
}

export const SUPABASE_TABLE = process.env.SUPABASE_TABLE ?? "Lead Database";

/** Row shape for Supabase table `Lead Database` (matches user column names). */
export type SupabaseLeadRow = {
  Email: string;
  "First Name"?: string | null;
  "Last Name"?: string | null;
  Linkedin?: string | null;
  "Company Name"?: string | null;
  Website?: string | null;
};

export type UpsertReport = {
  attempted: number;
  succeeded: number;
  failed: number;
  errors: Array<{ chunk: number; message: string }>;
};

export type SupabaseLookupItem = {
  key: string | number;
  linkedin?: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
};

function normalizeLinkedin(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, "");
}

function nameCompanyKey(firstName: string, lastName: string, companyName: string): string {
  return [firstName, lastName, companyName]
    .map((v) => cleanText(v).toLowerCase())
    .join("|");
}

/**
 * Look up existing emails in Lead Database before calling TryKitt.
 * Match priority: LinkedIn URL, then First+Last+Company.
 */
export async function lookupEmailsFromDatabase(
  items: SupabaseLookupItem[]
): Promise<Map<string | number, string>> {
  const out = new Map<string | number, string>();
  if (items.length === 0) return out;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) return out;

  const supabase = getSupabase();
  const table = SUPABASE_TABLE;

  const linkedinItems = items
    .map((item) => ({ ...item, linkedin: cleanText(item.linkedin) }))
    .filter((item) => item.linkedin);

  const linkedinUrls = [...new Set(linkedinItems.map((item) => item.linkedin!))];
  const chunkSize = 100;

  for (let i = 0; i < linkedinUrls.length; i += chunkSize) {
    const chunk = linkedinUrls.slice(i, i + chunkSize);
    try {
      const { data, error } = await supabase
        .from(table)
        .select('Email, Linkedin')
        .in("Linkedin", chunk);
      if (error) throw error;
      const byLinkedin = new Map<string, string>();
      for (const row of data ?? []) {
        const email = cleanText((row as { Email?: string }).Email).toLowerCase();
        const linkedin = cleanText((row as { Linkedin?: string }).Linkedin);
        if (!email || !linkedin) continue;
        byLinkedin.set(normalizeLinkedin(linkedin), email);
      }
      for (const item of linkedinItems) {
        const email = byLinkedin.get(normalizeLinkedin(item.linkedin!));
        if (email) out.set(item.key, email);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[supabase] linkedin lookup chunk failed: ${message}`);
    }
  }

  const remaining = items.filter((item) => !out.has(item.key));
  const nameItems = remaining.filter(
    (item) => cleanText(item.firstName) && cleanText(item.lastName) && cleanText(item.companyName)
  );

  for (const item of nameItems) {
    const firstName = cleanText(item.firstName);
    const lastName = cleanText(item.lastName);
    const companyName = cleanText(item.companyName);
    try {
      const { data, error } = await supabase
        .from(table)
        .select('Email, "First Name", "Last Name", "Company Name"')
        .ilike("First Name", firstName)
        .ilike("Last Name", lastName)
        .ilike("Company Name", companyName)
        .limit(5);
      if (error) throw error;
      for (const row of data ?? []) {
        const email = cleanText((row as { Email?: string }).Email).toLowerCase();
        if (!email) continue;
        const rowKey = nameCompanyKey(
          (row as { "First Name"?: string })["First Name"] ?? "",
          (row as { "Last Name"?: string })["Last Name"] ?? "",
          (row as { "Company Name"?: string })["Company Name"] ?? ""
        );
        if (rowKey === nameCompanyKey(firstName, lastName, companyName)) {
          out.set(item.key, email);
          break;
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[supabase] name lookup failed for ${firstName} ${lastName}: ${message}`);
    }
  }

  return out;
}

export type SingleLookupInput = {
  firstName?: string;
  lastName?: string;
  companyName?: string;
  linkedin?: string;
  companyWebsite?: string;
};

/** Single-lead lookup before TryKitt (LinkedIn first, then name+company). */
export async function lookupLeadEmail(input: SingleLookupInput): Promise<string | null> {
  const firstName = cleanText(input.firstName);
  const lastName = cleanText(input.lastName);
  const companyName = cleanText(input.companyName);
  const linkedin = cleanText(input.linkedin);
  if (!linkedin && !(firstName && lastName)) return null;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) return null;

  const hits = await lookupEmailsFromDatabase([
    {
      key: 0,
      linkedin,
      firstName,
      lastName,
      companyName
    }
  ]);
  return hits.get(0) ?? null;
}

export async function upsertLeads(
  rows: SupabaseLeadRow[],
  opts: { chunkSize?: number } = {}
): Promise<UpsertReport> {
  const chunkSize = opts.chunkSize ?? 50;
  const report: UpsertReport = { attempted: rows.length, succeeded: 0, failed: 0, errors: [] };
  if (rows.length === 0) return report;

  const supabase = getSupabase();
  const useRpc =
    process.env.SUPABASE_USE_RPC !== "false" &&
    (SUPABASE_TABLE === "Lead Database" || process.env.SUPABASE_USE_RPC === "true");

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const chunkIdx = Math.floor(i / chunkSize);
    try {
      await withRetry(
        async () => {
          if (useRpc) {
            const { error } = await supabase.rpc("upsert_lead_database_rows", { payload: chunk });
            if (error) throw new Error(error.message);
            return;
          }
          const onConflict = process.env.SUPABASE_ON_CONFLICT ?? "Email";
          const { error } = await supabase
            .from(SUPABASE_TABLE)
            .upsert(chunk, { onConflict, ignoreDuplicates: false });
          if (error) throw new Error(error.message);
        },
        { label: `supabase.upsert chunk=${chunkIdx}` }
      );
      report.succeeded += chunk.length;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      report.failed += chunk.length;
      report.errors.push({ chunk: chunkIdx, message });
      console.error(`[supabase] chunk ${chunkIdx} failed: ${message}`);
    }
  }
  return report;
}
