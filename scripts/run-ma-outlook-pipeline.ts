import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { espFromMxData } from "../functions/classifyMx.js";
import { findEmailsBatch } from "../functions/findEmail.js";
import { mapPool } from "../functions/mapPool.js";
import { enrichMaOutreachNoTeaser } from "../functions/enrichMaOutreachNoTeaser.js";
import {
  gateMaLeadForPipeline,
  leadNeedsTryKitt,
  type MaGatedLead
} from "../functions/processMaLeadRow.js";
import { normalizeSheetRow } from "../functions/prepareMaSheet.js";
import { uploadLeadsBatch, type PlusVibeLeadPayload } from "../integrations/plusvibe.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function isOutlookEsp(esp: string, mx: string): boolean {
  const m = mx.toLowerCase();
  if (m.includes("outlook") || m.includes("protection.outlook")) return true;
  return esp.toLowerCase() === "outlook";
}

async function loadRows(inputArg: string): Promise<Record<string, string>[]> {
  const paths = inputArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const byEmail = new Map<string, Record<string, string>>();
  for (const p of paths) {
    const rows = parse(fs.readFileSync(p, "utf-8"), {
      columns: (h: string[]) => h.map((x) => x.trim()),
      skip_empty_lines: true,
      bom: true,
      relax_column_count: true
    }) as Record<string, string>[];
    console.log(`[outlook] loaded ${rows.length} rows from ${p}`);
    for (const row of rows) {
      const r = normalizeSheetRow(row);
      const email = (r.email_business || "").toLowerCase();
      if (email) byEmail.set(email, row);
      else byEmail.set(`__noemail_${byEmail.size}`, row);
    }
  }
  return [...byEmail.values()];
}

