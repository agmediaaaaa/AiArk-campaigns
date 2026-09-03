import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse/sync';
import fs from 'node:fs';

type SupabaseLeadRow = {
  Email: string;
  'First Name'?: string | null;
  'Last Name'?: string | null;
  Linkedin?: string | null;
  'Company Name'?: string | null;
  Website?: string | null;
};

const SHEETS: Array<{ url: string; name?: string }> = [
  {
    url: 'https://docs.google.com/spreadsheets/d/1CP3dJ9WHua4LWv0gZUBgjwTkpSM82LDoXnlSC2WDuEk/edit?usp=sharing',
    name: 'sheet-1',
  },
  {
    url: 'https://docs.google.com/spreadsheets/d/1ZMnBgdjt7RVWVwSgVk5zwGSjnIp0Gy-aXOAakMeaVPE/edit?usp=sharing',
    name: 'sheet-2',
  },
  {
    url: 'https://docs.google.com/spreadsheets/d/1cRcZl958OwAcGSCp55X-bTTtRhGA5SnSd4oD9_773xg/edit?usp=sharing',
    name: 'sheet-3',
  },
  {
    url: 'https://docs.google.com/spreadsheets/d/13vIlZY9QVQyqLgb-W9WeaxRLcUB3XreQaTl-KY6aARg/edit?usp=sharing',
    name: 'sheet-4',
  },
  {
    url: 'https://docs.google.com/spreadsheets/d/1bEUE5TAFy_T3AXQEhQyjfy8Bu1yIPkgcm-RHZb7FH88/edit?usp=sharing',
    name: 'sheet-5',
  },
  {
    url: 'https://docs.google.com/spreadsheets/d/1k4Qdw2oAIdKsa7CElgN51lusmGR7TYXcUudodweC1kQ/edit?usp=sharing',
    name: 'sheet-6',
  },
  {
    url: 'https://docs.google.com/spreadsheets/d/1xmBEfmIiIXtATjqrn-3oqH71wW5yfBS02cnGZ6kWVO4/edit?usp=sharing',
    name: 'sheet-7',
  },
];

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function cleanText(v: unknown): string {
  return String(v ?? '').trim();
}

function normalizeHeader(s: string): string {
  return cleanText(s)
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findHeader(headers: string[], candidates: string[]): string | undefined {
  const byNorm = new Map(headers.map((h) => [normalizeHeader(h), h]));
  for (const c of candidates) {
    const cn = normalizeHeader(c);
    if (byNorm.has(cn)) return byNorm.get(cn);
  }
  // Fallback: substring match for messy names like "LinkedIn Profile URL"
  for (const c of candidates) {
    const cn = normalizeHeader(c);
    const hit = headers.find((h) => normalizeHeader(h).includes(cn));
    if (hit) return hit;
  }
  return undefined;
}

function spreadsheetIdFromUrl(url: string): string {
  // https://docs.google.com/spreadsheets/d/<id>/edit?...
  const m = url.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!m) throw new Error(`Unrecognized Google Sheets URL: ${url}`);
  return m[1];
}

