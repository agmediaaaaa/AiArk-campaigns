import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import {
  classifyMx,
  cleanText,
  domainFromEmail,
  resolveLeadDomain,
  type Esp
} from "../functions/classifyMx.js";
import { normalizeCompany } from "../functions/normalizeCompany.js";
import { enrichConstructionTalent } from "../functions/enrichConstructionTalent.js";
import { findEmail, findEmailsBatch, type FindEmailResult } from "../functions/findEmail.js";
import { verifyEmail } from "../functions/verifyEmail.js";
import { generateGcColdEmail, pickCandidateCount, type HumanizerMode } from "../functions/generateGcColdEmail.js";
import { uploadLead, type PlusVibeLeadPayload } from "../integrations/plusvibe.js";
import { mapPool } from "../functions/mapPool.js";

type LeadRow = Record<string, string>;

type GcConfig = {
  vertical: string;
  campaigns: {
    googleOthers: { workspaceId: string; campaignId: string };
    outlook: { workspaceId: string; campaignId: string };
  };
  limits?: { rowConcurrency?: number };
};

type EspMode = "google-others" | "outlook" | "auto";

type ProcessOptions = {
  espMode: EspMode;
  humanizerMode: HumanizerMode;
  trykittCache?: Map<number, FindEmailResult>;
};

type RemovedLead = {
  reason: string;
  email: string;
  domain: string;
  esp: string;
  first_name: string;
  last_name: string;
  company_name: string;
  detail?: string;
};

type EnrichedLead = {
  first_name: string;
  last_name: string;
  title: string;
  email: string;
  email_source: "csv" | "trykit";
  email_verification_status: string;
  esp_classification: string;
  company_name: string;
  company_name_normalized: string;
  company_type: string;
  talent_type: string;
  candidate_count: number;
  cold_email_html: string;
  cold_email_plain: string;
  humanizer_pass: boolean;
  humanizer_score: number;
  humanizer_attempts: number;
  company_website: string;
  company_linkedin: string;
  linkedin: string;
  city: string;
  state: string;
  country: string;
  company_size: string;
  upload_ok: boolean;
  upload_error: string;
};

const GOOGLE_OTHERS_ESP: ReadonlySet<Esp> = new Set(["google", "others"]);
const OUTLOOK_ESP: ReadonlySet<Esp> = new Set(["outlook"]);

function resolveHumanizerMode(): HumanizerMode {
  const raw = argValue("--humanizer-mode") ?? "strict";
  if (raw === "strict" || raw === "relaxed") return raw;
  throw new Error(`Invalid --humanizer-mode ${raw}; use strict or relaxed`);
}

function resolveEspMode(): EspMode {
  const raw = argValue("--esp-mode") ?? "auto";
  if (raw === "google-others" || raw === "outlook" || raw === "auto") return raw;
  throw new Error(`Invalid --esp-mode ${raw}; use google-others, outlook, or auto`);
}

function isEspEligible(esp: Esp, mode: EspMode): boolean {
  if (mode === "google-others") return GOOGLE_OTHERS_ESP.has(esp);
  if (mode === "outlook") return OUTLOOK_ESP.has(esp);
  return GOOGLE_OTHERS_ESP.has(esp) || OUTLOOK_ESP.has(esp);
}

function resolveUploadTarget(
  esp: Esp,
  config: GcConfig
): { workspaceId: string; campaignId: string } {
  if (esp === "outlook") return config.campaigns.outlook;
  return config.campaigns.googleOthers;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function readConfig(p: string): GcConfig {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as GcConfig;
}

function readLeadsCsv(p: string): LeadRow[] {
  const text = fs.readFileSync(p, "utf-8");
  return parse(text, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_")),
    skip_empty_lines: true,
    trim: true,
    bom: true
  }) as LeadRow[];
}

function leadNeedsTryKitt(raw: LeadRow): boolean {
  return !cleanText(raw.email_business);
}

