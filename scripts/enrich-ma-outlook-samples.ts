import "dotenv/config";
import fs from "node:fs";
import { parse } from "csv-parse/sync";

import { espFromMxData } from "../functions/classifyMx.js";
import { enrichMaOutreachNoTeaser } from "../functions/enrichMaOutreachNoTeaser.js";
import { normalizeSheetRow } from "../functions/prepareMaSheet.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function isOutlookRow(row: Record<string, string>): boolean {
  const r = normalizeSheetRow(row);
  const mx = (r.mx_records || row["MX Records"] || "").toLowerCase();
  if (mx.includes("outlook") || mx.includes("protection.outlook")) return true;
  const esp = espFromMxData(mx);
  return esp === "outlook";
}

async function run(): Promise<void> {
  const input = argValue("--input") ?? "data/ma_v2_jun26.csv";
  const count = Number(argValue("--count") ?? "10");

  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required");

  const rows = parse(fs.readFileSync(input, "utf-8"), {
    columns: (h: string[]) => h.map((x) => x.trim()),
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true
  }) as Record<string, string>[];

  const outlookRows = rows.filter(isOutlookRow);
  console.error(`[outlook-samples] ${outlookRows.length} outlook rows in ${input}, writing ${count} samples`);

  const productDescription =
    "We connect advisory firms with companies that match their ideal client profile — vague intros only, no live deals held.";

  let written = 0;
  for (const row of outlookRows) {
    if (written >= count) break;
    const r = normalizeSheetRow(row);
    const result = await enrichMaOutreachNoTeaser(
      {
        first_name: r.first_name,
        last_name: r.last_name,
        title: r.title,
        company_name: r.company_name,
        company_description: r.company_description,
        company_products_services: r.company_products_services,
        company_industry: r.company_industry,
        company_size: r.company_size,
        city: r.city,
        state: r.state,
        country: r.country,
        company_website: r.company_website,
        company_linkedin: r.company_linkedin
      },
      productDescription
    );

    const plain = result.cold_email_html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?div>/gi, "")
      .trim();

    console.log(
      JSON.stringify(
        {
          index: written + 1,
          name: `${r.first_name} ${r.last_name}`,
          firm: r.company_name,
          service: result.ma_service_type,
          observation: result.observation,
          connect_line: result.connect_line,
          email_plain: plain,
          email_html: result.cold_email_html
        },
        null,
        2
      )
    );
    console.log("---");
    written++;
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
