import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { findEmailsBatch } from "../functions/findEmail.js";
import { mapPool } from "../functions/mapPool.js";
import {
  leadNeedsTryKitt,
  processSaasLeadRow,
  toSupabaseLeadRow,
  type SaasProcessedLead,
  type SaasRemovedLead
} from "../functions/processSaasLeadRow.js";
import { uploadLeadsBatch, type PlusVibeLeadPayload } from "../integrations/plusvibe.js";
import { lookupEmailsFromDatabase, upsertLeads } from "../integrations/supabase.js";

type SaasConfig = {
  product: { description: string };
  campaigns?: {
    google_others?: {
      workspaceId?: string;
      campaignId?: string;
    };
  };
};

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function readConfig(p: string): SaasConfig {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as SaasConfig;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toUploadPayload(result: SaasProcessedLead): PlusVibeLeadPayload {
  const lead = result.lead;
  const e = result.enriched;
  return {
    email: lead.email_business,
    first_name: lead.first_name || undefined,
    last_name: lead.last_name || undefined,
    company_name: e.company_name_normalized || lead.company_name || undefined,
    company_website: lead.company_website || undefined,
    linkedin_person_url: lead.linkedin || undefined,
    linkedin_company_url: lead.company_linkedin || undefined,
    city: lead.city || undefined,
    country: lead.country || undefined,
    custom_variables: {
      custom_cold_email: e.cold_email_html,
      custom_gtm_motion: e.gtm_motion,
      custom_north_star_metric: e.north_star_metric,
      custom_company_type: e.company_type,
      custom_account_list_size: String(e.account_list_size)
    }
  };
}

async function run(): Promise<void> {
  const input = argValue("--input") ?? "data/leads-2736.csv";
  const pilot = argValue("--count") ? Number(argValue("--count")) : 0;
  const startRow = argValue("--start") ? Number(argValue("--start")) : 0;
  const outDir = path.resolve(argValue("--out-dir") ?? `zs_saas_run_${Date.now()}`);
  const configPath = argValue("--config") ?? "configs/zs_saas_outbound.json";
  const enrichConcurrency = Math.max(1, Number(argValue("--concurrency") ?? "5"));
  const uploadBatchSize = Math.max(1, Number(argValue("--upload-batch") ?? "25"));
  const skipUpload = hasFlag("--skip-upload");
  const skipSupabase = hasFlag("--skip-supabase");

  const workspaceId =
    argValue("--workspace") ??
    process.env.PLUSVIBE_WORKSPACE_ID ??
    "69a5b2169433a45c6f6d7d1c";
  const campaignId =
    argValue("--campaign") ??
    process.env.PLUSVIBE_CAMPAIGN_ID ??
    "6a47850365fa564829fbcb53";

  const missing: string[] = [];
  if (!process.env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!process.env.TRYKITT_API_KEY) missing.push("TRYKITT_API_KEY");
  if (!process.env.MILLIONVERIFIER_API_KEY) missing.push("MILLIONVERIFIER_API_KEY");
  if (!skipUpload && !process.env.PLUSVIBE_KEY) missing.push("PLUSVIBE_KEY");
  if (missing.length) {
    throw new Error(`Startup gate failed — missing: ${missing.join(", ")}`);
  }

  const config = readConfig(configPath);
  const googleCampaign =
    config.campaigns?.google_others?.campaignId?.trim() || campaignId;
  const resolvedWorkspace =
    config.campaigns?.google_others?.workspaceId?.trim() || workspaceId;

  fs.mkdirSync(outDir, { recursive: true });

  const rows = parse(fs.readFileSync(input, "utf-8"), {
    columns: (h: string[]) => h.map((x) => x.trim()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  }) as Record<string, string>[];

  const slice = pilot > 0 ? rows.slice(startRow, startRow + pilot) : rows.slice(startRow);
  const batch = slice;
  console.log(
    `[zs-saas] loaded ${rows.length} rows, processing ${batch.length} from ${input} (start=${startRow})`
  );

  const trykittCache = new Map();
  const trykittItems = batch
    .map((raw, i) => ({ raw, i }))
    .filter(({ raw }) => leadNeedsTryKitt(raw))
    .map(({ raw, i }) => ({
      key: i,
      firstName: raw["First Name"] ?? raw.first_name,
      lastName: raw["Last Name"] ?? raw.last_name,
      companyName: raw["Company Name"] ?? raw.company_name ?? raw.Org,
      companyWebsite: raw["Company Website"] ?? raw.company_website,
      personLinkedin: raw.LinkedIn ?? raw.linkedin
    }));

  const supabaseCache = new Map<number, string>();
  const supabaseItems = batch
    .map((raw, i) => ({ raw, i }))
    .filter(({ raw }) => leadNeedsTryKitt(raw))
    .map(({ raw, i }) => ({
      key: i,
      firstName: raw["First Name"] ?? raw.first_name,
      lastName: raw["Last Name"] ?? raw.last_name,
      companyName: raw["Company Name"] ?? raw.company_name ?? raw.Org,
      linkedin: raw.LinkedIn ?? raw.linkedin
    }));

  if (supabaseItems.length > 0 && process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    console.log(`[zs-saas] supabase prefetch: ${supabaseItems.length} leads`);
    const found = await lookupEmailsFromDatabase(supabaseItems);
    for (const [key, email] of found) supabaseCache.set(Number(key), email);
    console.log(`[zs-saas] supabase prefetch hits: ${found.size}/${supabaseItems.length}`);
  }

  if (trykittItems.length > 0) {
    const needsTrykitt = trykittItems.filter((item) => !supabaseCache.has(Number(item.key)));
    console.log(`[zs-saas] trykitt prefetch: ${needsTrykitt.length} leads`);
    if (needsTrykitt.length > 0) {
      const found = await findEmailsBatch(needsTrykitt);
      for (const [key, result] of found) trykittCache.set(Number(key), result);
      const hits = [...found.values()].filter((r) => r.email).length;
      console.log(`[zs-saas] trykitt done: ${hits}/${needsTrykitt.length} emails found`);
    }
  }

  let done = 0;
  const t0 = Date.now();
  const outcomes = await mapPool(batch, enrichConcurrency, async (raw, i) => {
    const outcome = await processSaasLeadRow(raw, {
      productDescription: config.product.description,
      trykittCache,
      supabaseCache,
      rowIndex: i
    });
    done++;
    if (done % 10 === 0 || done === batch.length) {
      const elapsed = (Date.now() - t0) / 1000;
      console.log(`[zs-saas] enriched ${done}/${batch.length} (${(done / elapsed).toFixed(2)}/s)`);
    }
    return outcome;
  });

  const removed: SaasRemovedLead[] = [];
  const enrichedResults: SaasProcessedLead[] = [];

  for (const outcome of outcomes) {
    if (outcome.ok) enrichedResults.push(outcome.result);
    else removed.push(outcome.removed);
  }

  const enrichedCsv = enrichedResults.map((e) => ({
    email: e.lead.email_business,
    first_name: e.lead.first_name,
    last_name: e.lead.last_name,
    title: e.lead.title,
    company_name: e.lead.company_name,
    company_name_normalized: e.enriched.company_name_normalized,
    company_type: e.enriched.company_type,
    gtm_motion: e.enriched.gtm_motion,
    north_star_metric: e.enriched.north_star_metric,
    account_list_size: e.enriched.account_list_size,
    domain_settings: e.lead.domain_settings,
    esp_classification: e.lead.esp_classification,
    email_source: e.email_source,
    email_verification_status: e.email_verification_status ?? "",
    opening_line: e.enriched.opening_line,
    value_line: e.enriched.value_line,
    offer_line: e.enriched.value_line,
    cta: e.enriched.cta,
    cold_email_html: e.enriched.cold_email_html,
    city: e.lead.city,
    state: e.lead.state,
    country: e.lead.country,
    company_website: e.lead.company_website,
    linkedin: e.lead.linkedin,
    company_linkedin: e.lead.company_linkedin
  }));

  fs.writeFileSync(path.join(outDir, "enriched_leads.csv"), stringify(enrichedCsv, { header: true }));
  fs.writeFileSync(path.join(outDir, "removed_leads.csv"), stringify(removed, { header: true }));

  const dropsByReason = removed.reduce<Record<string, number>>((acc, r) => {
    acc[r.reason] = (acc[r.reason] ?? 0) + 1;
    return acc;
  }, {});

  let uploadOk = 0;
  let uploadFailed = 0;
  const uploadErrors: Array<{ email: string; error: string }> = [];

  if (!skipUpload && enrichedResults.length > 0) {
    const payloads = enrichedResults.map(toUploadPayload);
    console.log(
      `[zs-saas] uploading ${payloads.length} google/others leads → campaign ${googleCampaign}`
    );
    for (let i = 0; i < payloads.length; i += uploadBatchSize) {
      const batchIdx = Math.floor(i / uploadBatchSize);
      const chunk = payloads.slice(i, i + uploadBatchSize);
      const result = await uploadLeadsBatch(
        chunk,
        { workspaceId: resolvedWorkspace, campaignId: googleCampaign },
        { isOverwrite: true }
      );
      if (result.ok) {
        uploadOk += result.count;
        console.log(`[zs-saas] upload batch ${batchIdx + 1}: ok (${result.count}) total=${uploadOk}`);
      } else {
        uploadFailed += chunk.length;
        if (uploadErrors.length < 50) {
          for (const p of chunk) {
            uploadErrors.push({ email: p.email, error: result.error });
          }
        }
        console.error(`[zs-saas] upload batch ${batchIdx + 1}: failed ${result.error}`);
      }
      if (i + uploadBatchSize < payloads.length) await sleep(250);
    }
    fs.writeFileSync(path.join(outDir, "upload_errors.csv"), stringify(uploadErrors, { header: true }));
  }

  let supabaseReport = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    errors: [] as Array<{ chunk: number; message: string }>
  };
  if (!skipSupabase && process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    const supabaseRows = enrichedResults.map((e) => toSupabaseLeadRow(e));
    console.log(`[zs-saas] supabase upsert: ${supabaseRows.length} rows`);
    supabaseReport = await upsertLeads(supabaseRows);
    console.log(
      `[zs-saas] supabase done: succeeded=${supabaseReport.succeeded} failed=${supabaseReport.failed}`
    );
  }

  const withColdEmail = enrichedResults.filter((e) => e.enriched.cold_email_html?.includes("<div>")).length;

  const summary = {
    input_rows: batch.length,
    enriched: enrichedResults.length,
    removed: removed.length,
    with_cold_email: withColdEmail,
    drops_by_reason: dropsByReason,
    upload: skipUpload ? "skipped" : { ok: uploadOk, failed: uploadFailed },
    supabase: skipSupabase ? "skipped" : supabaseReport,
    campaign_id: googleCampaign,
    workspace_id: resolvedWorkspace,
    elapsed_seconds: ((Date.now() - t0) / 1000).toFixed(1),
    out_dir: outDir
  };

  fs.writeFileSync(path.join(outDir, "run_summary.json"), JSON.stringify(summary, null, 2));
  console.log(`[zs-saas] complete: enriched=${enrichedResults.length} removed=${removed.length}`);
  console.log(`[zs-saas] cold emails generated: ${withColdEmail}/${enrichedResults.length}`);
  if (!skipUpload) console.log(`[zs-saas] upload: ok=${uploadOk} failed=${uploadFailed}`);
  console.log(`[zs-saas] artifacts → ${outDir}`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
