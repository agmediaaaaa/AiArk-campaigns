/**
 * Replace Step 1 variants on Google + Outlook staffing campaigns
 * with variable-based SOP framework scripts.
 */
import "dotenv/config";
import fs from "node:fs";
import axios from "axios";
import { parse } from "csv-parse/sync";
import { getStep1SequencePayload, STAFFING_STEP1_SCRIPTS } from "../functions/staffingStep1Scripts.js";
import { mapPool } from "../functions/mapPool.js";

const WS = process.env.PLUSVIBE_WORKSPACE_ID ?? "69a5b2169433a45c6f6d7d1c";
const GOOGLE = "6a689fbfa31a315ac8162d86";
const OUTLOOK = "6a689fd6dbf8557e58f1f312";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

const client = axios.create({
  baseURL: process.env.PLUSVIBE_BASE_URL ?? "https://api.plusvibe.ai",
  timeout: 60_000,
  headers: {
    "x-api-key": process.env.PLUSVIBE_KEY!,
    Authorization: `Bearer ${process.env.PLUSVIBE_KEY!}`,
    "Content-Type": "application/json"
  },
  validateStatus: () => true
});

async function patchStep1(campaignId: string): Promise<void> {
  const sequences = getStep1SequencePayload(3);
  const payload = {
    workspace_id: WS,
    campaign_id: campaignId,
    first_wait_time: 0,
    sequences
  };
  const resp = await client.patch("/api/v1/campaign/update/campaign", payload);
  console.log(`[patch] campaign=${campaignId} status=${resp.status}`);
  console.log(JSON.stringify(resp.data).slice(0, 800));
  if (resp.status >= 400) {
    throw new Error(`Failed to patch ${campaignId}: ${resp.status} ${JSON.stringify(resp.data)}`);
  }
}

async function syncLeadVariables(uploadedCsv: string): Promise<void> {
  const rows = parse(fs.readFileSync(uploadedCsv, "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true
  }) as Array<Record<string, string>>;

  console.log(`[vars] updating talent_type/buyer_type on ${rows.length} leads...`);
  let ok = 0;
  let fail = 0;

  await mapPool(rows, 8, async (row) => {
    const email = (row.email || "").trim().toLowerCase();
    const campaignId = (row.plusvibe_campaign_id || "").trim();
    if (!email || !campaignId) {
      fail++;
      return;
    }
    const variables: Record<string, string> = {
      talent_type: row.talent_type || "",
      buyer_type: row.buyer_type || "",
      // also set clean aliases without double custom_ prefix
      custom_talent_type: row.talent_type || "",
      custom_buyer_type: row.buyer_type || ""
    };
    const resp = await client.post("/api/v1/lead/data/update", {
      workspace_id: WS,
      campaign_id: campaignId,
      email,
      variables
    });
    if (resp.status >= 400 || (resp.data?.status && resp.data.status !== "success")) {
      fail++;
      if (fail <= 5) {
        console.warn(`[vars] fail ${email}: ${resp.status} ${JSON.stringify(resp.data).slice(0, 200)}`);
      }
    } else {
      ok++;
    }
  });

  console.log(`[vars] done ok=${ok} fail=${fail}`);
}

async function main(): Promise<void> {
  const outPath = argValue("--scripts-out") ?? "staffing_sop_examples/step1_variable_scripts.txt";
  const uploadedCsv = argValue("--uploaded") ?? "staffing_sop_v4_run/uploaded_leads.csv";
  const skipVars = hasFlag("--skip-vars");

  // Write human-readable plain scripts
  const plain = STAFFING_STEP1_SCRIPTS.map(
    (v) =>
      `===== ${v.variation}. ${v.name} =====\nSubject: ${v.subject}\n\n${v.body}\n`
  ).join("\n");
  fs.writeFileSync(outPath, plain);
  console.log(`[scripts] wrote ${outPath}`);

  await patchStep1(GOOGLE);
  await patchStep1(OUTLOOK);

  if (!skipVars) {
    await syncLeadVariables(uploadedCsv);
  }

  console.log("[done] Step 1 variants replaced on Google + Outlook campaigns");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
