import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { enrichMaCustomVars } from "../functions/enrichMaCustomVars.js";
import { findEmailsBatch } from "../functions/findEmail.js";
import { mapPool } from "../functions/mapPool.js";
import {
  gateMaLeadForPipeline,
  leadNeedsTryKitt,
  type MaGatedLead
} from "../functions/processMaLeadRow.js";
import { normalizeSheetRow } from "../functions/prepareMaSheet.js";
import { resolveEspCampaign, type EspBucket } from "../functions/routeMaEspCampaign.js";
import {
  fetchCampaignEmails,
  resolveWorkspaceId,
  uploadLeadsBatch,
  type PlusVibeLeadPayload
} from "../integrations/plusvibe.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toUploadPayload(g: MaGatedLead, enriched: Awaited<ReturnType<typeof enrichMaCustomVars>>): PlusVibeLeadPayload {
  return {
    email: g.lead.email_business,
    custom_variables: {
      custom_investment_focus: enriched.investment_focus,
      custom_teaser: enriched.teaser,
      custom_icp: enriched.icp
    }
  };
}

async function uploadByCampaign(
  items: Array<{ payload: PlusVibeLeadPayload; campaignId: string; workspaceId: string }>,
  batchSize: number,
  uploadConcurrency: number
): Promise<{ ok: number; failed: number; errors: string[] }> {
  const byCampaign = new Map<string, PlusVibeLeadPayload[]>();
  let workspaceId = "";
  for (const item of items) {
    workspaceId = item.workspaceId;
    const list = byCampaign.get(item.campaignId) ?? [];
    list.push(item.payload);
    byCampaign.set(item.campaignId, list);
  }

  let ok = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const [campaignId, payloads] of byCampaign) {
    const batches: PlusVibeLeadPayload[][] = [];
    for (let i = 0; i < payloads.length; i += batchSize) {
      batches.push(payloads.slice(i, i + batchSize));
    }

    let campaignOk = 0;
    let campaignFailed = 0;
    await mapPool(batches, uploadConcurrency, async (batch, idx) => {
      const result = await uploadLeadsBatch(batch, { workspaceId, campaignId });
      if (result.ok) campaignOk += batch.length;
      else {
        campaignFailed += batch.length;
        if (errors.length < 30) errors.push(`campaign=${campaignId} batch=${idx + 1}: ${result.error}`);
      }
      await sleep(220);
    });
    ok += campaignOk;
    failed += campaignFailed;
    console.log(`[sheet2] uploaded campaign=${campaignId}: ok=${campaignOk} failed=${campaignFailed}`);
  }

  return { ok, failed, errors };
}

