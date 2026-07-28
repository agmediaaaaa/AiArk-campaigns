import "dotenv/config";
import fs from "node:fs";
import axios from "axios";

const KEY = process.env.PLUSVIBE_KEY!;
const WS = "69a5b2169433a45c6f6d7d1c";
const camps = [
  "6a0c38f31c68c3afb81240c4",
  "6a414d310cd53ac8421e1e91",
  "6a4b5e9a8551c2fad96fa22b",
  "6a4e04fdfd24ec03d6bec6c0",
  "6a63138c875a20934814a16c",
  "69e0c3b7d399ded33bc7c377",
  "69eb4cb35e147cef84aabb21",
  "69eb3e6ec9b674fd290a1702",
  "69d63c61bebea65afcacdfa0",
  "6a689fbfa31a315ac8162d86",
  "6a689fd6dbf8557e58f1f312",
  "69f344487096434828955871"
];

const client = axios.create({
  baseURL: "https://api.plusvibe.ai",
  timeout: 60_000,
  headers: { "x-api-key": KEY, Authorization: `Bearer ${KEY}` },
  validateStatus: () => true
});

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchCamp(camp: string): Promise<string[]> {
  const emails: string[] = [];
  let page = 1;
  let failures = 0;
  while (true) {
    const r = await client.get("/api/v1/lead/workspace-leads", {
      params: { workspace_id: WS, campaign_id: camp, page, limit: 100 }
    });
    if (r.status === 403 || r.status === 429) {
      failures++;
      const wait = Math.min(45_000, 3000 * failures);
      console.log(`[${camp}] status=${r.status} page=${page}; wait ${wait}ms`);
      await sleep(wait);
      if (failures > 15) break;
      continue;
    }
    if (r.status !== 200) {
      console.log(`[${camp}] status=${r.status} page=${page}`, JSON.stringify(r.data).slice(0, 200));
      break;
    }
    failures = 0;
    const rows = Array.isArray(r.data) ? r.data : r.data?.leads ?? r.data?.data ?? [];
    if (!rows.length) break;
    for (const row of rows) {
      const e = String(row.email ?? "")
        .trim()
        .toLowerCase();
      if (e) emails.push(e);
    }
    if (rows.length < 100) break;
    page++;
    await sleep(250);
  }
  return emails;
}

async function main() {
  const all = new Set<string>();
  for (const camp of camps) {
    const emails = await fetchCamp(camp);
    for (const e of emails) all.add(e);
    console.log(`${camp}: +${emails.length} total_unique=${all.size}`);
    await sleep(500);
  }
  fs.writeFileSync("/tmp/zs_existing_emails.json", JSON.stringify([...all].sort()));
  fs.writeFileSync("/tmp/zs_existing_emails.txt", [...all].sort().join("\n"));
  console.log("DONE", all.size);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
