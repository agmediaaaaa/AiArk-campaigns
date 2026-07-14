/**
 * Upload all leads from Google Sheet exports to Supabase "Lead Database".
 * Merges raw sheet rows (Sheet1/2/3) and enriches from GC run outputs when available.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { createClient } from "@supabase/supabase-js";

import { upsertLeads, type SupabaseLeadRow } from "../integrations/supabase.js";

type LeadRow = Record<string, string>;

const ROOT = process.cwd();

const DEFAULT_SHEET_FILES = [
  "data/leads.csv",
  "data/sheet2_leads.csv",
  "data/new_leads_sheet3.csv"
];

const DEFAULT_ENRICHED_SOURCES = [
  "run_outputs_gc_full",
  "run_outputs_gc_sheet2_v2",
  "run_outputs_gc_sheet2_v2_retry",
  "run_outputs_gc_newsheet3_v2"
];

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function clean(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  return s || null;
}

function readCsvRecords(filePath: string, normalizeHeaders = false): LeadRow[] {
  const text = fs.readFileSync(filePath, "utf-8");
  return parse(text, {
    columns: normalizeHeaders
      ? (header: string[]) => header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"))
      : true,
    skip_empty_lines: true,
    trim: true,
    bom: true
  }) as LeadRow[];
}

function uploadOk(value: string | undefined): boolean {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function mergeRow(target: SupabaseLeadRow, incoming: SupabaseLeadRow): SupabaseLeadRow {
  return {
    Email: target.Email,
    "First Name": incoming["First Name"] ?? target["First Name"],
    "Last Name": incoming["Last Name"] ?? target["Last Name"],
    Linkedin: incoming.Linkedin ?? target.Linkedin,
    "Company Name": incoming["Company Name"] ?? target["Company Name"],
    Website: incoming.Website ?? target.Website
  };
}

function fromRawSheetRow(row: LeadRow): SupabaseLeadRow | null {
  const email = clean(row.email_business ?? row["Email Business"]);
  if (!email) return null;
  return {
    Email: email,
    "First Name": clean(row.first_name ?? row["First Name"]),
    "Last Name": clean(row.last_name ?? row["Last Name"]),
    Linkedin: clean(row.linkedin ?? row["LinkedIn"]),
    "Company Name": clean(row.company_name ?? row["Company Name"]),
    Website: clean(row.company_website ?? row["Company Website"])
  };
}

function fromEnrichedRow(row: LeadRow): SupabaseLeadRow | null {
  if (!uploadOk(row.upload_ok)) return null;
  const email = clean(row.email);
  if (!email) return null;
  return {
    Email: email,
    "First Name": clean(row.first_name),
    "Last Name": clean(row.last_name),
    Linkedin: clean(row.linkedin),
    "Company Name": clean(row.company_name_normalized) ?? clean(row.company_name),
    Website: clean(row.company_website)
  };
}

function collectRows(): { rows: SupabaseLeadRow[]; stats: Record<string, number> } {
  const byEmail = new Map<string, SupabaseLeadRow>();
  const stats: Record<string, number> = {
    raw_rows_seen: 0,
    raw_rows_with_email: 0,
    enriched_rows_seen: 0,
    enriched_rows_with_email: 0
  };

  const sheetFiles =
    argValue("--sheets")?.split(",").map((s) => s.trim()).filter(Boolean) ?? DEFAULT_SHEET_FILES;

  for (const rel of sheetFiles) {
    const filePath = path.join(ROOT, rel);
    if (!fs.existsSync(filePath)) {
      console.warn(`[supabase-upload] skip missing sheet ${filePath}`);
      continue;
    }
    const records = readCsvRecords(filePath, true);
    stats.raw_rows_seen += records.length;
    for (const record of records) {
      const row = fromRawSheetRow(record);
      if (!row) continue;
      stats.raw_rows_with_email++;
      const key = row.Email.toLowerCase();
      const existing = byEmail.get(key);
      byEmail.set(key, existing ? mergeRow(existing, row) : row);
    }
  }

  const enrichedSources =
    argValue("--enriched-sources")?.split(",").map((s) => s.trim()).filter(Boolean) ??
    DEFAULT_ENRICHED_SOURCES;

  for (const dir of enrichedSources) {
    const csvPath = path.join(ROOT, dir, "enriched_leads.csv");
    if (!fs.existsSync(csvPath)) {
      console.warn(`[supabase-upload] skip missing enriched ${csvPath}`);
      continue;
    }
    const records = readCsvRecords(csvPath, false);
    stats.enriched_rows_seen += records.length;
    for (const record of records) {
      const row = fromEnrichedRow(record);
      if (!row) continue;
      stats.enriched_rows_with_email++;
      const key = row.Email.toLowerCase();
      const existing = byEmail.get(key);
      byEmail.set(key, existing ? mergeRow(existing, row) : row);
    }
  }

  return { rows: [...byEmail.values()], stats };
}

async function uploadViaRpc(rows: SupabaseLeadRow[]): Promise<{
  ok: boolean;
  inserted: number;
  updated: number;
  error?: string;
}> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    return { ok: false, inserted: 0, updated: 0, error: "SUPABASE_URL/SUPABASE_KEY missing" };
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const batchSize = Number(process.env.SUPABASE_RPC_BATCH_SIZE ?? "50");
  let inserted = 0;
  let updated = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const payload = rows.slice(i, i + batchSize);
    const { data, error } = await supabase.rpc("upsert_lead_database_rows", { payload });
    if (error) {
      return { ok: false, inserted, updated, error: error.message };
    }
    const result = data as { inserted?: number; updated?: number };
    inserted += Number(result?.inserted ?? 0);
    updated += Number(result?.updated ?? 0);
  }

  return { ok: true, inserted, updated };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;

  if (!dryRun && (!url || !key)) {
    throw new Error("SUPABASE_URL and SUPABASE_KEY are required in .env");
  }

  if (!process.env.SUPABASE_TABLE) {
    process.env.SUPABASE_TABLE = "Lead Database";
  }

  const { rows, stats } = collectRows();

  const outDir = path.join(ROOT, "outputs", process.env.SUPABASE_BATCH_OUT ?? "supabase_all_sheets");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "all_leads.json"), JSON.stringify(rows, null, 2));

  console.log(
    JSON.stringify(
      {
        ...stats,
        unique_rows: rows.length,
        dry_run: dryRun,
        table: process.env.SUPABASE_TABLE
      },
      null,
      2
    )
  );

  if (dryRun) return;

  const useRpc = String(process.env.SUPABASE_USE_RPC ?? "true").toLowerCase() !== "false";
  if (useRpc) {
    const rpc = await uploadViaRpc(rows);
    if (rpc.ok) {
      console.log(
        JSON.stringify(
          {
            method: "rpc",
            inserted: rpc.inserted,
            updated: rpc.updated,
            total_upserted: rpc.inserted + rpc.updated
          },
          null,
          2
        )
      );
      return;
    }
    console.warn(`[supabase-upload] RPC failed, falling back to table upsert: ${rpc.error}`);
  }

  const report = await upsertLeads(rows);
  console.log(
    JSON.stringify(
      {
        method: "table_upsert",
        attempted: report.attempted,
        succeeded: report.succeeded,
        failed: report.failed,
        errors: report.errors.slice(0, 5)
      },
      null,
      2
    )
  );

  if (report.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
