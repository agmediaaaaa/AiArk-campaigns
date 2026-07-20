import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { cleanText } from "../functions/classifyMx.js";
import { enrichSaasOutreach, stripHtmlForCount, wordCount } from "../functions/enrichSaasOutreach.js";

type LeadRow = Record<string, string>;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function readConfig(configPath: string): {
  company: { name?: string; description: string };
  product: { name?: string; description: string };
} {
  return JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
    company: { name?: string; description: string };
    product: { name?: string; description: string };
  };
}

async function run(): Promise<void> {
  const input = argValue("--input") ?? "data/leads_sheet2.csv";
  const output = argValue("--output") ?? "outputs/saas_pilot_enriched.csv";
  const configPath = argValue("--config") ?? "configs/saas_founders.json";
  const limit = Number(argValue("--limit") ?? "10");

  if (!fs.existsSync(input)) {
    throw new Error(`Input not found: ${input}. Run: npx tsx scripts/fetch-sheet2.ts`);
  }

  const config = readConfig(configPath);
  const raw = fs.readFileSync(input, "utf-8");
  const leads = parse(raw, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_")),
    skip_empty_lines: true,
    trim: true,
    bom: true
  }) as LeadRow[];

  const slice = leads.slice(0, limit);
  const rows: Record<string, string>[] = [];

  for (let i = 0; i < slice.length; i++) {
    const lead = slice[i]!;
    console.log(`[${i + 1}/${slice.length}] enriching ${cleanText(lead.company_name) || "(unknown)"}...`);

    const enriched = await enrichSaasOutreach({
      firstName: lead.first_name,
      companyName: lead.company_name,
      companyDescription: lead.company_description,
      companyProductsServices: lead.company_products_services,
      companyIndustry: lead.company_industry,
      title: lead.title,
      companySize: lead.company_size,
      vendorCompanyName: config.company.name,
      vendorCompanyDescription: config.company.description,
      vendorProductName: config.product.name,
      vendorProductDescription: config.product.description
    });

    const emailWords = wordCount(stripHtmlForCount(enriched.cold_email_body));
    const vpWords = wordCount(enriched.value_prop);
    console.log(
      `  motion=${enriched.saas_motion} cta=${enriched.primary_cta} words: email=${emailWords} value_prop=${vpWords}`
    );

    rows.push({
      first_name: cleanText(lead.first_name),
      last_name: cleanText(lead.last_name),
      title: cleanText(lead.title),
      company_name: cleanText(lead.company_name),
      company_website: cleanText(lead.company_website),
      email_business: cleanText(lead.email_business),
      saas_motion: enriched.saas_motion,
      customer_type: enriched.customer_type,
      primary_cta: enriched.primary_cta,
      lead_icp: enriched.lead_icp,
      value_prop: enriched.value_prop,
      cold_email_body: enriched.cold_email_body
    });
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, stringify(rows, { header: true }));
  console.log(`Wrote ${rows.length} rows to ${output}`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
