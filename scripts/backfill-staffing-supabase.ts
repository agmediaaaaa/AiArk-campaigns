/**
 * Backfill ZS Lead Database from staffing uploaded_leads.csv artifacts
 * and optionally PlusVibe campaign leads. Dedupes by email (later sources win).
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";

import {
  fetchCampaignLeads,
  resolveWorkspaceId,
  type PlusVibeCampaignLead
} from "../integrations/plusvibe.js";
import { upsertLeads, type SupabaseLeadRow } from "../integrations/supabase.js";
import { sleep } from "../integrations/openai.js";

const LEGACY_DIRS = [
  "staffing_zs_full_run_tk",
  "staffing_zs_sheet2_run_tk",
  "staffing_zs_sheet3_run_tk",
  "staffing_zs_delta_run/upload_run",
  "staffing_zs_sheet4_run"
];

const DEFAULT_CAMPAIGNS = [
  "6a414d310cd53ac8421e1e91",
  "6a4b5e9a8551c2fad96fa22b",
  "6a4e04fdfd24ec03d6bec6c0"
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

function discoverRunDirs(root = process.cwd()): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("staffing_"))
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(root, name, "uploaded_leads.csv")))
    .sort();
}

function resolveDirs(): string[] {
  const dirsArg = argValue("--dirs");
  if (dirsArg) return dirsArg.split(",").map((d) => d.trim()).filter(Boolean);
  if (hasFlag("--legacy-only")) return LEGACY_DIRS;
  const discovered = discoverRunDirs();
  const merged = [...new Set([...LEGACY_DIRS, ...discovered])];
  return merged;
}

function toSupabaseRowFromCsv(row: UploadedRow): SupabaseLeadRow {
  return {
    Email: row.email.trim(),
    "First Name": row.first_name?.trim() || null,
    "Last Name": row.last_name?.trim() || null,
    Linkedin: row.linkedin?.trim() || null,
    "Company Name": row.company_name?.trim() || null,
    Website: row.company_website?.trim() || null
  };
}

function toSupabaseRowFromPlusVibe(lead: PlusVibeCampaignLead): SupabaseLeadRow {
  return {
    Email: lead.email.trim(),
    "First Name": lead.first_name?.trim() || null,
    "Last Name": lead.last_name?.trim() || null,
    Linkedin: lead.linkedin_person_url?.trim() || null,
    "Company Name": lead.company_name?.trim() || null,
    Website: lead.company_website?.trim() || null
  };
}

function ingestCsvDir(dir: string, byEmail: Map<string, SupabaseLeadRow>): { filesRead: number; rowsSeen: number; rowsSkipped: number } {
  const csvPath = path.resolve(dir, "uploaded_leads.csv");
  if (!fs.existsSync(csvPath)) {
    console.warn(`[backfill] skip missing ${csvPath}`);
    return { filesRead: 0, rowsSeen: 0, rowsSkipped: 0 };
  }

  const records = parse(fs.readFileSync(csvPath, "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true
  }) as UploadedRow[];

  let rowsSkipped = 0;
  for (const row of records) {
    if (String(row.upload_ok).toLowerCase() !== "true") {
      rowsSkipped++;
      continue;
    }
    const email = row.email?.trim();
    if (!email) {
      rowsSkipped++;
      continue;
    }
    byEmail.set(email.toLowerCase(), toSupabaseRowFromCsv(row));
  }
  console.log(`[backfill] read ${records.length} rows from ${csvPath}`);
  return { filesRead: 1, rowsSeen: records.length, rowsSkipped };
}

async function ingestPlusVibeCampaigns(
  campaignIds: string[],
  byEmail: Map<string, SupabaseLeadRow>
): Promise<number> {
  const workspaceId = await resolveWorkspaceId();
  let total = 0;
  for (const campaignId of campaignIds) {
    console.log(`[backfill] fetching PlusVibe campaign ${campaignId}`);
    const leads = await fetchCampaignLeads(
      { workspaceId, campaignId },
      { pageSize: 50, delayMs: 900 }
    );
    let added = 0;
    for (const lead of leads) {
      const email = lead.email?.trim();
      if (!email) continue;
      byEmail.set(email.toLowerCase(), toSupabaseRowFromPlusVibe(lead));
      added++;
    }
    total += added;
    console.log(`[backfill] plusvibe campaign ${campaignId}: ${leads.length} leads (${added} with email)`);
    await sleep(8000);
  }
  return total;
}

async function main(): Promise<void> {
  const dirs = resolveDirs();
  const dryRun = hasFlag("--dry-run");
  const skipPlusVibe = hasFlag("--skip-plusvibe");
  const campaignsArg = argValue("--plusvibe-campaigns");
  const campaignIds = campaignsArg
    ? campaignsArg.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_CAMPAIGNS;

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
    const stats = ingestCsvDir(dir, byEmail);
    filesRead += stats.filesRead;
    rowsSeen += stats.rowsSeen;
    rowsSkipped += stats.rowsSkipped;
  }

  let plusVibeCount = 0;
  if (!skipPlusVibe) {
    plusVibeCount = await ingestPlusVibeCampaigns(campaignIds, byEmail);
  }

  const rows = [...byEmail.values()];
  console.log(
    `[backfill] dirs=${dirs.length} files=${filesRead} csv_seen=${rowsSeen} csv_skipped=${rowsSkipped} plusvibe=${plusVibeCount} unique=${rows.length} table=${process.env.SUPABASE_TABLE}`
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
