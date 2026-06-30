import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";

import { mapPool } from "../functions/mapPool.js";
import {
  gateMaLeadForPipeline,
  leadNeedsTryKitt,
  toSupabaseLeadRow
} from "../functions/processMaLeadRow.js";
import { findEmailsBatch } from "../functions/findEmail.js";
import { upsertLeads, type SupabaseLeadRow } from "../integrations/supabase.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function loadCsv(filePath: string): Promise<Record<string, string>[]> {
  return parse(fs.readFileSync(filePath, "utf-8"), {
    columns: (h: string[]) => h.map((x) => x.trim()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  }) as Record<string, string>[];
}

async function run(): Promise<void> {
  const inputs = (argValue("--input") ?? "data/ma_leads_full.csv,data/ma_v2_jun26.csv")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const concurrency = Math.max(1, Number(argValue("--concurrency") ?? "12"));
  const skipTryKitt = hasFlag("--skip-trykitt") || !process.env.TRYKITT_API_KEY;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_KEY required in .env");
  }

  const allRows: Array<{ raw: Record<string, string>; source: string; index: number }> = [];
  for (const input of inputs) {
    const rows = await loadCsv(path.resolve(input));
    rows.forEach((raw, index) => allRows.push({ raw, source: input, index }));
    console.log(`[supabase-backfill] loaded ${rows.length} rows from ${input}`);
  }

  const trykittCache = new Map();
  if (!skipTryKitt) {
    const trykittItems = allRows
      .map((item, i) => ({ ...item, globalIndex: i }))
      .filter(({ raw }) => leadNeedsTryKitt(raw))
      .map(({ raw, globalIndex }) => ({
        key: globalIndex,
        firstName: raw["First Name"] ?? raw.first_name,
        lastName: raw["Last Name"] ?? raw.last_name,
        companyName: raw["Company Name"] ?? raw.company_name ?? raw.Organization,
        companyWebsite: raw["Company Website"] ?? raw.company_website,
        personLinkedin: raw.LinkedIn ?? raw.linkedin
      }));

    if (trykittItems.length > 0) {
      console.log(`[supabase-backfill] trykitt prefetch: ${trykittItems.length}`);
      const found = await findEmailsBatch(trykittItems);
      for (const [key, result] of found) trykittCache.set(Number(key), result);
      const hits = [...found.values()].filter((r) => r.email).length;
      console.log(`[supabase-backfill] trykitt done: ${hits}/${trykittItems.length}`);
    }
  } else {
    console.log("[supabase-backfill] skip-trykitt: only rows with Email Business");
  }

  const byEmail = new Map<string, SupabaseLeadRow>();
  let removed = 0;

  await mapPool(allRows, concurrency, async (item, i) => {
    const outcome = await gateMaLeadForPipeline(item.raw, {
      trykittCache,
      rowIndex: i,
      skipTryKitt
    });
    if (!outcome.ok) {
      removed++;
      return;
    }
    const row = toSupabaseLeadRow(outcome.gated);
    byEmail.set(row.Email.toLowerCase(), row);
  });

  const rows = [...byEmail.values()];
  console.log(`[supabase-backfill] gated eligible=${rows.length} removed=${removed} unique emails`);

  const report = await upsertLeads(rows);
  console.log(
    `[supabase-backfill] done: attempted=${report.attempted} succeeded=${report.succeeded} failed=${report.failed}`
  );
  if (report.errors.length) {
    console.error("[supabase-backfill] errors:", report.errors.slice(0, 5));
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
