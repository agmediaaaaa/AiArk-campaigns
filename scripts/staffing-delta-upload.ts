/**
 * Delta upload: fetch PlusVibe campaign leads, merge Google Sheet exports,
 * exclude existing campaign emails, enrich with new scripts, upload net-new.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { fetchCampaignLeads, resolveWorkspaceId } from "../integrations/plusvibe.js";
import { cleanText } from "../functions/classifyMx.js";

const DEFAULT_SHEETS = [
  "data/staffing_leads_full.csv",
  "data/staffing_leads_sheet2.csv",
  "data/staffing_leads_sheet3.csv"
];

type LeadRow = Record<string, string>;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function readLeadsCsv(p: string): LeadRow[] {
  return parse(fs.readFileSync(p, "utf-8"), {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_")),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  }) as LeadRow[];
}

function leadKey(row: LeadRow): string | null {
  const email = cleanText(row.email_business).toLowerCase();
  if (email) return `email:${email}`;
  const linkedin = cleanText(row.linkedin).toLowerCase();
  if (linkedin) return `linkedin:${linkedin}`;
  const name = `${cleanText(row.first_name)}|${cleanText(row.last_name)}|${cleanText(row.company_name)}`.toLowerCase();
  if (name.replace(/\|/g, "")) return `name:${name}`;
  return null;
}

async function main(): Promise<void> {
  const outDir = path.resolve(argValue("--out-dir") ?? `staffing_zs_delta_${Date.now()}`);
  const workspaceName = argValue("--workspace") ?? process.env.PLUSVIBE_WORKSPACE_NAME ?? "zs";
  const campaignId =
    argValue("--campaign") ?? process.env.STAFFING_CAMPAIGN_ID ?? "6a414d310cd53ac8421e1e91";
  const sheetsArg = argValue("--sheets");
  const sheets = sheetsArg ? sheetsArg.split(",").map((s) => s.trim()) : DEFAULT_SHEETS;
  const fetchOnly = hasFlag("--fetch-only");

  const workspaceId = await resolveWorkspaceId(workspaceName);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[delta] fetching PlusVibe leads workspace=${workspaceId} campaign=${campaignId}`);
  const campaignLeads = await fetchCampaignLeads({ workspaceId, campaignId });
  const campaignEmails = new Set(
    campaignLeads.map((l) => l.email?.trim().toLowerCase()).filter(Boolean) as string[]
  );

  fs.writeFileSync(
    path.join(outDir, "plusvibe_campaign_leads.json"),
    JSON.stringify({ count: campaignLeads.length, leads: campaignLeads }, null, 2)
  );
  fs.writeFileSync(
    path.join(outDir, "plusvibe_campaign_emails.csv"),
    stringify(
      campaignLeads.map((l) => ({
        email: l.email,
        first_name: l.first_name ?? "",
        last_name: l.last_name ?? "",
        company_name: l.company_name ?? "",
        status: l.status ?? ""
      })),
      { header: true }
    )
  );
  console.log(`[delta] PlusVibe campaign has ${campaignLeads.length} leads (${campaignEmails.size} unique emails)`);

  if (fetchOnly) {
    console.log(`[delta] fetch-only; artifacts in ${outDir}`);
    return;
  }

  const byKey = new Map<string, LeadRow>();
  const sheetStats: Array<{ file: string; rows: number; added: number }> = [];

  for (const sheet of sheets) {
    const p = path.resolve(sheet);
    if (!fs.existsSync(p)) {
      console.warn(`[delta] skip missing ${p}`);
      continue;
    }
    const rows = readLeadsCsv(p);
    let added = 0;
    for (const row of rows) {
      const key = leadKey(row);
      if (!key) continue;
      if (!byKey.has(key)) added++;
      byKey.set(key, { ...row, email_body: "" });
    }
    sheetStats.push({ file: sheet, rows: rows.length, added });
    console.log(`[delta] merged ${rows.length} rows from ${sheet} (+${added} new keys)`);
  }

  const merged = [...byKey.values()];
  const excluded: Array<{ reason: string; email: string; first_name: string; company_name: string }> = [];
  const netNew: LeadRow[] = [];

  for (const row of merged) {
    const email = cleanText(row.email_business).toLowerCase();
    if (email && campaignEmails.has(email)) {
      excluded.push({
        reason: "already_in_plusvibe",
        email,
        first_name: cleanText(row.first_name),
        company_name: cleanText(row.company_name)
      });
      continue;
    }
    netNew.push(row);
  }

  const netNewPath = path.join(outDir, "net_new_leads.csv");
  fs.writeFileSync(netNewPath, stringify(netNew, { header: true }));
  fs.writeFileSync(path.join(outDir, "excluded_already_in_plusvibe.csv"), stringify(excluded, { header: true }));
  fs.writeFileSync(
    path.join(outDir, "delta_summary.json"),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        workspace_id: workspaceId,
        campaign_id: campaignId,
        plusvibe_existing: campaignLeads.length,
        plusvibe_unique_emails: campaignEmails.size,
        sheets: sheetStats,
        merged_unique: merged.length,
        excluded_already_in_plusvibe: excluded.length,
        net_new: netNew.length,
        net_new_csv: netNewPath
      },
      null,
      2
    )
  );

  console.log(
    `[delta] merged=${merged.length} excluded=${excluded.length} net_new=${netNew.length} -> ${netNewPath}`
  );
  console.log(`[delta] run upload: npm run staffing-upload -- --input ${netNewPath} --out-dir ${outDir}/upload_run`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