async function processLead(
  raw: LeadRow,
  config: GcConfig,
  globalIndex: number,
  total: number,
  opts: ProcessOptions
): Promise<{ kind: "removed"; row: RemovedLead } | { kind: "enriched"; row: EnrichedLead }> {
  const tag = `[${globalIndex + 1}/${total}]`;
  const trykittCache = opts.trykittCache;
  const firstName = cleanText(raw.first_name);
  const lastName = cleanText(raw.last_name);
  const companyName = cleanText(raw.company_name);
  const emailBusiness = cleanText(raw.email_business);
  const domain = resolveLeadDomain(emailBusiness, raw.company_website);

  let mx;
  try {
    mx = await classifyMx(domain);
  } catch (err) {
    console.warn(`${tag} mx error: ${(err as Error).message}`);
    mx = { domain, mxData: "", esp: "empty" as const, isSeg: false };
  }

  if (mx.isSeg) {
    return {
      kind: "removed",
      row: {
        reason: "security_gateway",
        email: emailBusiness,
        domain,
        esp: mx.esp,
        first_name: firstName,
        last_name: lastName,
        company_name: companyName,
        detail: mx.mxData
      }
    };
  }

  if (!isEspEligible(mx.esp, opts.espMode)) {
    const reason =
      mx.esp === "outlook" && opts.espMode === "google-others"
        ? "outlook_not_eligible"
        : mx.esp !== "outlook" && opts.espMode === "outlook"
          ? "non_outlook_not_eligible"
          : "esp_not_eligible";
    return {
      kind: "removed",
      row: {
        reason,
        email: emailBusiness,
        domain,
        esp: mx.esp,
        first_name: firstName,
        last_name: lastName,
        company_name: companyName,
        detail: `ESP ${mx.esp} not eligible for mode ${opts.espMode}`
      }
    };
  }

  const uploadTarget = resolveUploadTarget(mx.esp, config);

  let activeEmail = "";
  let emailSource: "csv" | "trykit" = "csv";
  let verificationStatus = "";

  if (emailBusiness) {
    activeEmail = emailBusiness.toLowerCase();
    emailSource = "csv";
  } else {
    const cached = trykittCache?.get(globalIndex);
    const found =
      cached ??
      (await findEmail({
        firstName: raw.first_name,
        lastName: raw.last_name,
        companyName: raw.company_name,
        companyWebsite: raw.company_website,
        companyLinkedin: raw.company_linkedin,
        personLinkedin: raw.linkedin
      }));

    if (!found.email) {
      return {
        kind: "removed",
        row: {
          reason: "no_email_found",
          email: "",
          domain: found.domainUsed || domain,
          esp: mx.esp,
          first_name: firstName,
          last_name: lastName,
          company_name: companyName
        }
      };
    }

    const verify = await verifyEmail(found.email);
    verificationStatus = verify.status;
    if (!verify.accepted) {
      return {
        kind: "removed",
        row: {
          reason: "email_unverified",
          email: found.email,
          domain: domainFromEmail(found.email),
          esp: mx.esp,
          first_name: firstName,
          last_name: lastName,
          company_name: companyName,
          detail: verify.status
        }
      };
    }

    activeEmail = found.email.toLowerCase();
    emailSource = "trykit";
  }

  const companyNameNormalized = await normalizeCompany(raw.company_name);
  const construction = await enrichConstructionTalent({
    companyNameNormalized,
    companyDescription: raw.company_description,
    companyProductsServices: raw.company_products_services,
    title: raw.title,
    city: raw.city,
    state: raw.state,
    companySize: raw.company_size || raw.company_employee_count
  });

  const candidateCount = pickCandidateCount(`${activeEmail}:${companyNameNormalized}`);
  const coldEmail = await generateGcColdEmail(
    {
      firstName,
      lastName,
      title: cleanText(raw.title),
      companyName,
      companyNameNormalized,
      companyDescription: raw.company_description,
      companyProductsServices: raw.company_products_services,
      companySize: cleanText(raw.company_size || raw.company_employee_count),
      city: cleanText(raw.city),
      state: cleanText(raw.state),
      companyType: construction.companyType,
      talentType: construction.talentType,
      candidateCount
    },
    { humanizerMode: opts.humanizerMode }
  );

  if (!coldEmail.humanizer.pass) {
    console.warn(
      `${tag} ${firstName} ${lastName} humanizer did not pass after ${coldEmail.attempts} attempts (score=${coldEmail.humanizer.score}) — skipping upload`
    );
    return {
      kind: "removed",
      row: {
        reason: "humanizer_failed",
        email: activeEmail,
        domain: domainFromEmail(activeEmail),
        esp: mx.esp,
        first_name: firstName,
        last_name: lastName,
        company_name: companyName,
        detail:
          coldEmail.humanizer.issues.join("; ") ||
          `score=${coldEmail.humanizer.score}`
      }
    };
  }

  const payload: PlusVibeLeadPayload = {
    email: activeEmail,
    first_name: firstName || undefined,
    last_name: lastName || undefined,
    company_name: companyNameNormalized || companyName || undefined,
    company_website: cleanText(raw.company_website) || undefined,
    linkedin_person_url: cleanText(raw.linkedin) || undefined,
    linkedin_company_url: cleanText(raw.company_linkedin) || undefined,
    city: cleanText(raw.city) || undefined,
    country: cleanText(raw.country) || undefined,
    custom_variables: {
      custom_cold_email: coldEmail.coldEmailHtml,
      custom_talent_type: construction.talentType,
      custom_company_type: construction.companyType,
      custom_candidate_count: String(candidateCount),
      custom_title: cleanText(raw.title),
      custom_state: cleanText(raw.state),
      custom_esp: mx.esp,
      custom_humanizer_pass: coldEmail.humanizer.pass ? "true" : "false"
    }
  };

  const upload = await uploadLead(payload, uploadTarget);

  console.log(
    `${tag} ${firstName} ${lastName} @ ${companyName} | ${activeEmail} | esp=${mx.esp} | campaign=${uploadTarget.campaignId} | humanizer=${coldEmail.humanizer.pass} | upload=${upload.ok}`
  );

  return {
    kind: "enriched",
    row: {
      first_name: firstName,
      last_name: lastName,
      title: cleanText(raw.title),
      email: activeEmail,
      email_source: emailSource,
      email_verification_status: verificationStatus,
      esp_classification: mx.esp,
      company_name: companyName,
      company_name_normalized: companyNameNormalized,
      company_type: construction.companyType,
      talent_type: construction.talentType,
      candidate_count: candidateCount,
      cold_email_html: coldEmail.coldEmailHtml,
      cold_email_plain: coldEmail.coldEmailPlain,
      humanizer_pass: coldEmail.humanizer.pass,
      humanizer_score: coldEmail.humanizer.score,
      humanizer_attempts: coldEmail.attempts,
      company_website: cleanText(raw.company_website),
      company_linkedin: cleanText(raw.company_linkedin),
      linkedin: cleanText(raw.linkedin),
      city: cleanText(raw.city),
      state: cleanText(raw.state),
      country: cleanText(raw.country),
      company_size: cleanText(raw.company_size || raw.company_employee_count),
      upload_ok: upload.ok,
      upload_error: upload.ok ? "" : upload.error
    }
  };
}

