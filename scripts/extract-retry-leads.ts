import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

type Row = Record<string, string>;

function readCsv(p: string): Row[] {
  const text = fs.readFileSync(p, "utf-8");
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true
  }) as Row[];
}

function normKey(first: string, last: string, company: string): string {
  return `${first.trim().toLowerCase()}|${last.trim().toLowerCase()}|${company.trim().toLowerCase()}`;
}

function run(): void {
  const fullPath = argValue("--full") ?? "data/leads.csv";
  const removedPath = argValue("--removed") ?? "run_outputs_gc_full/removed_leads.csv";
  const outDir = argValue("--output") ?? "data";

  const full = readCsv(fullPath);
  const removed = readCsv(removedPath);

  const byEmail = new Map<string, Row>();
  const byKey = new Map<string, Row>();
  for (const row of full) {
    const email = (row["Email Business"] ?? row.email_business ?? "").trim().toLowerCase();
    const key = normKey(
      row["First Name"] ?? row.first_name ?? "",
      row["Last Name"] ?? row.last_name ?? "",
      row["Company Name"] ?? row.company_name ?? ""
    );
    if (email) byEmail.set(email, row);
    byKey.set(key, row);
  }

  function resolveRemoved(rem: Row): Row | undefined {
    const email = (rem.email ?? rem["Email Business"] ?? "").trim().toLowerCase();
    if (email && byEmail.has(email)) return byEmail.get(email);
    const key = normKey(rem.first_name ?? "", rem.last_name ?? "", rem.company_name ?? "");
    return byKey.get(key);
  }

  const reasons = (argValue("--reasons") ?? "humanizer_failed,outlook_not_eligible").split(",");
  const buckets = new Map<string, Row[]>();

  for (const reason of reasons) {
    buckets.set(reason.trim(), []);
  }

  let missing = 0;
  for (const rem of removed) {
    const reason = rem.reason?.trim();
    if (!reason || !buckets.has(reason)) continue;
    const row = resolveRemoved(rem);
    if (!row) {
      missing++;
      continue;
    }
    buckets.get(reason)!.push(row);
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const [reason, rows] of buckets) {
    const slug = reason.replace(/[^a-z0-9]+/gi, "_");
    const outPath = path.join(outDir, `${slug}.csv`);
    fs.writeFileSync(outPath, stringify(rows, { header: true }));
    console.log(`Wrote ${rows.length} rows -> ${outPath}`);
  }

  if (missing > 0) {
    console.warn(`Warning: ${missing} removed rows could not be matched back to full CSV`);
  }
}

run();
