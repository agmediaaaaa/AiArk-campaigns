/**
 * Backfill ZS Lead Database from staffing uploaded_leads.csv artifacts.
 * Dedupes by email (later files win). Only rows with upload_ok=true are upserted.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";

import { upsertLeads, type SupabaseLeadRow } from "../integrations/supabase.js";

const DEFAULT_DIRS = [
  "staffing_zs_full_run_tk",
  "staffing_zs_sheet2_run_tk",
  "staffing_zs_sheet3_run_tk"
];

type UploadedRow = {
  first_name: string;
  last_name: string;
  email: string;
  company_name: string;
  linkedin: string;
  company_website: string;
  upload_ok: string;
};

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function toSupabaseRow(row: UploadedRow): SupabaseLeadRow {
  return {
    Email: row.email.trim(),
    "First Name": row.first_name?.trim() || null,
    "Last Name": row.last_name?.trim() || null,
    Linkedin: row.linkedin?.trim() || null,
    "Company Name": row.company_name?.trim() || null,
    Website: row.company_website?.trim() || null
  };
}

async function main(): Promise<void> {
  const dirsArg = argValue("--dirs");
  const dirs = dirsArg ? dirsArg.split(",").map((d) => d.trim()).filter(Boolean) : DEFAULT_DIRS;
  const dryRun = hasFlag("--dry-run");

  if (!process.env.SUPABASE_TABLE) process.env.SUPABASE_TABLE = "Lead Database";

  const missing = ["SUPABASE_URL", "SUPABASE_KEY"].filter((k) => !process.env[k]);
  if (!dryRun && missing.length) {
    throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }

  const byEmail = new Map<string, SupabaseLeadRow>();
  let filesRead = 0;
  let rowsSeen = 0;
  let rowsSkipped = 0;

  for (const dir of dirs) {
    const csvPath = path.resolve(dir, "uploaded_leads.csv");
    if (!fs.existsSync(csvPath)) {
      console.warn(`[backfill] skip missing ${csvPath}`);
      continue;
    }
    filesRead++;
    const records = parse(fs.readFileSync(csvPath, "utf-8"), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true
    }) as UploadedRow[];

    for (const row of records) {
      rowsSeen++;
      if (String(row.upload_ok).toLowerCase() !== "true") {
        rowsSkipped++;
        continue;
      }
      const email = row.email?.trim();
      if (!email) {
        rowsSkipped++;
        continue;
      }
      byEmail.set(email.toLowerCase(), toSupabaseRow(row));
    }
    console.log(`[backfill] read ${records.length} rows from ${csvPath}`);
  }

  const rows = [...byEmail.values()];
  console.log(
    `[backfill] files=${filesRead} seen=${rowsSeen} skipped=${rowsSkipped} unique=${rows.length} table=${process.env.SUPABASE_TABLE}`
  );

  if (dryRun) {
    console.log(JSON.stringify({ dry_run: true, unique_rows: rows.length, sample: rows.slice(0, 3) }, null, 2));
    return;
  }

  const report = await upsertLeads(rows);
  console.log(
    JSON.stringify(
      {
        attempted: report.attempted,
        succeeded: report.succeeded,
        failed: report.failed,
        errors: report.errors
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
