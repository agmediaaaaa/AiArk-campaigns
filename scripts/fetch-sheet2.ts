import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

const SHEET_ID = "1z1loclpc8wa9QtvTH1lXcIC2NIFUgiV6eMXTy8fRDds";
const SHEET2_GID = "518632193";
const DEFAULT_OUT = "data/leads_sheet2.csv";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function normalizeDomainSettings(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  const norm = v.toLowerCase().replace(/[^a-z]/g, "");
  if (norm === "smtp") return "SMTP";
  if (norm === "catchall") return "CatchAll";
  return v;
}

async function fetchSheet2(): Promise<void> {
  const outPath = argValue("--output") ?? DEFAULT_OUT;
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET2_GID}`;

  console.log(`[fetch-sheet2] downloading Sheet2 (gid=${SHEET2_GID})...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download sheet: HTTP ${res.status}`);
  }
  const text = await res.text();

  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  }) as Record<string, string>[];

  const normalized = records.map((row) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      const k = key.trim().toLowerCase().replace(/\s+/g, "_");
      if (k === "company_product_and_services") {
        out.company_products_services = String(value ?? "").trim();
      } else if (k === "domain_settings") {
        out.domain_settings = normalizeDomainSettings(String(value ?? ""));
      } else {
        out[k] = String(value ?? "").trim();
      }
    }
    if (!out.company_products_services && row["Company Product and Services"]) {
      out.company_products_services = String(row["Company Product and Services"]).trim();
    }
    return out;
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const headers = [...new Set(normalized.flatMap((r) => Object.keys(r)))];
  fs.writeFileSync(outPath, stringify(normalized, { header: true, columns: headers }));

  const smtp = normalized.filter((r) => r.domain_settings === "SMTP").length;
  const catchAll = normalized.filter((r) => r.domain_settings === "CatchAll").length;
  const blank = normalized.filter((r) => !r.domain_settings).length;
  const withEmail = normalized.filter((r) => r.email_business?.trim()).length;

  console.log(`[fetch-sheet2] wrote ${normalized.length} rows to ${outPath}`);
  console.log(
    `[fetch-sheet2] domain_settings: SMTP=${smtp}, CatchAll=${catchAll}, blank=${blank}, with_email=${withEmail}`
  );
}

fetchSheet2().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
