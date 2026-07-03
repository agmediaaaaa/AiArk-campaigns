/**
 * Launch N parallel SaaS pipeline workers over disjoint row ranges.
 *
 * Usage:
 *   npx tsx scripts/run-zs-saas-shards.ts --input data/leads-2736.csv --shards 6
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function countCsvRows(file: string): number {
  const text = fs.readFileSync(file, "utf-8");
  const rows = parse(text, { columns: true, skip_empty_lines: true, bom: true }) as Record<string, string>[];
  return rows.length;
}

async function main(): Promise<void> {
  const input = arg("--input") ?? "data/leads-2736.csv";
  const config = arg("--config") ?? "configs/zs_saas_outbound.json";
  const start = Number(arg("--start") ?? "0");
  const shards = Number(arg("--shards") ?? "6");
  const concurrency = arg("--concurrency") ?? "5";
  const skipUpload = process.argv.includes("--skip-upload");
  const skipSupabase = process.argv.includes("--skip-supabase");

  if (!Number.isFinite(start) || start < 0) throw new Error("--start must be >= 0");
  if (!Number.isFinite(shards) || shards < 1) throw new Error("--shards must be >= 1");

  const total = countCsvRows(input);
  const remaining = total - start;
  if (remaining <= 0) {
    console.log(`Nothing to process: total=${total} start=${start}`);
    return;
  }

  const perShard = Math.ceil(remaining / shards);
  const jobs: Array<{ shard: number; startRow: number; count: number }> = [];

  for (let s = 0; s < shards; s++) {
    const startRow = start + s * perShard;
    if (startRow >= total) break;
    const count = Math.min(perShard, total - startRow);
    jobs.push({ shard: s, startRow, count });
  }

  console.log(`[zs-shards] total=${total} start=${start} jobs=${jobs.length}`);
  for (const j of jobs) {
    console.log(`  shard ${j.shard}: --start ${j.startRow} --count ${j.count}`);
  }

  const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "_");
  const logDir = path.resolve(`zs_saas_shard_logs_${ts}`);
  fs.mkdirSync(logDir, { recursive: true });

  const children = jobs.map((j) => {
    const logPath = path.join(logDir, `shard_${j.shard}.log`);
    const outDir = path.join(process.cwd(), `zs_saas_run_${ts}_shard${j.shard}`);
    const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const args = [
      tsxCli,
      path.join(process.cwd(), "scripts/run-zs-saas-pipeline.ts"),
      "--input",
      input,
      "--config",
      config,
      "--start",
      String(j.startRow),
      "--count",
      String(j.count),
      "--concurrency",
      concurrency,
      "--out-dir",
      outDir
    ];
    if (skipUpload) args.push("--skip-upload");
    if (skipSupabase) args.push("--skip-supabase");

    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);
    return { shard: j.shard, child, logPath, outDir, startRow: j.startRow, count: j.count };
  });

  const results = await Promise.all(
    children.map(
      (c) =>
        new Promise<{ shard: number; code: number | null; logPath: string; outDir: string }>((resolve) => {
          c.child.on("exit", (code) => {
            resolve({ shard: c.shard, code, logPath: c.logPath, outDir: c.outDir });
          });
        })
    )
  );

  console.log(`\n[zs-shards] all workers finished. logs in ${logDir}`);
  let totalEnriched = 0;
  let totalUploaded = 0;
  for (const r of results) {
    const summaryPath = path.join(r.outDir, "run_summary.json");
    let enriched = 0;
    let uploaded = 0;
    if (fs.existsSync(summaryPath)) {
      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf-8")) as {
        enriched?: number;
        upload?: { ok?: number };
      };
      enriched = summary.enriched ?? 0;
      uploaded = typeof summary.upload === "object" ? (summary.upload.ok ?? 0) : 0;
    }
    totalEnriched += enriched;
    totalUploaded += uploaded;
    console.log(`  shard ${r.shard}: exit=${r.code} enriched=${enriched} uploaded=${uploaded} log=${r.logPath}`);
  }
  console.log(`[zs-shards] totals: enriched=${totalEnriched} uploaded=${totalUploaded}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
