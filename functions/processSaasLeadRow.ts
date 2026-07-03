import {
  classifyMx,
  cleanText,
  espFromMxData,
  isSegMxData,
  resolveLeadDomain
} from "./classifyMx.js";
import { findEmail, type FindEmailResult } from "./findEmail.js";
import { verifyEmail } from "./verifyEmail.js";
import {
  normalizeDomainSetting,
  normalizeSheetRow,
  type MaSheetRow,
  type PreparedMaLead
} from "./prepareMaSheet.js";
import {
  enrichSaasOutreachSequential,
  type SaasSequentialResult
} from "./enrichSaasOutreachSequential.js";
import { lookupLeadEmail } from "../integrations/supabase.js";

export type SaasRemovedLead = {
  reason:
    | "security_gateway"
    | "no_email_found"
    | "email_unverified"
    | "unknown_domain_setting"
    | "no_email"
    | "outlook_excluded"
    | "catchall_no_email";
  email: string;
  first_name: string;
  last_name: string;
  company_name: string;
  detail?: string;
};

export type SaasProcessedLead = {
  lead: PreparedMaLead;
  enriched: SaasSequentialResult;
  email_source: "csv" | "supabase" | "trykit";
  email_verification_status: string | null;
  mx_data: string;
};

export type SaasRowOutcome =
  | { ok: true; result: SaasProcessedLead }
  | { ok: false; removed: SaasRemovedLead };

export type ProcessSaasLeadOptions = {
  productDescription: string;
  trykittCache?: Map<number, FindEmailResult>;
  supabaseCache?: Map<number, string>;
  rowIndex?: number;
  skipEnrichment?: boolean;
  skipTryKitt?: boolean;
};

function toPreparedLead(
  r: MaSheetRow,
  activeEmail: string,
  domainSetting: "SMTP" | "CatchAll",
  esp: string,
  mxData: string
): PreparedMaLead {
  return {
    raw: r,
    first_name: cleanText(r.first_name),
    last_name: cleanText(r.last_name),
    title: cleanText(r.title),
    email_business: activeEmail.toLowerCase(),
    domain_settings: domainSetting,
    company_name: cleanText(r.company_name),
    company_name_normalized: cleanText(r.company_name_normalized) || cleanText(r.company_name),
    company_description: cleanText(r.company_description),
    company_products_services: cleanText(r.company_products_services),
    company_industry: cleanText(r.company_industry),
    company_size: cleanText(r.company_size),
    company_website: cleanText(r.company_website),
    company_linkedin: cleanText(r.company_linkedin),
    city: cleanText(r.city),
    state: cleanText(r.state),
    country: cleanText(r.country),
    linkedin: cleanText(r.linkedin),
    email_platform: esp,
    esp_classification: esp
  };
}

export function leadNeedsTryKitt(row: MaSheetRow): boolean {
  const r = normalizeSheetRow(row);
  if (cleanText(r.email_business)) return false;
  const setting = normalizeDomainSetting(r.domain_settings);
  if (setting === "CatchAll") return false;
  return setting === "SMTP" || setting === "";
}

export type SaasGateOutcome =
  | { ok: true; gated: Omit<SaasProcessedLead, "enriched"> }
  | { ok: false; removed: SaasRemovedLead };

function gateRemoved(
  reason: SaasRemovedLead["reason"],
  r: MaSheetRow,
  email: string,
  detail?: string
): SaasGateOutcome {
  return {
    ok: false,
    removed: {
      reason,
      email,
      first_name: cleanText(r.first_name),
      last_name: cleanText(r.last_name),
      company_name: cleanText(r.company_name),
      detail
    }
  };
}