async function run(): Promise<void> {
  const input = argValue("--input") ?? "data/ma_sheet2.csv";
  const outDir = path.resolve(argValue("--out-dir") ?? `ma_sheet2_run_${Date.now()}`);
  const dedupeCampaign = argValue("--dedupe-campaign") ?? "6a578dd88a850fbfc5c3a342";
  const googleCampaign = argValue("--google-campaign") ?? "6a578dd88a850fbfc5c3a342";
  const outlookCampaign = argValue("--outlook-campaign") ?? "6a63596649504d7b1d73da7e";
  const enrichConcurrency = Math.max(1, Number(argValue("--concurrency") ?? "6"));
  const uploadBatchSize = Math.max(1, Number(argValue("--upload-batch") ?? "10"));
  const uploadConcurrency = Math.max(1, Number(argValue("--upload-concurrency") ?? "4"));
  const skipUpload = hasFlag("--skip-upload");
  const skipDedupe = hasFlag("--skip-dedupe");
  const t0 = Date.now();

  const missing: string[] = [];
  if (!process.env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!process.env.TRYKITT_API_KEY) missing.push("TRYKITT_API_KEY");
  if (!process.env.MILLIONVERIFIER_API_KEY) missing.push("MILLIONVERIFIER_API_KEY");
  if (!skipUpload && !process.env.PLUSVIBE_KEY) missing.push("PLUSVIBE_KEY");
  if (missing.length) throw new Error(`Startup gate failed — missing: ${missing.join(", ")}`);

  fs.mkdirSync(outDir, { recursive: true });

  const rows = parse(fs.readFileSync(input, "utf-8"), {
    columns: (h: string[]) => h.map((x) => x.trim()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  }) as Record<string, string>[];

  console.log(`[sheet2] loaded ${rows.length} rows from ${input}`);

  const workspaceId =
    argValue("--workspace-id")?.trim() ||
    process.env.PLUSVIBE_WORKSPACE_ID?.trim() ||
    (await resolveWorkspaceId("zs").catch(() => ""));

  if (!skipUpload && !workspaceId) {
    throw new Error("Could not resolve PlusVibe workspace ID");
  }

  let existingEmails = new Set<string>();
  if (!skipDedupe && workspaceId) {
    console.log(`[sheet2] fetching existing emails from campaign ${dedupeCampaign} for dedupe...`);
    existingEmails = await fetchCampaignEmails(workspaceId, dedupeCampaign);
    console.log(`[sheet2] dedupe pool: ${existingEmails.size} emails already in campaign`);
  }

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

  if (trykittItems.length > 0) {
    console.log(`[sheet2] trykitt prefetch: ${trykittItems.length} leads`);
    const found = await findEmailsBatch(trykittItems);
    for (const [key, result] of found) trykittCache.set(Number(key), result);
    const hits = [...found.values()].filter((r) => r.email).length;
    console.log(`[sheet2] trykitt done: ${hits}/${trykittItems.length} emails found`);
  }

  const gated: Array<{ gated: MaGatedLead; raw: Record<string, string> }> = [];
  const removed: unknown[] = [];
  const deduped: Array<{ email: string; company_name: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]!;
    const outcome = await gateMaLeadForPipeline(raw, { trykittCache, rowIndex: i });
    if (!outcome.ok) {
      removed.push(outcome.removed);
      continue;
    }

    const email = outcome.gated.lead.email_business.toLowerCase();
    if (existingEmails.has(email)) {
      deduped.push({
        email,
        company_name: outcome.gated.lead.company_name
      });
      continue;
    }

    gated.push({ gated: outcome.gated, raw });
  }

  console.log(
    `[sheet2] gated=${gated.length} removed=${removed.length} deduped=${deduped.length}`
  );

  let done = 0;
  const enriched = await mapPool(gated, enrichConcurrency, async ({ gated: g }) => {
    const lead = g.lead;
    const result = await enrichMaCustomVars({
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
    });
    done++;
    if (done % 50 === 0 || done === gated.length) {
      console.log(`[sheet2] enriched ${done}/${gated.length}`);
    }
    return { g, result };
  });

  const enrichedCsv = enriched.map(({ g, result }) => ({
    email: g.lead.email_business,
    first_name: g.lead.first_name,
    last_name: g.lead.last_name,
    company_name: g.lead.company_name,
    ma_service_type: result.ma_service_type,
    esp_classification: g.lead.esp_classification,
    domain_settings: g.lead.domain_settings,
    custom_investment_focus: result.investment_focus,
    custom_teaser: result.teaser,
    custom_icp: result.icp
  }));

  fs.writeFileSync(path.join(outDir, "enriched_leads.csv"), stringify(enrichedCsv, { header: true }));
  fs.writeFileSync(path.join(outDir, "removed_leads.csv"), stringify(removed, { header: true }));
  fs.writeFileSync(path.join(outDir, "deduped_leads.csv"), stringify(deduped, { header: true }));

  const espCounts: Record<EspBucket, number> = { outlook: 0, google_others: 0 };
  const uploadItems: Array<{
    payload: PlusVibeLeadPayload;
    campaignId: string;
    workspaceId: string;
    bucket: EspBucket;
  }> = [];

  for (const { g, result } of enriched) {
    const route = resolveEspCampaign(g.lead.esp_classification, {
      googleOthersCampaignId: googleCampaign,
      outlookCampaignId: outlookCampaign,
      workspaceId
    });
    espCounts[route.bucket]++;
    if (!skipUpload) {
      uploadItems.push({
        payload: toUploadPayload(g, result),
        campaignId: route.campaignId,
        workspaceId: route.workspaceId,
        bucket: route.bucket
      });
    }
  }

  let uploadReport = { ok: 0, failed: 0, errors: [] as string[] };
  if (!skipUpload) {
    console.log(
      `[sheet2] uploading custom vars only: google/others=${espCounts.google_others} → ${googleCampaign}, outlook=${espCounts.outlook} → ${outlookCampaign}`
    );
    uploadReport = await uploadByCampaign(uploadItems, uploadBatchSize, uploadConcurrency);
  }

  const summary = {
    input_rows: rows.length,
    gated: gated.length,
    removed: removed.length,
    deduped: deduped.length,
    enriched: enriched.length,
    routing: {
      esp: espCounts,
      campaigns: {
        google_others: googleCampaign,
        outlook: outlookCampaign
      }
    },
    upload: skipUpload ? "skipped" : uploadReport,
    workspace_id: workspaceId || null,
    dedupe_campaign: dedupeCampaign,
    elapsed_seconds: ((Date.now() - t0) / 1000).toFixed(1),
    out_dir: outDir
  };

  fs.writeFileSync(path.join(outDir, "run_summary.json"), JSON.stringify(summary, null, 2));

  console.log(`[sheet2] complete: enriched=${enriched.length} deduped=${deduped.length}`);
  console.log(
    `[sheet2] ESP routing: google/others=${espCounts.google_others} outlook=${espCounts.outlook}`
  );
  if (!skipUpload) {
    console.log(`[sheet2] upload: ok=${uploadReport.ok} failed=${uploadReport.failed}`);
  }
  console.log(`[sheet2] artifacts → ${outDir}`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
