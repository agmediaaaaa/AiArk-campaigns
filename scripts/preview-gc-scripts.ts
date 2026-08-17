import "dotenv/config";
import fs from "node:fs";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { normalizeCompany } from "../functions/normalizeCompany.js";
import { enrichConstructionTalent } from "../functions/enrichConstructionTalent.js";
import { enrichCandidateTeaser } from "../functions/enrichCandidateTeaser.js";
import { generateGcColdEmailV2 } from "../functions/generateGcColdEmailV2.js";
import { pickCandidateCount } from "../functions/generateGcColdEmail.js";
import { cleanText } from "../functions/classifyMx.js";

const PREVIEW_INDICES = [42, 118, 256, 389, 512, 678, 801, 934, 1102, 1288];

function readLeads(path: string): Record<string, string>[] {
  const text = fs.readFileSync(path, "utf-8");
  return parse(text, {
    columns: (h: string[]) => h.map((x) => x.trim().toLowerCase().replace(/\s+/g, "_")),
    skip_empty_lines: true,
    trim: true,
    bom: true
  }) as Record<string, string>[];
}

async function run(): Promise<void> {
  const leads = readLeads("data/sheet2_leads.csv");
  const picks = PREVIEW_INDICES.map((i) => leads[i]!).filter(Boolean);

  const rows: Record<string, string>[] = [];

  for (let i = 0; i < picks.length; i++) {
    const raw = picks[i]!;
    const firstName = cleanText(raw.first_name);
    const companyName = cleanText(raw.company_name);
    const companyNameNormalized = await normalizeCompany(raw.company_name);

    const enrichment = await enrichConstructionTalent({
      companyNameNormalized,
      companyDescription: raw.company_description,
      companyProductsServices: raw.company_products_services,
      title: raw.title,
      city: raw.city,
      state: raw.state,
      companySize: raw.company_size || raw.company_employee_count
    });

    const candidateTeaser = await enrichCandidateTeaser({
      companyType: enrichment.companyType,
      talentType: enrichment.talentType,
      city: raw.city,
      state: raw.state,
      companyDescription: raw.company_description,
      companyProductsServices: raw.company_products_services
    });

    const candidateCount = pickCandidateCount(`${firstName}:${companyNameNormalized}:${i}`);
    const script = await generateGcColdEmailV2({
      firstName,
      title: cleanText(raw.title),
      companyName,
      companyNameNormalized,
      companyDescription: raw.company_description,
      companyProductsServices: raw.company_products_services,
      companySize: cleanText(raw.company_size || raw.company_employee_count),
      city: cleanText(raw.city),
      state: cleanText(raw.state),
      companyType: enrichment.companyType,
      talentType: enrichment.talentType,
      candidateTeaser,
      candidateCount
    });

    rows.push({
      first_name: firstName,
      last_name: cleanText(raw.last_name),
      company_name: companyName,
      title: cleanText(raw.title),
      city: cleanText(raw.city),
      state: cleanText(raw.state),
      company_type: enrichment.companyType,
      talent_type: enrichment.talentType,
      candidate_teaser: candidateTeaser,
      candidate_count: String(candidateCount),
      word_count: String(script.wordCount),
      cold_email_html: script.coldEmailHtml,
      cold_email_plain: script.coldEmailPlain
    });

    console.log(`[${i + 1}/10] ${firstName} @ ${companyName}`);
  }

  fs.mkdirSync("run_outputs_gc_preview10", { recursive: true });
  fs.writeFileSync(
    "run_outputs_gc_preview10/preview_scripts.csv",
    stringify(rows, { header: true })
  );
  fs.writeFileSync(
    "run_outputs_gc_preview10/preview_scripts.json",
    JSON.stringify(rows, null, 2)
  );
  console.log("Wrote run_outputs_gc_preview10/preview_scripts.csv");
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