async function run(): Promise<void> {
  const input = argValue("--input") ?? "data/leads.csv";
  const configPath = argValue("--config") ?? "configs/gc_campaign.json";
  const pilot = Number(argValue("--pilot") ?? "0");
  const outDir = argValue("--output") ?? `run_outputs_gc_${Date.now()}`;
  const espMode = resolveEspMode();
  const humanizerMode = resolveHumanizerMode();

  for (const key of ["OPENAI_API_KEY", "TRYKITT_API_KEY", "MILLIONVERIFIER_API_KEY", "PLUSVIBE_KEY"]) {
    if (!process.env[key]) {
      throw new Error(`${key} is required`);
    }
  }

  const config = readConfig(configPath);
  const leadsAll = readLeadsCsv(input);
  const leads = pilot > 0 ? leadsAll.slice(0, pilot) : leadsAll;

  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[gc-campaign] vertical=${config.vertical}`);
  console.log(`[gc-campaign] esp-mode=${espMode}`);
  console.log(`[gc-campaign] humanizer-mode=${humanizerMode}`);
  console.log(`[gc-campaign] leads=${leads.length}/${leadsAll.length}`);
  console.log(
    `[gc-campaign] google/others campaign=${config.campaigns.googleOthers.campaignId}`
  );
  console.log(`[gc-campaign] outlook campaign=${config.campaigns.outlook.campaignId}`);

  const trykittCache = new Map<number, FindEmailResult>();
  const trykittItems = leads
    .map((raw, i) => ({ raw, i }))
    .filter(({ raw }) => leadNeedsTryKitt(raw))
    .map(({ raw, i }) => ({
      key: i,
      firstName: raw.first_name,
      lastName: raw.last_name,
      companyName: raw.company_name,
      companyWebsite: raw.company_website,
      personLinkedin: raw.linkedin
    }));

  if (trykittItems.length > 0) {
    console.log(`[gc-campaign] trykitt prefetch: ${trykittItems.length} jobs`);
    const batch = await findEmailsBatch(trykittItems);
    for (const [key, result] of batch) {
      trykittCache.set(Number(key), result);
    }
    const found = [...batch.values()].filter((r) => r.email).length;
    console.log(`[gc-campaign] trykitt done: ${found}/${trykittItems.length} found`);
  }

  const concurrency =
    config.limits?.rowConcurrency ?? (Number(process.env.ROW_CONCURRENCY) || 5);
  console.log(`[gc-campaign] concurrency=${concurrency}`);

  const outcomes = await mapPool(leads, concurrency, async (raw, i) => {
    try {
      return await processLead(raw, config, i, leads.length, { espMode, humanizerMode, trykittCache });
    } catch (err) {
      const firstName = cleanText(raw.first_name);
      const lastName = cleanText(raw.last_name);
      const companyName = cleanText(raw.company_name);
      console.error(`[${i + 1}/${leads.length}] ${firstName} ${lastName} failed: ${(err as Error).message}`);
      return {
        kind: "removed" as const,
        row: {
          reason: "processing_error",
          email: cleanText(raw.email_business),
          domain: resolveLeadDomain(raw.email_business, raw.company_website),
          esp: "",
          first_name: firstName,
          last_name: lastName,
          company_name: companyName,
          detail: (err as Error).message
        }
      };
    }
  });

  const enriched: EnrichedLead[] = [];
  const removed: RemovedLead[] = [];
  const drops: Record<string, number> = {};

  for (const outcome of outcomes) {
    if (outcome.kind === "enriched") {
      enriched.push(outcome.row);
    } else {
      removed.push(outcome.row);
      drops[outcome.row.reason] = (drops[outcome.row.reason] ?? 0) + 1;
    }
  }

  const uploadedOk = enriched.filter((r) => r.upload_ok).length;
  const humanizerPass = enriched.filter((r) => r.humanizer_pass).length;

  fs.writeFileSync(path.join(outDir, "enriched_leads.csv"), stringify(enriched, { header: true }));
  fs.writeFileSync(path.join(outDir, "removed_leads.csv"), stringify(removed, { header: true }));

  const summary = {
    timestamp: new Date().toISOString(),
    input: leads.length,
    enriched: enriched.length,
    removed: removed.length,
    uploaded_ok: uploadedOk,
    uploaded_failed: enriched.length - uploadedOk,
    humanizer_pass: humanizerPass,
    humanizer_fail: enriched.length - humanizerPass,
    drops_by_reason: drops,
    esp_mode: espMode,
    humanizer_mode: humanizerMode,
    campaigns: config.campaigns
  };

  fs.writeFileSync(path.join(outDir, "run_summary.json"), JSON.stringify(summary, null, 2));
  console.log(`[gc-campaign] done. enriched=${enriched.length} uploaded=${uploadedOk} removed=${removed.length}`);
  console.log(`[gc-campaign] humanizer pass=${humanizerPass}/${enriched.length}`);
  console.log(`[gc-campaign] artifacts in ${outDir}`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
