/**
 * Staffing SOP pipeline (Sheet 1+ multi-sheet capable):
 * - exclude existing ZS workspace emails
 * - SEG drop
 * - TryKitt + MillionVerifier for missing emails
 * - enrich talent_type / buyer_type
 * - optional compose (usually skipped; campaigns use Step 1 templates)
 * - route Google vs Outlook campaigns
 * - upload with all standard + custom variables
 *
 * Flags:
 *   --input path|dir|csv,csv   (dir loads all *.csv)
 *   --google-only              skip Outlook ESP (no enrich/upload)
 *   --skip-compose             skip OpenAI email body compose
 *   --skip-trykitt             do not find missing emails
 *   --dry-run                  no PlusVibe upload
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import {
  classifyMx,
  cleanText,
  resolveLeadDomain,
  type Esp,
  type MxResult
} from "../functions/classifyMx.js";
import { findEmailsBatch } from "../functions/findEmail.js";
import { verifyEmail } from "../functions/verifyEmail.js";
import {
  composeStaffingSopEmail,
  enrichTalentAndBuyer,
  firstNameOnly
} from "../functions/composeStaffingSopEmail.js";
import { mapPool } from "../functions/mapPool.js";
import { uploadLeadsBatch, type PlusVibeLeadPayload } from "../integrations/plusvibe.js";

type LeadRow = Record<string, string>;

type Config = {
  campaigns: {
    google: { workspaceId: string; campaignId: string };
    outlook: { workspaceId: string; campaignId: string };
  };
  limits?: {
    openaiConcurrency?: number;
    uploadConcurrency?: number;
    uploadBatchSize?: number;
  };
};

type RemovedLead = {
  first_name: string;
  last_name: string;
  company_name: string;
  email: string;
  reason: string;
  detail?: string;
};

type UploadedLead = {
  first_name: string;
  last_name: string;
  email: string;
  company_name: string;
  talent_type: string;
  buyer_type: string;
  subject: string;
  email_body: string;
  framework: string;
  word_count: string;
  city: string;
  state: string;
  linkedin: string;
  company_website: string;
  esp: string;
  domain_settings: string;
  email_source: string;
  plusvibe_workspace_id: string;
  plusvibe_campaign_id: string;
  upload_ok: string;
  upload_error: string;
};

const SEG_PATTERNS = [
  "proofpoint",
  "pphosted",
  "mimecast",
  "barracuda",
  "barracudanetworks",
  "messagelabs",
  "sophos",
  "securence",
  "ironport",
  "cisco",
  "abnormal",
  "spamtitan"
];

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function readLeadsCsv(p: string): LeadRow[] {
  return parse(fs.readFileSync(p, "utf-8"), {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_")),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  }) as LeadRow[];
}

function productsField(lead: LeadRow): string {
  return cleanText(lead.company_product_and_services ?? lead.company_products_services);
}

function mxRecordsField(lead: LeadRow): string {
  return cleanText(lead.mx_records);
}

function isSegMx(mxData: string): boolean {
  const m = mxData.toLowerCase();
  return SEG_PATTERNS.some((p) => m.includes(p));
}

function espFromMx(mxData: string): Esp {
  const m = mxData.toLowerCase();
  if (!m) return "empty";
  if (["google", "googlemail", "aspmx", "gmail", "gsuite", "workspace"].some((p) => m.includes(p))) {
    return "google";
  }
  if (["outlook", "office365", "microsoft", "hotmail", "protection.outlook.com"].some((p) => m.includes(p))) {
    return "outlook";
  }
  return "others";
}

async function resolveMx(lead: LeadRow, email: string): Promise<MxResult> {
  const sheetMx = mxRecordsField(lead);
  if (sheetMx) {
    if (isSegMx(sheetMx)) {
      return { domain: resolveLeadDomain(email, lead.company_website), mxData: sheetMx, esp: "others", isSeg: true };
    }
    return {
      domain: resolveLeadDomain(email, lead.company_website),
      mxData: sheetMx,
      esp: espFromMx(sheetMx),
      isSeg: false
    };
  }
  const domain = resolveLeadDomain(email, cleanText(lead.company_website));
  if (!domain) return { domain: "", mxData: "", esp: "empty", isSeg: false };
  return classifyMx(domain);
}

function buildPayload(args: {
  raw: LeadRow;
  firstName: string;
  lastName: string;
  companyName: string;
  activeEmail: string;
  emailSource: string;
  talentType: string;
  buyerType: string;
  subject: string;
  emailBody: string;
  framework: number;
  wordCount: number;
  esp: string;
  routeSetting: string;
}): PlusVibeLeadPayload {
  const { raw } = args;
  return {
    email: args.activeEmail,
    first_name: args.firstName || undefined,
    last_name: args.lastName || undefined,
    company_name: args.companyName || undefined,
    company_website: cleanText(raw.company_website) || undefined,
    linkedin_person_url: cleanText(raw.linkedin) || undefined,
    linkedin_company_url: cleanText(raw.company_linkedin) || undefined,
    city: cleanText(raw.city) || undefined,
    country: cleanText(raw.country) || undefined,
    phone_number: cleanText(raw.mobile_phone) || undefined,
    // Keys must NOT start with custom_ — PlusVibe prefixes custom_ automatically.
    custom_variables: {
      talent_type: args.talentType || "",
      buyer_type: args.buyerType || "",
      client_type: args.buyerType || "",
      state: cleanText(raw.state) || "",
      title: cleanText(raw.title) || "",
      esp: args.esp || "",
      domain_settings: args.routeSetting || "",
      email_source: args.emailSource || "",
      company_industry: cleanText(raw.company_industry) || "",
      company_size: cleanText(raw.company_size) || "",
      company_employee_count: cleanText(raw.company_employee_count) || "",
      seniority: cleanText(raw.seniority) || "",
      department: cleanText(raw.department) || "",
      company_description: cleanText(raw.company_description).slice(0, 500) || "",
      company_products_services: productsField(raw).slice(0, 400) || ""
    }
  };
}

async function main(): Promise<void> {
  const input = argValue("--input") ?? "data/staffing_sheet1.csv";
  const configPath = path.resolve(argValue("--config") ?? "configs/staffing_zs_sop_v4.json");
  const outDir = path.resolve(argValue("--out-dir") ?? `staffing_sop_v4_run_${Date.now()}`);
  const existingPath = path.resolve(argValue("--existing-emails") ?? "/tmp/zs_existing_emails.json");
  const dryRun = hasFlag("--dry-run");
  const limit = Number(argValue("--limit") ?? "0") || 0;
  const start = Number(argValue("--start") ?? "0") || 0;
  const skipTrykitt = hasFlag("--skip-trykitt");
  const fallbackOnly = hasFlag("--fallback-only");
  const googleOnly = hasFlag("--google-only");
  const skipCompose = hasFlag("--skip-compose");

  const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Config;
  const openaiConcurrency = config.limits?.openaiConcurrency ?? 8;
  const uploadBatchSize = config.limits?.uploadBatchSize ?? 25;

  const existing = new Set<string>(
    JSON.parse(fs.readFileSync(existingPath, "utf-8")) as string[]
  );

  const inputParts = input.split(",").map((p) => p.trim()).filter(Boolean);
  let leads: LeadRow[] = [];
  for (const part of inputParts) {
    const resolved = path.resolve(part);
    if (fs.statSync(resolved).isDirectory()) {
      const files = fs
        .readdirSync(resolved)
        .filter((f) => f.toLowerCase().endsWith(".csv"))
        .sort()
        .map((f) => path.join(resolved, f));
      for (const f of files) leads = leads.concat(readLeadsCsv(f));
    } else {
      leads = leads.concat(readLeadsCsv(resolved));
    }
  }
  if (start > 0) leads = leads.slice(start);
  if (limit > 0) leads = leads.slice(0, limit);

  fs.mkdirSync(outDir, { recursive: true });
  console.log(
    `[sop] input=${input} rows=${leads.length} existing_emails=${existing.size} dryRun=${dryRun} googleOnly=${googleOnly} skipCompose=${skipCompose} out=${outDir}`
  );

  const removed: RemovedLead[] = [];
  const uploaded: UploadedLead[] = [];
  const googlePayloads: PlusVibeLeadPayload[] = [];
  const outlookPayloads: PlusVibeLeadPayload[] = [];

  // Pass 1: gate + collect trykitt needs
  type Working = {
    index: number;
    raw: LeadRow;
    firstName: string;
    lastName: string;
    companyName: string;
    email: string;
    emailSource: "csv" | "trykit" | "";
  };

  const working: Working[] = [];
  const needTrykitt: Array<{ key: number; raw: LeadRow; firstName: string; lastName: string; companyName: string }> =
    [];

  for (let i = 0; i < leads.length; i++) {
    const raw = leads[i]!;
    const firstName = firstNameOnly(raw.first_name);
    const lastName = cleanText(raw.last_name);
    const companyName = cleanText(raw.company_name) || cleanText(raw.organization);
    const emailBusiness = cleanText(raw.email_business).toLowerCase();

    // Early drops when sheet MX is already known.
    if (googleOnly) {
      const sheetMx = mxRecordsField(raw);
      if (sheetMx && isSegMx(sheetMx)) {
        removed.push({
          first_name: firstName,
          last_name: lastName,
          company_name: companyName,
          email: emailBusiness,
          reason: "security_gateway",
          detail: sheetMx.slice(0, 120)
        });
        continue;
      }
      if (sheetMx && espFromMx(sheetMx) === "outlook") {
        removed.push({
          first_name: firstName,
          last_name: lastName,
          company_name: companyName,
          email: emailBusiness,
          reason: "outlook_skipped"
        });
        continue;
      }
    } else {
      const sheetMx = mxRecordsField(raw);
      if (sheetMx && isSegMx(sheetMx)) {
        removed.push({
          first_name: firstName,
          last_name: lastName,
          company_name: companyName,
          email: emailBusiness,
          reason: "security_gateway",
          detail: sheetMx.slice(0, 120)
        });
        continue;
      }
    }

    if (emailBusiness && existing.has(emailBusiness)) {
      removed.push({
        first_name: firstName,
        last_name: lastName,
        company_name: companyName,
        email: emailBusiness,
        reason: "already_in_plusvibe"
      });
      continue;
    }

    if (emailBusiness) {
      working.push({
        index: i,
        raw,
        firstName,
        lastName,
        companyName,
        email: emailBusiness,
        emailSource: "csv"
      });
    } else if (!skipTrykitt) {
      needTrykitt.push({ key: i, raw, firstName, lastName, companyName });
    } else {
      removed.push({
        first_name: firstName,
        last_name: lastName,
        company_name: companyName,
        email: "",
        reason: "no_email_found"
      });
    }
  }

  console.log(`[sop] working_csv=${working.length} need_trykitt=${needTrykitt.length} removed_so_far=${removed.length}`);

  if (needTrykitt.length) {
    console.log(`[sop] TryKitt batch for ${needTrykitt.length} leads...`);
    const found = await findEmailsBatch(
      needTrykitt.map((n) => ({
        key: n.key,
        firstName: n.firstName,
        lastName: n.lastName,
        companyName: n.companyName,
        companyWebsite: n.raw.company_website,
        companyLinkedin: n.raw.company_linkedin,
        personLinkedin: n.raw.linkedin
      })),
      { submitConcurrency: 15, pollConcurrency: 25 }
    );

    const verifyTargets: Array<{ key: number; email: string }> = [];
    for (const n of needTrykitt) {
      const hit = found.get(n.key);
      const email = hit?.email?.toLowerCase() ?? "";
      if (!email) {
        removed.push({
          first_name: n.firstName,
          last_name: n.lastName,
          company_name: n.companyName,
          email: "",
          reason: "no_email_found"
        });
        continue;
      }
      if (existing.has(email)) {
        removed.push({
          first_name: n.firstName,
          last_name: n.lastName,
          company_name: n.companyName,
          email,
          reason: "already_in_plusvibe"
        });
        continue;
      }
      verifyTargets.push({ key: n.key, email });
    }

    console.log(`[sop] verifying ${verifyTargets.length} TryKitt emails...`);
    const verifyMap = new Map<number, boolean>();
    await mapPool(verifyTargets, 10, async (t) => {
      const v = await verifyEmail(t.email);
      verifyMap.set(t.key, v.accepted);
      return v;
    });

    const byKey = new Map(needTrykitt.map((n) => [n.key, n]));
    for (const t of verifyTargets) {
      const n = byKey.get(t.key)!;
      if (!verifyMap.get(t.key)) {
        removed.push({
          first_name: n.firstName,
          last_name: n.lastName,
          company_name: n.companyName,
          email: t.email,
          reason: "email_unverified"
        });
        continue;
      }
      working.push({
        index: t.key,
        raw: n.raw,
        firstName: n.firstName,
        lastName: n.lastName,
        companyName: n.companyName,
        email: t.email,
        emailSource: "trykit"
      });
    }
  }

  console.log(`[sop] enriching ${working.length} leads (concurrency=${openaiConcurrency})...`);

  type Enriched = Working & {
    talentType: string;
    buyerType: string;
    subject: string;
    emailBody: string;
    framework: number;
    wordCount: number;
    esp: Esp;
    routeSetting: string;
    campaignId: string;
    workspaceId: string;
  };

  const enriched: Enriched[] = [];

  await mapPool(working, openaiConcurrency, async (w, idx) => {
    const mx = await resolveMx(w.raw, w.email);
    if (mx.isSeg) {
      removed.push({
        first_name: w.firstName,
        last_name: w.lastName,
        company_name: w.companyName,
        email: w.email,
        reason: "security_gateway",
        detail: mx.mxData.slice(0, 120)
      });
      return;
    }

    if (googleOnly && mx.esp === "outlook") {
      removed.push({
        first_name: w.firstName,
        last_name: w.lastName,
        company_name: w.companyName,
        email: w.email,
        reason: "outlook_skipped",
        detail: mx.mxData.slice(0, 120)
      });
      return;
    }

    const tb = await enrichTalentAndBuyer({
      companyName: w.companyName,
      products: productsField(w.raw),
      description: cleanText(w.raw.company_description),
      industry: cleanText(w.raw.company_industry),
      title: cleanText(w.raw.title)
    });

    const email = skipCompose
      ? {
          subject: "{{first_name}}",
          body: "",
          framework: 0,
          wordCount: 0
        }
      : await composeStaffingSopEmail(
          {
            firstName: w.firstName,
            companyName: w.companyName,
            talentType: tb.talentType,
            buyerType: tb.buyerType,
            companyDescription: cleanText(w.raw.company_description),
            companyProductsServices: productsField(w.raw),
            rowIndex: w.index + idx
          },
          { fallbackOnly }
        );

    const esp = mx.esp;
    const isOutlook = esp === "outlook";
    const target = isOutlook ? config.campaigns.outlook : config.campaigns.google;
    const routeSetting =
      cleanText(w.raw.domain_settings) ||
      (esp === "google" ? "SMTP" : esp === "outlook" ? "CatchAll" : "SMTP");

    enriched.push({
      ...w,
      talentType: tb.talentType,
      buyerType: tb.buyerType,
      subject: email.subject,
      emailBody: email.body,
      framework: email.framework,
      wordCount: email.wordCount,
      esp,
      routeSetting,
      campaignId: target.campaignId,
      workspaceId: target.workspaceId
    });

    if ((enriched.length + removed.length) % 50 === 0) {
      console.log(`[sop] progress enriched=${enriched.length} removed=${removed.length}`);
    }
  });

  // stable order
  enriched.sort((a, b) => a.index - b.index);

  for (const e of enriched) {
    const payload = buildPayload({
      raw: e.raw,
      firstName: e.firstName,
      lastName: e.lastName,
      companyName: e.companyName,
      activeEmail: e.email,
      emailSource: e.emailSource,
      talentType: e.talentType,
      buyerType: e.buyerType,
      subject: e.subject,
      emailBody: e.emailBody,
      framework: e.framework,
      wordCount: e.wordCount,
      esp: e.esp,
      routeSetting: e.routeSetting
    });

    const row: UploadedLead = {
      first_name: e.firstName,
      last_name: e.lastName,
      email: e.email,
      company_name: e.companyName,
      talent_type: e.talentType,
      buyer_type: e.buyerType,
      subject: e.subject,
      email_body: e.emailBody,
      framework: String(e.framework),
      word_count: String(e.wordCount),
      city: cleanText(e.raw.city),
      state: cleanText(e.raw.state),
      linkedin: cleanText(e.raw.linkedin),
      company_website: cleanText(e.raw.company_website),
      esp: e.esp,
      domain_settings: e.routeSetting,
      email_source: e.emailSource,
      plusvibe_workspace_id: e.workspaceId,
      plusvibe_campaign_id: e.campaignId,
      upload_ok: dryRun ? "dry_run" : "pending",
      upload_error: ""
    };

    if (e.esp === "outlook") outlookPayloads.push(payload);
    else googlePayloads.push(payload);
    uploaded.push(row);
  }

  console.log(
    `[sop] ready google=${googlePayloads.length} outlook=${outlookPayloads.length} removed=${removed.length}`
  );

  async function uploadBucket(
    label: string,
    payloads: PlusVibeLeadPayload[],
    workspaceId: string,
    campaignId: string
  ): Promise<{ ok: number; fail: number }> {
    let ok = 0;
    let fail = 0;
    if (dryRun) {
      console.log(`[sop] dry-run skip upload ${label} x${payloads.length}`);
      return { ok: payloads.length, fail: 0 };
    }
    for (let i = 0; i < payloads.length; i += uploadBatchSize) {
      const batch = payloads.slice(i, i + uploadBatchSize);
      const result = await uploadLeadsBatch(batch, { workspaceId, campaignId });
      if (result.ok) {
        ok += batch.length;
        for (const p of batch) {
          const row = uploaded.find((u) => u.email === p.email && u.plusvibe_campaign_id === campaignId);
          if (row) row.upload_ok = "true";
        }
      } else {
        fail += batch.length;
        for (const p of batch) {
          const row = uploaded.find((u) => u.email === p.email && u.plusvibe_campaign_id === campaignId);
          if (row) {
            row.upload_ok = "false";
            row.upload_error = result.error;
          }
        }
        console.warn(`[sop] upload fail ${label} batch@${i}: ${result.error}`);
      }
      console.log(`[sop] uploaded ${label} ${Math.min(i + batch.length, payloads.length)}/${payloads.length}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    return { ok, fail };
  }

  const g = await uploadBucket(
    "google",
    googlePayloads,
    config.campaigns.google.workspaceId,
    config.campaigns.google.campaignId
  );
  const o = googleOnly
    ? { ok: 0, fail: 0 }
    : await uploadBucket(
        "outlook",
        outlookPayloads,
        config.campaigns.outlook.workspaceId,
        config.campaigns.outlook.campaignId
      );
  if (googleOnly && outlookPayloads.length) {
    console.log(`[sop] google-only: skipped outlook upload x${outlookPayloads.length}`);
  }

  fs.writeFileSync(path.join(outDir, "uploaded_leads.csv"), stringify(uploaded, { header: true }));
  fs.writeFileSync(path.join(outDir, "removed_leads.csv"), stringify(removed, { header: true }));
  const summary = {
    timestamp: new Date().toISOString(),
    input,
    dry_run: dryRun,
    existing_excluded_pool: existing.size,
    sheet_rows: leads.length,
    enriched: enriched.length,
    google_payloads: googlePayloads.length,
    outlook_payloads: outlookPayloads.length,
    removed: removed.length,
    removed_by_reason: removed.reduce<Record<string, number>>((acc, r) => {
      acc[r.reason] = (acc[r.reason] ?? 0) + 1;
      return acc;
    }, {}),
    google_upload_ok: g.ok,
    google_upload_fail: g.fail,
    outlook_upload_ok: o.ok,
    outlook_upload_fail: o.fail,
    campaigns: config.campaigns
  };
  fs.writeFileSync(path.join(outDir, "run_summary.json"), JSON.stringify(summary, null, 2));
  console.log("[sop] summary", JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
