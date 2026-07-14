import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { cleanText } from "../functions/classifyMx.js";
import { generateColdEmail } from "../functions/generateColdEmail.js";
import { mapPool } from "../functions/mapPool.js";
import { uploadLead, type PlusVibeLeadPayload } from "../integrations/plusvibe.js";

type Row = Record<string, string>;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadSourceByEmail(sourceCsv: string): Map<string, Row> {
  const map = new Map<string, Row>();
  if (!fs.existsSync(sourceCsv)) return map;
  const rows = parse(fs.readFileSync(sourceCsv, "utf-8"), {
    columns: (h: string[]) => h.map((x) => x.trim().toLowerCase().replace(/\s+/g, "_")),
    skip_empty_lines: true,
    bom: true
  }) as Row[];
  for (const r of rows) {
    const email = cleanText(r.email_business).toLowerCase();
    if (email) map.set(email, r);
  }
  return map;
}

function loadEnrichedFromDirs(dirs: string[]): Row[] {
  const byEmail = new Map<string, Row>();
  for (const dir of dirs) {
    const csvPath = path.join(dir, "enriched_leads.csv");
    if (!fs.existsSync(csvPath)) {
      console.warn(`skip missing ${csvPath}`);
      continue;
    }
    const rows = parse(fs.readFileSync(csvPath, "utf-8"), {
      columns: true,
      skip_empty_lines: true,
      bom: true
    }) as Row[];
    for (const r of rows) {
      const email = cleanText(r.email).toLowerCase();
      if (!email) continue;
      byEmail.set(email, r);
    }
  }
  return [...byEmail.values()];
}

function loadCheckpoint(checkpointPath: string): { done: Set<string>; results: Row[] } {
  const done = new Set<string>();
  const results: Row[] = [];
  if (!fs.existsSync(checkpointPath)) return { done, results };
  const rows = parse(fs.readFileSync(checkpointPath, "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    bom: true
  }) as Row[];
  for (const r of rows) {
    const email = cleanText(r.email).toLowerCase();
    if (!email) continue;
    done.add(email);
    results.push(r);
  }
  return { done, results };
}

function appendCheckpoint(checkpointPath: string, row: Row, header: string[]): void {
  const line = stringify([row], { header: false, columns: header });
  if (!fs.existsSync(checkpointPath)) {
    fs.writeFileSync(checkpointPath, stringify([], { header: true, columns: header }));
  }
  fs.appendFileSync(checkpointPath, line);
}

