import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { cleanText } from "../functions/classifyMx.js";
import { uploadLeadsBatch, type PlusVibeLeadPayload } from "../integrations/plusvibe.js";

const SHARDS = [0, 1, 2, 3, 4, 5].map((n) => `run_outputs_20260703_101303_shard${n}`);
const WORKSPACE_ID = process.env.PLUSVIBE_WORKSPACE_ID ?? "69a5b2169433a45c6f6d7d1c";
const CAMPAIGN_ID = process.env.PLUSVIBE_CAMPAIGN_ID ?? "6a47850365fa564829fbcb53";
const BATCH_SIZE = Number(process.env.PLUSVIBE_BATCH_SIZE) || 25;
const BATCH_DELAY_MS = Number(process.env.PLUSVIBE_BATCH_DELAY_MS) || 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPayload(row: Record<string, string>): PlusVibeLeadPayload | null {
  const email = cleanText(row.email)?.toLowerCase();
  if (!email) return null;
  return {
    email,
    first_name: cleanText(row.first_name) || undefined,
    last_name: cleanText(row.last_name) || undefined,
    company_name: cleanText(row.company_name_normalized) || cleanText(row.company_name) || undefined,
    company_website: cleanText(row.company_website) || undefined,
    linkedin_person_url: cleanText(row.linkedin) || undefined,
    linkedin_company_url: cleanText(row.company_linkedin) || undefined,
    city: cleanText(row.city) || undefined,
    country: cleanText(row.country) || undefined,
    custom_variables: {
      custom_talent_type: cleanText(row.talent_type) || "",
      custom_facility_type: cleanText(row.facility_type) || ""
    }
  };
}

async function main(): Promise<void> {
  const byEmail = new Map<string, PlusVibeLeadPayload>();
  for (const dir of SHARDS) {
    const csvPath = path.join(process.cwd(), dir, "enriched_leads.csv");
    if (!fs.existsSync(csvPath)) {
      console.warn(`[retry-upload] skip missing ${csvPath}`);
      continue;
    }
    const records = parse(fs.readFileSync(csvPath, "utf-8"), {
      columns: true,
      skip_empty_lines: true,
      bom: true
    }) as Record<string, string>[];
    for (const row of records) {
      const payload = toPayload(row);
      if (payload) byEmail.set(payload.email, payload);
    }
  }

  const leads = [...byEmail.values()];
  console.log(
    `[retry-upload] uploading ${leads.length} leads to campaign ${CAMPAIGN_ID} (batch=${BATCH_SIZE})`
  );

  const target = { workspaceId: WORKSPACE_ID, campaignId: CAMPAIGN_ID };
  let uploaded = 0;
  let failed = 0;
  const errors: Array<{ batch: number; error: string; emails: string[] }> = [];

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batchIdx = Math.floor(i / BATCH_SIZE);
    const chunk = leads.slice(i, i + BATCH_SIZE);
    const result = await uploadLeadsBatch(chunk, target, { isOverwrite: true });
    if (result.ok) {
      uploaded += result.count;
      console.log(`[retry-upload] batch ${batchIdx + 1}: ok (${result.count}) total=${uploaded}`);
    } else {
      failed += chunk.length;
      errors.push({
        batch: batchIdx,
        error: result.error,
        emails: chunk.map((l) => l.email)
      });
      console.error(`[retry-upload] batch ${batchIdx + 1}: failed ${result.error}`);
    }
    if (i + BATCH_SIZE < leads.length) await sleep(BATCH_DELAY_MS);
  }

  const outDir = path.join(process.cwd(), "zs_ma_plusvibe_retry");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "upload_summary.json"),
    JSON.stringify(
      {
        workspace_id: WORKSPACE_ID,
        campaign_id: CAMPAIGN_ID,
        attempted: leads.length,
        uploaded,
        failed,
        errors
      },
      null,
      2
    )
  );
  if (errors.length > 0) {
    fs.writeFileSync(
      path.join(outDir, "upload_errors.json"),
      JSON.stringify(errors, null, 2)
    );
  }
  console.log(`[retry-upload] done uploaded=${uploaded} failed=${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
