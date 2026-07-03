import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { upsertLeads, type SupabaseLeadRow } from "../integrations/supabase.js";

const shards = [0, 1, 2, 3, 4, 5].map((n) => `run_outputs_20260703_101303_shard${n}`);
const byEmail = new Map<string, SupabaseLeadRow>();

function clean(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  return s || null;
}

for (const dir of shards) {
  const csvPath = path.join(process.cwd(), dir, "enriched_leads.csv");
  const records = parse(fs.readFileSync(csvPath, "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    bom: true
  }) as Record<string, string>[];
  for (const r of records) {
    const email = clean(r.email)?.toLowerCase();
    if (!email) continue;
    byEmail.set(email, {
      Email: email,
      "First Name": clean(r.first_name),
      "Last Name": clean(r.last_name),
      Linkedin: clean(r.linkedin),
      "Company Name": clean(r.company_name_normalized) ?? clean(r.company_name),
      Website: clean(r.company_website)
    });
  }
}

const rows = [...byEmail.values()];
console.log(`[backfill] upserting ${rows.length} unique enriched leads`);
const report = await upsertLeads(rows, { chunkSize: 50 });
console.log(JSON.stringify(report, null, 2));