async function run(): Promise<void> {
  const input =
    argValue("--input") ?? "data/ma_v2_jun26.csv,data/ma_leads_full.csv";
  const outDir = path.resolve(argValue("--out-dir") ?? `ma_outlook_run_${Date.now()}`);
  const campaignId = argValue("--campaign") ?? "6a3d1a5c000972b86ec4f15a";
  const workspaceId = argValue("--workspace-id") ?? process.env.PLUSVIBE_WORKSPACE_ID ?? "";
  const concurrency = Math.max(1, Number(argValue("--concurrency") ?? "6"));
  const uploadConcurrency = Math.max(1, Number(argValue("--upload-concurrency") ?? "4"));
  const skipUpload = process.argv.includes("--skip-upload");
  const t0 = Date.now();

  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required");
  if (!skipUpload && (!process.env.PLUSVIBE_KEY || !workspaceId)) {
    throw new Error("PLUSVIBE_KEY and workspace id required for upload");
  }

  const productDescription =
    "We connect advisory firms with companies that match their ideal client profile — vague intros only, no live deals held.";

  const rows = await loadRows(input);
  console.log(`[outlook] unique rows after merge: ${rows.length}`);

  fs.mkdirSync(outDir, { recursive: true });

  const trykittCache = new Map();
  const trykittItems = rows
    .map((raw, i) => ({ raw, i }))
    .filter(({ raw }) => leadNeedsTryKitt(raw))
    .map(({ raw, i }) => ({
      key: i,
      firstName: raw["First Name"] ?? raw.first_name,
      lastName: raw["Last Name"] ?? raw.last_name,
      companyName: raw["Company Name"] ?? raw.company_name,
      companyWebsite: raw["Company Website"] ?? raw.company_website,
      personLinkedin: raw.LinkedIn ?? raw.linkedin
    }));

  if (trykittItems.length > 0 && process.env.TRYKITT_API_KEY) {
    console.log(`[outlook] trykitt prefetch: ${trykittItems.length}`);
    const found = await findEmailsBatch(trykittItems);
    for (const [key, result] of found) trykittCache.set(Number(key), result);
  }

  const gated: Array<{ gated: MaGatedLead; raw: Record<string, string> }> = [];
  const removed: unknown[] = [];

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]!;
    const outcome = await gateMaLeadForPipeline(raw, { trykittCache, rowIndex: i });
    if (!outcome.ok) {
      removed.push(outcome.removed);
      continue;
    }
    const mx = outcome.gated.mx_data || normalizeSheetRow(raw).mx_records || raw["MX Records"] || "";
    if (!isOutlookEsp(outcome.gated.lead.esp_classification, mx)) continue;
    gated.push({ gated: outcome.gated, raw });
  }

  console.log(`[outlook] gated outlook-eligible: ${gated.length} (removed/other esp skipped)`);

  let done = 0;
  const enriched = await mapPool(gated, concurrency, async ({ gated: g, raw }) => {
    const lead = g.lead;
    const result = await enrichMaOutreachNoTeaser(
      {
        first_name: lead.first_name,
        last_name: lead.last_name,
        title: lead.title,
        company_name: lead.company_name,
        company_name_normalized: lead.company_name_normalized,
        company_description: lead.company_description,
        company_products_services: lead.company_products_services,
        company_industry: lead.company_industry,
        company_size: lead.company_size,
        city: lead.city,
        state: lead.state,
        country: lead.country,
        company_website: lead.company_website,
        company_linkedin: lead.company_linkedin
      },
      productDescription
    );
    done++;
    if (done % 25 === 0 || done === gated.length) {
      console.log(`[outlook] enriched ${done}/${gated.length}`);
    }
    return { g, raw, result };
  });

  const csvRows = enriched.map(({ g, result }) => ({
    email: g.lead.email_business,
    first_name: g.lead.first_name,
    last_name: g.lead.last_name,
    company_name: g.lead.company_name,
    observation: result.observation,
    connect_line: result.connect_line,
    cold_email_html: result.cold_email_html,
    ma_service_type: result.ma_service_type
  }));

  fs.writeFileSync(path.join(outDir, "enriched_leads.csv"), stringify(csvRows, { header: true }));

  if (!skipUpload) {
    const payloads: PlusVibeLeadPayload[] = enriched.map(({ g, result }) => ({
      email: g.lead.email_business,
      custom_variables: { custom_cold_email: result.cold_email_html }
    }));

    const batches: PlusVibeLeadPayload[][] = [];
    const batchSize = 10;
    for (let i = 0; i < payloads.length; i += batchSize) {
      batches.push(payloads.slice(i, i + batchSize));
    }

    let ok = 0;
    let failed = 0;
    const errors: string[] = [];
    await mapPool(batches, uploadConcurrency, async (batch, idx) => {
      const res = await uploadLeadsBatch(batch, { workspaceId, campaignId });
      if (res.ok) ok += batch.length;
      else {
        failed += batch.length;
        if (errors.length < 20) errors.push(`batch ${idx + 1}: ${res.error}`);
      }
    });
    console.log(`[outlook] upload campaign=${campaignId}: ok=${ok} failed=${failed}`);

    const summary = {
      input_rows: rows.length,
      outlook_eligible: gated.length,
      enriched: enriched.length,
      upload: { ok, failed, errors, campaign_id: campaignId, workspace_id: workspaceId },
      elapsed_seconds: ((Date.now() - t0) / 1000).toFixed(1),
      out_dir: outDir
    };
    fs.writeFileSync(path.join(outDir, "run_summary.json"), JSON.stringify(summary, null, 2));
  } else {
    const summary = {
      input_rows: rows.length,
      outlook_eligible: gated.length,
      enriched: enriched.length,
      upload: "skipped",
      elapsed_seconds: ((Date.now() - t0) / 1000).toFixed(1),
      out_dir: outDir
    };
    fs.writeFileSync(path.join(outDir, "run_summary.json"), JSON.stringify(summary, null, 2));
  }

  console.log(`[outlook] artifacts → ${outDir}`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
