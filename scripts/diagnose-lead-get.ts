import "dotenv/config";
import fs from "node:fs";
import axios from "axios";
import { parse as parseCsv } from "csv-parse/sync";

const WS = "69a5b2169433a45c6f6d7d1c";
const KEY = process.env.PLUSVIBE_KEY as string;
const client = axios.create({
  baseURL: "https://api.plusvibe.ai",
  timeout: 60_000,
  headers: { "x-api-key": KEY, Authorization: `Bearer ${KEY}` },
  validateStatus: () => true
});

const rows = parseCsv(fs.readFileSync("staffing_sop_v4_run/uploaded_leads.csv", "utf8"), {
  columns: true,
  bom: true,
  trim: true
}) as Array<Record<string, string>>;

const sample = [...rows.slice(0, 4), ...rows.filter((r) => r.esp === "google").slice(0, 3)];

for (const row of sample) {
  const r1 = await client.get("/api/v1/lead/get", {
    params: { workspace_id: WS, email: row.email, campaign_id: row.plusvibe_campaign_id, limit: 1 }
  });
  const r2 = await client.get("/api/v1/lead/get", {
    params: { workspace_id: WS, email: row.email, limit: 5 }
  });
  const arr = Array.isArray(r2.data) ? r2.data : [];
  console.log({
    email: row.email,
    esp: row.esp,
    csvCamp: row.plusvibe_campaign_id,
    getWithCampLen: Array.isArray(r1.data) ? r1.data.length : r1.status,
    getAllLen: arr.length,
    camps: arr.map((x: { campaign?: string; lead_data?: { campaign_id?: string } }) => x.campaign || x.lead_data?.campaign_id)
  });
}
