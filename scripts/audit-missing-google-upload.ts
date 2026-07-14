/**
 * Audit all Welltech sheets for Google/Others leads missing from PlusVibe campaign,
 * then enrich + upload only the gaps.
 *
 * Usage:
 *   npx tsx scripts/audit-missing-google-upload.ts
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { classifyMx, cleanText, resolveLeadDomain } from "../functions/classifyMx.js";
import { isCatchAllDomainSetting, normalizeDomainSetting } from "../functions/normalizeDomainSetting.js";
import { enrichFacilityAndTalent } from "../functions/enrichFacilityAndTalent.js";
import { generateColdEmail } from "../functions/generateColdEmail.js";
import { normalizeCompany } from "../functions/normalizeCompany.js";
import { classifyCompanyType } from "../functions/classifyCompanyType.js";
import { findEmail } from "../functions/findEmail.js";
import { verifyEmail } from "../functions/verifyEmail.js";
import { uploadLead, type PlusVibeLeadPayload } from "../integrations/plusvibe.js";
import { mapPool } from "../functions/mapPool.js";

const WORKSPACE_ID = "68cc548e33b6c342f85bd2d9";
const CAMPAIGN_ID = "6a439e56fec820c456968378";
const SHEET_FILES = [
  { sheet: "Sheet1", file: "/tmp/welltech_sheet1_audit.csv" },
  { sheet: "Sheet2", file: "/tmp/welltech_sheet2_audit.csv" },
  { sheet: "Sheet3", file: "/tmp/welltech_sheet3_audit.csv" },
  { sheet: "Sheet4", file: "/tmp/welltech_sheet4_audit.csv" },
  { sheet: "Sheet5", file: "/tmp/welltech_sheet5_audit.csv" },
  { sheet: "Sheet6", file: "/tmp/welltech_sheet6_audit.csv" }
];

type Row = Record<string, string> & { __sheet?: string; __row?: number };

function normalizeHeaderRow(raw: Record<string, string>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k.trim().toLowerCase().replace(/\s+/g, "_")] = v;
  }
  return out;
}

function mxHeuristic(mxRaw: string, espFromDns?: string): "google" | "outlook" | "others" | "empty" | "unknown" {
  const mx = mxRaw.toLowerCase();
  if (!mx && !espFromDns) return "empty";
  if (
    mx.includes("google") ||
    mx.includes("googlemail") ||
    mx.includes("aspmx") ||
    mx.includes("gmail") ||
    mx.includes("gsuite")
  ) {
    return "google";
  }
  if (
    mx.includes("outlook") ||
    mx.includes("office365") ||
    mx.includes("microsoft") ||
    mx.includes("hotmail") ||
    mx.includes("protection.outlook.com")
  ) {
    return "outlook";
  }
  if (espFromDns) return espFromDns as "google" | "outlook" | "others" | "empty";
  if (mx) return "others";
  return "unknown";
}

function getPlusVibeClient() {
  const apiKey = process.env.PLUSVIBE_KEY;
  if (!apiKey) throw new Error("PLUSVIBE_KEY required");
  return axios.create({
    baseURL: process.env.PLUSVIBE_BASE_URL ?? "https://api.plusvibe.ai",
    timeout: 30_000,
    headers: {
      "x-api-key": apiKey,
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function probeInCampaign(email: string): Promise<"in_campaign" | "missing" | "error"> {
  const client = getPlusVibeClient();
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const { data } = await client.post("/api/v1/lead/add", {
        workspace_id: WORKSPACE_ID,
        campaign_id: CAMPAIGN_ID,
        leads: [{ email }]
      });
      const uploaded = Number(data?.leads_uploaded ?? 0);
      if (uploaded > 0) {
        // Was missing; remove bare probe so we can re-add with enrichments.
        for (let dAttempt = 1; dAttempt <= 4; dAttempt++) {
          try {
            await client.post("/api/v1/lead/delete", {
              workspace_id: WORKSPACE_ID,
              campaign_id: CAMPAIGN_ID,
              delete_list: [email]
            });
            break;
          } catch (delErr: unknown) {
            const status = axios.isAxiosError(delErr) ? delErr.response?.status : undefined;
            if (status === 429 && dAttempt < 4) {
              await sleep(1500 * 2 ** (dAttempt - 1));
              continue;
            }
            console.warn(`[probe] delete failed for ${email}: ${(delErr as Error).message}`);
          }
        }
        return "missing";
      }
      return "in_campaign";
    } catch (err: unknown) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if ((status === 429 || status === 503) && attempt < 6) {
        const wait = 2000 * 2 ** (attempt - 1);
        await sleep(wait);
        continue;
      }
      console.warn(`[probe] error ${email}: ${(err as Error).message}`);
      return "error";
    }
  }
  return "error";
}

async function enrichAndUpload(row: Row, activeEmail: string): Promise<{ ok: boolean; error?: string }> {
  const companyNameNormalized = await normalizeCompany(row.company_name || row.organization);
  await classifyCompanyType({
    companyNameNormalized,
    companyDescription: row.company_description,
    companyProductsServices: row.company_product_and_services || row.company_products_services
  });
  const facilityTalent = await enrichFacilityAndTalent({
    companyNameNormalized,
    companyDescription: row.company_description,
    companyProductsServices: row.company_product_and_services || row.company_products_services,
    title: row.title
  });
  const coldEmail = await generateColdEmail({
    firstName: row.first_name,
    companyName: row.company_name || row.organization,
    companyNameNormalized,
    title: row.title,
    city: row.city,
    state: row.state,
    companySize: row.company_size || row.company_employee_count,
    companyProductsServices: row.company_product_and_services || row.company_products_services,
    companyDescription: row.company_description,
    facilityType: facilityTalent.facilityType,
    talentType: facilityTalent.talentType,
    email: activeEmail
  });

  const payload: PlusVibeLeadPayload = {
    email: activeEmail,
    first_name: cleanText(row.first_name) || undefined,
    last_name: cleanText(row.last_name) || undefined,
    company_name: companyNameNormalized || cleanText(row.company_name || row.organization) || undefined,
    company_website: cleanText(row.company_website) || undefined,
    linkedin_person_url: cleanText(row.linkedin) || undefined,
    linkedin_company_url: cleanText(row.company_linkedin) || undefined,
    city: cleanText(row.city) || undefined,
    country: cleanText(row.country) || undefined,
    custom_variables: {
      facility_type: facilityTalent.facilityType || "",
      talent_type: facilityTalent.talentType || "",
      cold_email: coldEmail || "",
      custom_facility_type: facilityTalent.facilityType || "",
      custom_talent_type: facilityTalent.talentType || "",
      custom_cold_email: coldEmail || "",
      first_name: cleanText(row.first_name) || "",
      last_name: cleanText(row.last_name) || "",
      linkedin: cleanText(row.linkedin) || "",
      company_name: companyNameNormalized || cleanText(row.company_name || row.organization) || "",
      company_website: cleanText(row.company_website) || "",
      company_linkedin: cleanText(row.company_linkedin) || "",
      title: cleanText(row.title) || "",
      city: cleanText(row.city) || "",
      state: cleanText(row.state) || "",
      country: cleanText(row.country) || ""
    }
  };

  const upload = await uploadLead(payload, { workspaceId: WORKSPACE_ID, campaignId: CAMPAIGN_ID });
  if (!upload.ok) return { ok: false, error: upload.error };
  return { ok: true };
}

async function main(): Promise<void> {
  const outDir = path.resolve(`run_outputs_missing_google_${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`);
  fs.mkdirSync(outDir, { recursive: true });

  const allRows: Row[] = [];
  for (const s of SHEET_FILES) {
    if (!fs.existsSync(s.file)) throw new Error(`Missing ${s.file}`);
    const text = fs.readFileSync(s.file, "utf-8");
    const records = parse(text, { columns: true, skip_empty_lines: true, bom: true }) as Record<string, string>[];
    records.forEach((r, i) => {
      const row = normalizeHeaderRow(r);
      row.__sheet = s.sheet;
      row.__row = i;
      allRows.push(row);
    });
    console.log(`[audit] loaded ${s.sheet}: ${records.length}`);
  }
  console.log(`[audit] total rows across sheets: ${allRows.length}`);

  // Stage 1: keep SMTP-eligible (not catchall)
  const smtpRows = allRows.filter((r) => !isCatchAllDomainSetting(r.domain_settings));
  const catchallSkipped = allRows.length - smtpRows.length;
  console.log(`[audit] smtp-eligible (non-catchall): ${smtpRows.length}; catchall_skipped=${catchallSkipped}`);

  // Stage 2: ESP classify (heuristic from MX Records, DNS fallback when needed)
  const mxCache = new Map<string, Awaited<ReturnType<typeof classifyMx>>>();
  const classified = await mapPool(smtpRows, 20, async (row) => {
    const email = cleanText(row.email_business);
    const domain = resolveLeadDomain(email, row.company_website || row.domain);
    const heur = mxHeuristic(cleanText(row.mx_records));
    let esp = heur;
    let isSeg = false;
    if (heur === "unknown" || heur === "empty" || heur === "others") {
      // Confirm others/empty via DNS; also catch SEG gateways.
      if (domain) {
        let mx = mxCache.get(domain);
        if (!mx) {
          try {
            mx = await classifyMx(domain);
          } catch {
            mx = { domain, mxData: "", esp: "empty", isSeg: false };
          }
          mxCache.set(domain, mx);
        }
        esp = mx.esp;
        isSeg = mx.isSeg;
      }
    } else if (domain && (heur === "google" || heur === "outlook")) {
      // Still check SEG for google/outlook-looking hosts that are behind gateways (rare)
      // Skip DNS to save time for clear google/outlook.
    }
    return { row, email, domain, esp, isSeg };
  });

  const byEsp: Record<string, number> = {};
  for (const c of classified) {
    const key = c.isSeg ? "security_gateway" : c.esp;
    byEsp[key] = (byEsp[key] || 0) + 1;
  }
  console.log(`[audit] ESP breakdown (non-catchall):`, byEsp);

  const googleOthers = classified.filter(
    (c) => !c.isSeg && (c.esp === "google" || c.esp === "others")
  );
  console.log(`[audit] google/others candidates: ${googleOthers.length}`);

  // Stage 3: probe emails already present in campaign
  const withEmail = googleOthers.filter((c) => !!c.email);
  const withoutEmail = googleOthers.filter((c) => !c.email);
  console.log(`[audit] with email=${withEmail.length} without email=${withoutEmail.length}`);

  const probeConcurrency = Math.max(1, Number(process.env.PROBE_CONCURRENCY) || 3);
  let probed = 0;
  const probeResults = await mapPool(withEmail, probeConcurrency, async (c) => {
    const status = await probeInCampaign(c.email);
    probed++;
    if (probed % 100 === 0) console.log(`[probe] ${probed}/${withEmail.length}`);
    return { ...c, status };
  });

  const already = probeResults.filter((p) => p.status === "in_campaign");
  const missingEmailed = probeResults.filter((p) => p.status === "missing");
  const probeErrors = probeResults.filter((p) => p.status === "error");
  console.log(
    `[audit] already_in_campaign=${already.length} missing_emailed=${missingEmailed.length} probe_errors=${probeErrors.length}`
  );

  // Stage 4: enrich+upload missing emailed + try find email for no-email candidates
  const uploadTargets: Array<{ row: Row; email: string; source: string; sheet: string }> = [];

  for (const m of missingEmailed) {
    uploadTargets.push({
      row: m.row,
      email: m.email,
      source: "csv",
      sheet: m.row.__sheet || ""
    });
  }

  const emailedOnly = process.argv.includes("--emailed-only");
  let found: Array<{
    row: Row;
    email: string;
    source: string;
    sheet: string;
  } | null> = [];
  if (emailedOnly) {
    console.log(`[find] skipped no-email TryKitt pass (--emailed-only); candidates=${withoutEmail.length}`);
  } else {
    console.log(`[find] resolving emails for ${withoutEmail.length} no-email google/others candidates`);
    found = await mapPool(withoutEmail, 4, async (c) => {
      const foundEmail = await findEmail({
        firstName: c.row.first_name,
        lastName: c.row.last_name,
        companyName: c.row.company_name || c.row.organization,
        companyWebsite: c.row.company_website,
        companyLinkedin: c.row.company_linkedin,
        personLinkedin: c.row.linkedin
      });
      if (!foundEmail.email) return null;
      const verify = await verifyEmail(foundEmail.email);
      if (!verify.accepted) return null;
      // Check if already in campaign
      const status = await probeInCampaign(foundEmail.email);
      if (status !== "missing") return null;
      return {
        row: c.row,
        email: foundEmail.email,
        source: foundEmail.source || "trykit",
        sheet: c.row.__sheet || ""
      };
    });
    for (const f of found) {
      if (f) uploadTargets.push(f);
    }
  }

  console.log(`[upload] enriching + uploading ${uploadTargets.length} missing leads`);
  const uploadConcurrency = Math.max(1, Number(process.env.ROW_CONCURRENCY) || 6);
  let done = 0;
  const results = await mapPool(uploadTargets, uploadConcurrency, async (t) => {
    try {
      const res = await enrichAndUpload(t.row, t.email);
      done++;
      if (done % 25 === 0) console.log(`[upload] ${done}/${uploadTargets.length}`);
      return {
        sheet: t.sheet,
        email: t.email,
        source: t.source,
        company: cleanText(t.row.company_name || t.row.organization),
        first_name: cleanText(t.row.first_name),
        last_name: cleanText(t.row.last_name),
        upload_ok: res.ok ? "true" : "false",
        error: res.error || ""
      };
    } catch (err) {
      done++;
      return {
        sheet: t.sheet,
        email: t.email,
        source: t.source,
        company: cleanText(t.row.company_name || t.row.organization),
        first_name: cleanText(t.row.first_name),
        last_name: cleanText(t.row.last_name),
        upload_ok: "false",
        error: (err as Error).message
      };
    }
  });

  const uploadedOk = results.filter((r) => r.upload_ok === "true").length;
  const uploadedFail = results.length - uploadedOk;

  const bySheetMissing: Record<string, number> = {};
  for (const t of uploadTargets) {
    bySheetMissing[t.sheet] = (bySheetMissing[t.sheet] || 0) + 1;
  }
  const bySheetAlready: Record<string, number> = {};
  for (const a of already) {
    const s = a.row.__sheet || "";
    bySheetAlready[s] = (bySheetAlready[s] || 0) + 1;
  }

  const summary = {
    timestamp: new Date().toISOString(),
    campaign_id: CAMPAIGN_ID,
    totals: {
      input_all_sheets: allRows.length,
      catchall_skipped: catchallSkipped,
      smtp_eligible: smtpRows.length,
      google_others_candidates: googleOthers.length,
      with_email: withEmail.length,
      without_email: withoutEmail.length,
      already_in_campaign: already.length,
      missing_emailed_found: missingEmailed.length,
      missing_found_via_trykitt: found.filter(Boolean).length,
      missing_total_queued: uploadTargets.length,
      uploaded_ok: uploadedOk,
      uploaded_failed: uploadedFail,
      probe_errors: probeErrors.length
    },
    esp_breakdown_non_catchall: byEsp,
    missing_by_sheet: bySheetMissing,
    already_by_sheet: bySheetAlready
  };

  fs.writeFileSync(path.join(outDir, "missing_audit_summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, "missing_uploads.csv"), stringify(results, { header: true }));
  fs.writeFileSync(
    path.join(outDir, "already_in_campaign_sample.csv"),
    stringify(
      already.slice(0, 50).map((a) => ({
        sheet: a.row.__sheet,
        email: a.email,
        company: cleanText(a.row.company_name || a.row.organization),
        esp: a.esp
      })),
      { header: true }
    )
  );

  console.log("\n=== AUDIT SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nArtifacts: ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
