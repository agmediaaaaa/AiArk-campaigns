import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { cleanText, domainFromWebsite } from "../functions/classifyMx.js";
import { withRetry } from "./openai.js";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (process.env.SKIP_SUPABASE === "true") return null;
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    return null;
  }
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return client;
}

export const SUPABASE_TABLE = process.env.SUPABASE_TABLE ?? "leads";

/** Row shape for Supabase table `Lead Database` (matches user column names). */
export type SupabaseLeadRow = {
  Email: string;
  "First Name"?: string | null;
  "Last Name"?: string | null;
  Linkedin?: string | null;
  "Company Name"?: string | null;
  Website?: string | null;
  Title?: string | null;
  "Facility Type"?: string | null;
  "Talent Type"?: string | null;
  "Cold Email"?: string | null;
  "Company LinkedIn"?: string | null;
  City?: string | null;
  State?: string | null;
  Country?: string | null;
};

export type SupabaseLookupInput = {
  firstName?: string;
  lastName?: string;
  companyName?: string;
  companyWebsite?: string;
  linkedin?: string;
};

function normalizeLinkedin(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");
}

/** Look up a verified email from Supabase before calling TryKitt. */
export async function lookupLeadEmail(input: SupabaseLookupInput): Promise<string | null> {
  const firstName = cleanText(input.firstName);
  const lastName = cleanText(input.lastName);
  const companyName = cleanText(input.companyName);
  const linkedin = cleanText(input.linkedin);
  const websiteDomain = domainFromWebsite(input.companyWebsite);

  if (!linkedin && !(firstName && lastName)) return null;

  const supabase = getSupabase();
  if (!supabase) return null;

  try {

    if (linkedin) {
      const norm = normalizeLinkedin(linkedin);
      const { data, error } = await supabase
        .from(SUPABASE_TABLE)
        .select("Email, Linkedin")
        .ilike("Linkedin", `%${norm.split("/").pop() ?? norm}%`)
        .limit(5);
      if (!error && data?.length) {
        const hit = data.find((row) => {
          const rowLi = cleanText((row as { Linkedin?: string }).Linkedin);
          return rowLi && normalizeLinkedin(rowLi) === norm;
        });
        const email = cleanText((hit ?? data[0])?.Email);
        if (email.includes("@")) return email.toLowerCase();
      }
    }

    if (firstName && lastName) {
      const { data, error } = await supabase
        .from(SUPABASE_TABLE)
        .select("Email, Website")
        .ilike("First Name", firstName)
        .ilike("Last Name", lastName)
        .limit(10);

      if (!error && data?.length) {
        let candidates = data as Array<{ Email?: string; Website?: string }>;
        if (companyName) {
          const { data: companyRows } = await supabase
            .from(SUPABASE_TABLE)
            .select("Email, Website")
            .ilike("First Name", firstName)
            .ilike("Last Name", lastName)
            .ilike("Company Name", `%${companyName.slice(0, 40)}%`)
            .limit(10);
          if (companyRows?.length) candidates = companyRows as typeof candidates;
        }

        const domainHit = websiteDomain
          ? candidates.find((row) => domainFromWebsite(row.Website) === websiteDomain)
          : undefined;
        const email = cleanText((domainHit ?? candidates[0])?.Email);
        if (email.includes("@")) return email.toLowerCase();
      }
    }
  } catch (err) {
    console.warn(`[supabase.lookupLeadEmail] ${(err as Error).message}`);
  }

  return null;
}

export type UpsertReport = {
  attempted: number;
  succeeded: number;
  failed: number;
  errors: Array<{ chunk: number; message: string }>;
};

export async function upsertLeads(
  rows: SupabaseLeadRow[],
  opts: { chunkSize?: number } = {}
): Promise<UpsertReport> {
  const chunkSize = opts.chunkSize ?? 500;
  const report: UpsertReport = { attempted: rows.length, succeeded: 0, failed: 0, errors: [] };
  if (rows.length === 0) return report;

  const supabase = getSupabase();
  if (!supabase) {
    console.warn("[supabase] skipped upsert: SUPABASE_URL/SUPABASE_KEY not configured");
    return report;
  }
  const onConflict = process.env.SUPABASE_ON_CONFLICT ?? "Email";
  const stamped = rows.map((r) => ({ ...r }));

  for (let i = 0; i < stamped.length; i += chunkSize) {
    const chunk = stamped.slice(i, i + chunkSize);
    const chunkIdx = Math.floor(i / chunkSize);
    try {
      await withRetry(
        async () => {
          const { error } = await supabase
            .from(SUPABASE_TABLE)
            .upsert(chunk, { onConflict, ignoreDuplicates: false });
          if (error) {
            const status = (error as { status?: number }).status;
            const wrapped: Error & { status?: number } = new Error(error.message);
            wrapped.status = status;
            throw wrapped;
          }
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
