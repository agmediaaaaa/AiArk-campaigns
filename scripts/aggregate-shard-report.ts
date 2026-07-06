/**
 * Merge run_summary.json + enriched/removed CSVs from parallel shard output dirs.
 *
 * Usage:
 *   npx tsx scripts/aggregate-shard-report.ts run_outputs_*_shard0 run_outputs_*_shard1 ...
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";

type Summary = {
  counts: {
    input: number;
    smtp_eligible: number;
    catchall_skipped: number;
    uploaded_ok: number;
    uploaded_failed: number;
    drops_by_reason: Record<string, number>;
  };
  operator_report?: { enriched?: number; uploaded?: number };
};

function loadSummary(dir: string): Summary {
  const p = path.join(dir, "run_summary.json");
  return JSON.parse(fs.readFileSync(p, "utf-8")) as Summary;
}

function countCsv(dir: string, file: string): number {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) return 0;
  const rows = parse(fs.readFileSync(p, "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    bom: true
  }) as Record<string, string>[];
  return rows.length;
}

function espBreakdown(dirs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const dir of dirs) {
    const p = path.join(dir, "enriched_leads.csv");
    if (!fs.existsSync(p)) continue;
    const rows = parse(fs.readFileSync(p, "utf-8"), {
      columns: true,
      skip_empty_lines: true,
      bom: true
    }) as Record<string, string>[];
    for (const r of rows) {
      const esp = r.esp_classification || "unknown";
      out[esp] = (out[esp] || 0) + 1;
    }
  }
  return out;
}

function removedByReason(dirs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const dir of dirs) {
    const p = path.join(dir, "removed_leads.csv");
    if (!fs.existsSync(p)) continue;
    const rows = parse(fs.readFileSync(p, "utf-8"), {
      columns: true,
      skip_empty_lines: true,
      bom: true
    }) as Record<string, string>[];
    for (const r of rows) {
      const reason = r.reason || "unknown";
      out[reason] = (out[reason] || 0) + 1;
    }
  }
  return out;
}

function main(): void {
  const dirs = process.argv.slice(2).filter((d) => fs.existsSync(d));
  if (!dirs.length) {
    console.error("Usage: npx tsx scripts/aggregate-shard-report.ts <shard_dir>...");
    process.exit(1);
  }

  const totals = {
    input: 0,
    smtp_eligible: 0,
    catchall_skipped: 0,
    uploaded_ok: 0,
    uploaded_failed: 0,
    enriched: 0,
    removed: 0,
    upload_errors: 0,
    drops_by_reason: {} as Record<string, number>
  };

  for (const dir of dirs) {
    const s = loadSummary(dir);
    totals.input += s.counts.input;
    totals.smtp_eligible += s.counts.smtp_eligible;
    totals.catchall_skipped += s.counts.catchall_skipped;
    totals.uploaded_ok += s.counts.uploaded_ok;
    totals.uploaded_failed += s.counts.uploaded_failed;
    totals.enriched += countCsv(dir, "enriched_leads.csv");
    totals.removed += countCsv(dir, "removed_leads.csv");
    totals.upload_errors += countCsv(dir, "upload_errors.csv");
    for (const [k, v] of Object.entries(s.counts.drops_by_reason)) {
      totals.drops_by_reason[k] = (totals.drops_by_reason[k] || 0) + v;
    }
  }

  const report = {
    shard_dirs: dirs,
    totals,
    esp_breakdown_enriched: espBreakdown(dirs),
    removed_by_reason_csv: removedByReason(dirs),
    uploaded_with_cold_email: 0
  };

  for (const dir of dirs) {
    const p = path.join(dir, "enriched_leads.csv");
    if (!fs.existsSync(p)) continue;
    const rows = parse(fs.readFileSync(p, "utf-8"), {
      columns: true,
      skip_empty_lines: true,
      bom: true
    }) as Record<string, string>[];
    report.uploaded_with_cold_email += rows.filter(
      (r) => r.upload_ok === "true" && (r.cold_email || "").trim().length > 0
    ).length;
  }

  const outPath = path.resolve("sheet2_aggregate_report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main();