export async function gateSaasLeadForPipeline(
  rawRow: MaSheetRow,
  opts: Pick<ProcessSaasLeadOptions, "trykittCache" | "supabaseCache" | "rowIndex" | "skipTryKitt"> = {}
): Promise<SaasGateOutcome> {
  const r = normalizeSheetRow(rawRow);
  const csvEmail = cleanText(r.email_business).toLowerCase();
  const domainSettingRaw = cleanText(r.domain_settings);
  let domainSetting = normalizeDomainSetting(domainSettingRaw);

  const companyWebsite = cleanText(r.company_website);
  const domain = resolveLeadDomain(csvEmail, companyWebsite);
  const sheetMx = cleanText(r.mx_records);

  let mxData = sheetMx;
  let esp = espFromMxData(sheetMx);
  let isSeg = isSegMxData(sheetMx);

  const resolvedDomain = domain || (csvEmail.includes("@") ? csvEmail.split("@")[1]! : "");
  if ((!sheetMx || esp === "empty") && resolvedDomain) {
    const mx = await classifyMx(resolvedDomain);
    if (!sheetMx) mxData = mx.mxData;
    esp = mx.esp;
    isSeg = mx.isSeg || isSeg;
  }

  if (isSeg) {
    return gateRemoved("security_gateway", r, csvEmail, mxData || domain);
  }

  if (esp === "outlook") {
    return gateRemoved("outlook_excluded", r, csvEmail, mxData || "outlook mx");
  }

  let activeEmail = "";
  let emailSource: SaasProcessedLead["email_source"] = "csv";
  let verificationStatus: string | null = null;

  if (csvEmail) {
    activeEmail = csvEmail;
    emailSource = "csv";
  } else if (opts.skipTryKitt) {
    return gateRemoved("no_email_found", r, "", "skipTryKitt: no Email Business");
  } else {
    if (domainSetting === "CatchAll") {
      return gateRemoved("catchall_no_email", r, "", "CatchAll row without Email Business");
    }

    const cachedDb =
      opts.rowIndex !== undefined ? opts.supabaseCache?.get(opts.rowIndex) : undefined;
    const fromDb =
      cachedDb ??
      (await lookupLeadEmail({
        firstName: r.first_name,
        lastName: r.last_name,
        companyName: r.company_name,
        linkedin: r.linkedin,
        companyWebsite: r.company_website
      }));

    if (fromDb) {
      const verify = await verifyEmail(fromDb);
      verificationStatus = verify.status;
      if (!verify.accepted) {
        return gateRemoved("email_unverified", r, fromDb, `supabase:${verify.status}`);
      }
      activeEmail = fromDb.toLowerCase();
      emailSource = "supabase";
      if (!domainSetting) domainSetting = "SMTP";
    } else {
      const cached =
        opts.rowIndex !== undefined ? opts.trykittCache?.get(opts.rowIndex) : undefined;
      const found =
        cached ??
        (await findEmail({
          firstName: r.first_name,
          lastName: r.last_name,
          companyName: r.company_name,
          companyWebsite: r.company_website,
          companyLinkedin: r.company_linkedin,
          personLinkedin: r.linkedin
        }));

      if (!found.email) {
        return gateRemoved("no_email_found", r, "", found.domainUsed || domain);
      }

      const verify = await verifyEmail(found.email);
      verificationStatus = verify.status;
      if (!verify.accepted) {
        return gateRemoved("email_unverified", r, found.email, verify.status);
      }

      activeEmail = found.email.toLowerCase();
      emailSource = "trykit";
      if (!domainSetting) domainSetting = "SMTP";
    }
  }

  if (!activeEmail) {
    return gateRemoved("no_email", r, "", "no active email after resolution");
  }

  if (!domainSetting) {
    return gateRemoved("unknown_domain_setting", r, activeEmail, domainSettingRaw || "(blank)");
  }

  const lead = toPreparedLead(r, activeEmail, domainSetting, esp, mxData);
  return {
    ok: true,
    gated: {
      lead,
      email_source: emailSource,
      email_verification_status: verificationStatus,
      mx_data: mxData
    }
  };
}

export async function processSaasLeadRow(
  rawRow: MaSheetRow,
  opts: ProcessSaasLeadOptions
): Promise<SaasRowOutcome> {
  const gate = await gateSaasLeadForPipeline(rawRow, opts);
  if (!gate.ok) return gate;

  if (opts.skipEnrichment) {
    return {
      ok: false,
      removed: {
        reason: "no_email",
        email: gate.gated.lead.email_business,
        first_name: gate.gated.lead.first_name,
        last_name: gate.gated.lead.last_name,
        company_name: gate.gated.lead.company_name,
        detail: "skipEnrichment without enriched payload"
      }
    };
  }

  const { lead } = gate.gated;
  const enriched = await enrichSaasOutreachSequential(
    {
      first_name: lead.first_name,
      last_name: lead.last_name,
      title: lead.title,
      company_name: lead.company_name,
      company_name_normalized: lead.company_name_normalized,
      company_description: lead.company_description,
      company_products_services: lead.company_products_services,
      company_industry: lead.company_industry,
      company_size: lead.company_size,
      city: lead.city,
      state: lead.state,
      country: lead.country,
      company_website: lead.company_website,
      company_linkedin: lead.company_linkedin
    },
    opts.productDescription
  );

  return {
    ok: true,
    result: {
      lead,
      enriched,
      email_source: gate.gated.email_source,
      email_verification_status: gate.gated.email_verification_status,
      mx_data: gate.gated.mx_data
    }
  };
}

export function toSupabaseLeadRow(result: SaasProcessedLead): import("../integrations/supabase.js").SupabaseLeadRow {
  const lead = result.lead;
  return {
    Email: lead.email_business,
    "First Name": lead.first_name || null,
    "Last Name": lead.last_name || null,
    Linkedin: lead.linkedin || null,
    "Company Name": result.enriched.company_name_normalized || lead.company_name || null,
    Website: lead.company_website || null
  };
}
