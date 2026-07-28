/**
 * Force re-add uploaded leads into Google/Outlook campaigns with clean
 * talent_type / buyer_type custom vars (PlusVibe stores as custom_*).
 * Uses skip_if_in_workspace=false so workspace duplicates still join these campaigns.
 */
import "dotenv/config";
import fs from "node:fs";
import axios from "axios";
import { parse } from "csv-parse/sync";
import { getStep1SequencePayload } from "../functions/staffingStep1Scripts.js";

const WS = "69a5b2169433a45c6f6d7d1c";
const GOOGLE = "6a689fbfa31a315ac8162d86";
const OUTLOOK = "6a689fd6dbf8557e58f1f312";
const BATCH = 25;

const client = axios.create({
  baseURL: "https://api.plusvibe.ai",
  timeout: 60_000,
  headers: {
    "x-api-key": process.env.PLUSVIBE_KEY as string,
    Authorization: `Bearer ${process.env.PLUSVIBE_KEY as string}`,
    "Content-Type": "application/json"
  },
  validateStatus: () => true
});

async function patchScripts(campaignId: string): Promise<void> {
  const resp = await client.patch("/api/v1/campaign/update/campaign", {
    workspace_id: WS,
    campaign_id: campaignId,
    first_wait_time: 0,
    sequences: getStep1SequencePayload(3)
  });
  console.log(`[patch] ${campaignId} ${resp.status} ${JSON.stringify(resp.data).slice(0, 200)}`);
  if (resp.status >= 400) throw new Error(`patch failed ${campaignId}`);
}

async function uploadBucket(
  label: string,
  campaignId: string,
  rows: Array<Record<string, string>>
): Promise<void> {
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const leads = batch.map((r) => ({
      email: (r.email || "").toLowerCase(),
      first_name: r.first_name || undefined,
      last_name: r.last_name || undefined,
      company_name: r.company_name || undefined,
      company_website: r.company_website || undefined,
      linkedin_person_url: r.linkedin || undefined,
      city: r.city || undefined,
      custom_variables: {
        talent_type: r.talent_type || "",
        buyer_type: r.buyer_type || ""
      }
    }));
    const resp = await client.post("/api/v1/lead/add", {
      workspace_id: WS,
      campaign_id: campaignId,
      skip_if_in_workspace: false,
      is_overwrite: true,
      leads
    });
    if (resp.status >= 400) {
      fail += batch.length;
      console.warn(`[upload] ${label} fail@${i}`, resp.status, JSON.stringify(resp.data).slice(0, 300));
    } else {
      ok += batch.length;
    }
    if ((i / BATCH) % 10 === 0) {
      console.log(`[upload] ${label} ${Math.min(i + batch.length, rows.length)}/${rows.length}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`[upload] ${label} done ok=${ok} fail=${fail}`);
}

async function main(): Promise<void> {
  await patchScripts(GOOGLE);
  await patchScripts(OUTLOOK);

  const rows = parse(fs.readFileSync("staffing_sop_v4_run/uploaded_leads.csv", "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true
  }) as Array<Record<string, string>>;

  const google = rows.filter((r) => r.plusvibe_campaign_id === GOOGLE);
  const outlook = rows.filter((r) => r.plusvibe_campaign_id === OUTLOOK);
  console.log(`re-upload google=${google.length} outlook=${outlook.length}`);

  await uploadBucket("google", GOOGLE, google);
  await uploadBucket("outlook", OUTLOOK, outlook);

  // verify one each
  for (const row of [google[0], outlook[0]].filter(Boolean) as Array<Record<string, string>>) {
    const check = await client.get("/api/v1/lead/get", {
      params: {
        workspace_id: WS,
        email: row.email,
        campaign_id: row.plusvibe_campaign_id,
        limit: 1
      }
    });
    const item = Array.isArray(check.data) ? check.data[0] : null;
    const ld = item?.lead_data || {};
    console.log("verify", row.email, {
      found: Boolean(item),
      custom_talent_type: ld.custom_talent_type,
      custom_buyer_type: ld.custom_buyer_type
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