async function fetchGvizCsv(spreadsheetId: string, gid: number): Promise<string | null> {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&gid=${gid}`;
  const res = await fetch(url, {
    // Some envs need a UA; this helps with occasional 403s.
    headers: { 'User-Agent': 'lead-engine/1.0 (+supabase upload script)' },
  });
  if (!res.ok) return null;
  return await res.text();
}

function validEmail(email: string): boolean {
  // Loose validation; Supabase will still enforce/clean based on schema/unique constraints.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

async function main(): Promise<void> {
  const maxGid = Number(arg('--max-gid') ?? 30);
  const chunkSize = Number(arg('--chunk-size') ?? 200);
  const dryRun = (arg('--dry-run') ?? '').toLowerCase() === 'true' || arg('--dry-run') === '1';
  const outPath = arg('--write-preview-json');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const supabase =
    dryRun
      ? null
      : (() => {
          if (!supabaseUrl || !supabaseKey) throw new Error('SUPABASE_URL/SUPABASE_KEY not set');
          return createClient(supabaseUrl, supabaseKey, {
            auth: { persistSession: false, autoRefreshToken: false },
          });
        })();

  // Dedupe across all sheets/tabs by normalized email.
  const byEmail = new Map<string, SupabaseLeadRow>();

  for (const sheet of SHEETS) {
    const spreadsheetId = spreadsheetIdFromUrl(sheet.url);
    console.log(`\n=== ${sheet.name ?? spreadsheetId} (${spreadsheetId}) ===`);

    let gidsProcessed = 0;
    let rowsKeptThisSheet = 0;
    let consecutiveEmpty = 0;

    for (let gid = 0; gid <= maxGid; gid++) {
      const csv = await fetchGvizCsv(spreadsheetId, gid);
      if (!csv) {
        consecutiveEmpty++;
        continue;
      }

      // If Google returns an empty CSV/tab, bail out after a few.
      if (csv.trim().length < 50) {
        consecutiveEmpty++;
        continue;
      }

      const firstLineEnd = csv.indexOf('\n');
      const headerLine = firstLineEnd === -1 ? csv.trim() : csv.slice(0, firstLineEnd).trim();
      if (!headerLine.includes('Email Business') && !headerLine.includes(',\"Email\"') && !headerLine.includes('"Email"')) {
        consecutiveEmpty++;
        continue;
      }

      consecutiveEmpty = 0;
      gidsProcessed++;

      const records = parse(csv, {
        columns: true,
        skip_empty_lines: true,
        relax_quotes: true,
        bom: true,
      }) as Array<Record<string, string>>;

      if (records.length === 0) continue;

      const headers = Object.keys(records[0] ?? {});
      const emailBusinessHeader = findHeader(headers, ['email business', 'email_business']);
      const emailHeader = findHeader(headers, ['email']);

      const firstNameHeader = findHeader(headers, ['first name', 'first_name']);
      const lastNameHeader = findHeader(headers, ['last name', 'last_name']);

      const linkedinHeader =
        findHeader(headers, ['linkedin profile url', 'linkedin url', 'linkedin']) ??
        findHeader(headers, ['company linkedin', 'linkedin']);

      const companyNameHeader =
        findHeader(headers, ['company name', 'company']) ?? findHeader(headers, ['organization']);

      const websiteHeader = findHeader(headers, ['company website', 'website', 'company website url']);

      for (const r of records) {
        const emailRaw = cleanText(
          emailBusinessHeader ? r[emailBusinessHeader] : emailHeader ? r[emailHeader] : ''
        );
        const email = emailRaw.trim();

        if (!email) continue;
        // User requirement: only upload rows where the "email business" exists.
        // If a sheet doesn't have that column, we treat "Email" as the equivalent.
        if (emailBusinessHeader) {
          if (!validEmail(email)) continue;
        } else if (emailHeader) {
          if (!validEmail(email)) continue;
        }

        const key = email.toLowerCase();
        const existing = byEmail.get(key);

        const next: SupabaseLeadRow = existing ? { ...existing } : ({ Email: email } as SupabaseLeadRow);

        const first = firstNameHeader ? cleanText(r[firstNameHeader]) : '';
        if (first) next['First Name'] = first;

        const last = lastNameHeader ? cleanText(r[lastNameHeader]) : '';
        if (last) next['Last Name'] = last;

        const linkedin = linkedinHeader ? cleanText(r[linkedinHeader]) : '';
        if (linkedin) next['Linkedin'] = linkedin;

        const companyName = companyNameHeader ? cleanText(r[companyNameHeader]) : '';
        if (companyName) next['Company Name'] = companyName;

        const website = websiteHeader ? cleanText(r[websiteHeader]) : '';
        if (website) next['Website'] = website;

        byEmail.set(key, next);
        rowsKeptThisSheet++;
      }

      console.log(`gid=${gid}: rows=${records.length}, kept=${rowsKeptThisSheet}`);

      // Heuristic stop: if we get a few consecutive missing/irrelevant tabs, assume end.
      if (consecutiveEmpty >= 5) {
        console.log(`Stopping at gid=${gid} (>=${consecutiveEmpty} empty/irrelevant tabs in a row).`);
        break;
      }
    }

    console.log(`Sheet summary: gidsProcessed=${gidsProcessed} totalKeptSoFar=${rowsKeptThisSheet}`);
  }

  const rows = [...byEmail.values()];
  console.log(`\nTotal unique emails to upsert: ${rows.length}`);

  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));
    console.log(`Wrote preview to ${outPath}`);
  }

  if (dryRun || rows.length === 0) {
    console.log(dryRun ? 'Dry run enabled; skipping Supabase upsert.' : 'No rows to upload.');
    return;
  }

  // Upsert via MCP RPC to ensure the correct underlying table (“Lead Database”).
  let totalInserted = 0;
  let totalUpdated = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const fileLike = `${String(Math.floor(i / chunkSize)).padStart(3, '0')}`;
    console.log(`Upserting chunk ${fileLike} size=${chunk.length}...`);
    if (!supabase) throw new Error('Unexpected: supabase client not initialized');
    const { data, error } = await supabase.rpc('upsert_lead_database_rows', { payload: chunk });
    if (error) {
      throw new Error(`Supabase RPC failed on chunk ${fileLike}: ${error.message}`);
    }
    const inserted = Number((data as any)?.inserted ?? 0);
    const updated = Number((data as any)?.updated ?? 0);
    totalInserted += inserted;
    totalUpdated += updated;
    console.log(`chunk ${fileLike}: inserted=${inserted} updated=${updated}`);
  }

  console.log(
    JSON.stringify(
      {
        total_unique_emails: rows.length,
        total_inserted: totalInserted,
        total_updated: totalUpdated,
        total_upserted: totalInserted + totalUpdated,
        rpc: 'upsert_lead_database_rows',
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

