import "dotenv/config";
import fs from "node:fs";
import axios from "axios";
import { parse } from "csv-parse/sync";
import { mapPool } from "../functions/mapPool.js";

const WS = "69a5b2169433a45c6f6d7d1c";
const client = axios.create({
  baseURL: "https://api.plusvibe.ai",
  timeout: 60_000,
  headers: {
    "x-api-key": process.env.PLUSVIBE_KEY!,
    Authorization: `Bearer ${process.env.PLUSVIBE_KEY!}`,
    "Content-Type": "application/json"
  },
  validateStatus: () => true
});

async function main(): Promise<void> {
  const rows = parse(fs.readFileSync("staffing_sop_v4_run/uploaded_leads.csv", "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true
  }) as Array<Record<string, string>>;

  console.log("rows", rows.length);
  let ok = 0;
  let fail = 0;

  await mapPool(rows, 10, async (row) => {
    const email = (row.email || "").trim().toLowerCase();
    const campaignId = (row.plusvibe_campaign_id || "").trim();
    if (!email || !campaignId) {
      fail++;
      return;
    }
    const resp = await client.post("/api/v1/lead/data/update", {
      workspace_id: WS,
      campaign_id: campaignId,
      email,
      variables: {
        talent_type: row.talent_type || "",
        buyer_type: row.buyer_type || ""
      }
    });
    if (resp.status !== 200) {
      fail++;
      if (fail <= 8) {
        console.warn(email, resp.status, JSON.stringify(resp.data).slice(0, 180));
      }
      return;
    }
    ok++;
    if (ok % 200 === 0) console.log("ok", ok);
  });

  console.log("done ok", ok, "fail", fail);

  const sample = rows.find((r) => r.esp !== "outlook") || rows[0]!;
  const check = await client.get("/api/v1/lead/get", {
    params: {
      workspace_id: WS,
      email: sample.email,
      campaign_id: sample.plusvibe_campaign_id,
      limit: 1
    }
  });
  const item = Array.isArray(check.data) ? check.data[0] : check.data;
  const ld = item?.lead_data || item || {};
  console.log("sample", sample.email, {
    talent_type: ld.talent_type,
    buyer_type: ld.buyer_type,
    custom_talent_type: ld.custom_talent_type,
    custom_custom_talent_type: ld.custom_custom_talent_type
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