async function main(): Promise<void> {
  const campaignId = argValue("--campaign");
  const workspaceId = argValue("--workspace") ?? "68cc548e33b6c342f85bd2d9";
  const outDir = argValue("--output") ?? path.resolve("run_outputs_regenerated_upload");
  const pilot = Number(argValue("--pilot") ?? "0");
  const resume = process.argv.includes("--resume");
  const fixEmpty = process.argv.includes("--fix-empty");
  const concurrency = Number(process.env.ROW_CONCURRENCY ?? "3");
  const batchSize = Number(process.env.REGEN_BATCH_SIZE ?? "25");

  const inputDirs = (
    argValue("--inputs")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [
      "run_outputs_20260630_103401_shard0",
      "run_outputs_20260630_103401_shard1",
      "run_outputs_20260630_103401_shard2",
      "run_outputs_20260630_103401_shard3"
    ]
  ).map((d) => path.resolve(d));

  if (!campaignId) {
    throw new Error(
      "Usage: npx tsx scripts/regenerate-and-upload.ts --campaign <id> [--resume] [--pilot N]"
    );
  }

  if (!process.env.PLUSVIBE_KEY) throw new Error("PLUSVIBE_KEY required");
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required");

  const sourceCsv = argValue("--source") ?? path.resolve("data/welltech_healthcare_leads.csv");
  const sourceByEmail = loadSourceByEmail(sourceCsv);

  let leads = loadEnrichedFromDirs(inputDirs).map((row) => {
    const src = sourceByEmail.get(cleanText(row.email).toLowerCase());
    if (!src) return row;
    return {
      ...row,
      company_description: src.company_description ?? "",
      company_products_services: src.company_products_services ?? ""
    };
  });
  if (pilot > 0) leads = leads.slice(0, pilot);

  fs.mkdirSync(outDir, { recursive: true });
  const checkpointPath = path.join(outDir, "checkpoint.csv");
  const { done: doneEmails, results: checkpointResults } = resume
    ? loadCheckpoint(checkpointPath)
    : { done: new Set<string>(), results: [] as Row[] };

  const emptyInCheckpoint = new Set(
    checkpointResults.filter((r) => !cleanText(r.cold_email)).map((r) => cleanText(r.email).toLowerCase())
  );

  let results = [...checkpointResults.filter((r) => cleanText(r.cold_email))];

  const pending = leads.filter((r) => {
    const email = cleanText(r.email).toLowerCase();
    if (fixEmpty && emptyInCheckpoint.has(email)) return true;
    return !doneEmails.has(email);
  });

  console.log(
    `[regen] total=${leads.length} resume=${resume} already_done=${doneEmails.size} pending=${pending.length}`
  );
  console.log(`[regen] campaign=${campaignId} model=${process.env.COLD_EMAIL_MODEL ?? "gpt-4o-mini"}`);

  const resultHeader = [
    "email",
    "first_name",
    "last_name",
    "company_name",
    "facility_type",
    "talent_type",
    "cold_email",
    "cold_email_old",
    "upload_ok",
    "upload_error",
    "plusvibe_campaign_id"
  ];

  let processed = 0;

  async function processOne(row: Row): Promise<Row> {
    const email = cleanText(row.email).toLowerCase();
    const coldEmail = await generateColdEmail({
      firstName: row.first_name,
      email: row.email,
      companyName: row.company_name,
      companyNameNormalized: row.company_name_normalized,
      title: row.title,
      city: row.city,
      state: row.state,
      companySize: row.company_size,
      companyProductsServices: row.company_products_services,
      companyDescription: row.company_description,
      facilityType: row.facility_type,
      talentType: row.talent_type
    });

    const payload: PlusVibeLeadPayload = {
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
        custom_facility_type: cleanText(row.facility_type),
        custom_talent_type: cleanText(row.talent_type),
        custom_cold_email: coldEmail,
        facility_type: cleanText(row.facility_type),
        talent_type: cleanText(row.talent_type),
        cold_email: coldEmail,
        first_name: cleanText(row.first_name),
        last_name: cleanText(row.last_name),
        linkedin: cleanText(row.linkedin),
        company_name: cleanText(row.company_name_normalized) || cleanText(row.company_name),
        company_website: cleanText(row.company_website),
        company_linkedin: cleanText(row.company_linkedin),
        title: cleanText(row.title),
        city: cleanText(row.city),
        state: cleanText(row.state),
        country: cleanText(row.country),
        company_size: cleanText(row.company_size),
        company_industry: cleanText(row.company_industry)
      }
    };

    const upload = coldEmail
      ? await uploadLead(payload, { workspaceId, campaignId })
      : { ok: false, campaignId, workspaceId, error: "empty cold_email" };
    return {
      email,
      first_name: cleanText(row.first_name),
      last_name: cleanText(row.last_name),
      company_name: cleanText(row.company_name),
      facility_type: cleanText(row.facility_type),
      talent_type: cleanText(row.talent_type),
      cold_email: coldEmail,
      cold_email_old: row.cold_email ?? "",
      upload_ok: upload.ok ? "true" : "false",
      upload_error: upload.ok ? "" : upload.error,
      plusvibe_campaign_id: campaignId
    };
  }

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const batchResults = await mapPool(batch, concurrency, (row) => processOne(row));
    for (const resultRow of batchResults) {
      if (!cleanText(resultRow.cold_email)) {
        console.warn(`[regen] skip checkpoint (empty email): ${resultRow.email}`);
        continue;
      }
      results.push(resultRow);
      appendCheckpoint(checkpointPath, resultRow, resultHeader);
    }
    processed += batchResults.length;
    console.log(`[regen] progress ${doneEmails.size + processed}/${leads.length}`);
  }

  const uploaded = results.filter((r) => r.upload_ok === "true").length;
  fs.writeFileSync(path.join(outDir, "regenerated_leads.csv"), stringify(results, { header: true }));
  fs.writeFileSync(
    path.join(outDir, "run_summary.json"),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        campaign_id: campaignId,
        workspace_id: workspaceId,
        total: results.length,
        uploaded_ok: uploaded,
        uploaded_failed: results.length - uploaded,
        model: process.env.COLD_EMAIL_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini"
      },
      null,
      2
    )
  );

  console.log(`[regen] done. uploaded=${uploaded}/${results.length} -> ${outDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
