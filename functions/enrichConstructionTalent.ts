import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";

export type ConstructionTalentInput = {
  companyNameNormalized?: string;
  companyDescription?: string;
  companyProductsServices?: string;
  title?: string;
  city?: string;
  state?: string;
  companySize?: string;
};

export type ConstructionTalentOutput = {
  /** Maps to PlusVibe custom_facility_type */
  companyType: string;
  /** Maps to PlusVibe custom_talent_type */
  talentType: string;
};

const FACILITY_TYPES = [
  "Commercial GCs",
  "Custom Home Builders",
  "Heavy Civil Contractors",
  "Multi-Family Builders",
  "Subcontractors"
] as const;

const TALENT_TYPES = [
  "Superintendents",
  "Project Managers",
  "Estimators",
  "Field Foremen",
  "Skilled Carpenters"
] as const;

const PROMPT = (input: ConstructionTalentInput) => `You classify construction companies for recruiting outreach.
Return exactly two lines in this exact format:
company_type: <exact facility label from allowed list>
talent_type: <one or two exact talent labels from allowed list, comma-separated>

Allowed company_type (pick exactly one):
${FACILITY_TYPES.map((t) => `- ${t}`).join("\n")}

Allowed talent_type (pick 1 or 2, comma-separated):
${TALENT_TYPES.map((t) => `- ${t}`).join("\n")}

Rules:
- company_type MUST be copied exactly from the allowed facility list above.
- talent_type MUST use only labels from the allowed talent list above.
- Match talent to the contact's title when possible (e.g. VP Preconstruction -> Estimators; Superintendent -> Superintendents; Owner/GC -> Superintendents or Project Managers).
- Prefer Superintendents and Estimators for field-heavy GCs; Project Managers for ops/PM titles; Field Foremen for trade/field leads; Skilled Carpenters for residential finish/carpentry firms.
- Subcontractors (electrical, mechanical, roofing, concrete, etc.) -> company_type Subcontractors.
- Custom/residential home builders -> Custom Home Builders.
- Multifamily/apartment/LIHTC/affordable housing GCs -> Multi-Family Builders.
- Highway/civil/utility/excavation/paving -> Heavy Civil Contractors.
- Commercial general contractors / design-build / tenant improvement -> Commercial GCs.
- No explanations. No bullets. No extra lines.

Company Name: ${cleanText(input.companyNameNormalized)}
Description: ${cleanText(input.companyDescription)}
Products/Services: ${cleanText(input.companyProductsServices)}
Location: ${cleanText(input.city)}${input.state ? `, ${cleanText(input.state)}` : ""}
Employee Size: ${cleanText(input.companySize)}
Job Title Context: ${cleanText(input.title)}`;

export async function enrichConstructionTalent(
  input: ConstructionTalentInput
): Promise<ConstructionTalentOutput> {
  const name = cleanText(input.companyNameNormalized);
  const desc = cleanText(input.companyDescription);
  const prod = cleanText(input.companyProductsServices);
  const title = cleanText(input.title);

  if (!name && !desc && !prod && !title) {
    return { companyType: "Commercial GCs", talentType: "Superintendents" };
  }

  try {
    const openai = getOpenAI();
    const out = await withRetry(
      () =>
        openai.chat.completions.create({
          model: DEFAULT_CHAT_MODEL,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content:
                "Return exactly two lines: company_type and talent_type. Use only the allowed facility and talent labels provided. No markdown."
            },
            { role: "user", content: PROMPT(input) }
          ]
        }),
      { label: `openai.constructionTalent "${(name || desc || prod).slice(0, 40)}"` }
    );

    const raw = out.choices[0]?.message?.content?.trim() ?? "";
    const parsed = parseOutput(raw);
    if (parsed.companyType && parsed.talentType) return parsed;
    return mergeWithHeuristic(parsed, input);
  } catch (err) {
    console.warn(`[enrichConstructionTalent] fallback values: ${(err as Error).message}`);
    return heuristicFallback(input);
  }
}

function parseOutput(raw: string): ConstructionTalentOutput {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let companyType = "";
  let talentType = "";

  for (const line of lines) {
    const companyMatch = line.match(/^company_type\s*:\s*(.+)$/i);
    if (companyMatch) {
      companyType = normalizeFacilityType(companyMatch[1] ?? "");
      continue;
    }

    const talentMatch = line.match(/^talent_type\s*:\s*(.+)$/i);
    if (talentMatch) {
      talentType = normalizeTalentType(talentMatch[1] ?? "");
    }
  }

  return { companyType, talentType };
}

function normalizeFacilityType(text: string): string {
  const cleaned = text.replace(/^["']|["']$/g, "").replace(/[.]+$/, "").trim();
  if (!cleaned) return "";

  const exact = FACILITY_TYPES.find((t) => t.toLowerCase() === cleaned.toLowerCase());
  if (exact) return exact;

  const lower = cleaned.toLowerCase();
  if (/subcontract|specialty|trade|electrical|mechanical|hvac|plumb|roof|concrete|drywall|paint/.test(lower)) {
    return "Subcontractors";
  }
  if (/custom home|residential builder|home builder|luxury home|custom build/.test(lower)) {
    return "Custom Home Builders";
  }
  if (/multi.?family|multifamily|apartment|lihtc|affordable housing/.test(lower)) {
    return "Multi-Family Builders";
  }
  if (/heavy civil|civil|highway|paving|excav|utility|infrastructure/.test(lower)) {
    return "Heavy Civil Contractors";
  }
  if (/commercial gc|general contract|design.?build|tenant improvement/.test(lower)) {
    return "Commercial GCs";
  }

  return FACILITY_TYPES.find((t) => lower.includes(t.toLowerCase().replace(/s$/, ""))) ?? "";
}

function normalizeTalentType(text: string): string {
  const cleaned = text
    .replace(/^["']|["']$/g, "")
    .replace(/[.]+$/, "")
    .replace(/\band\b/gi, ",")
    .replace(/[;/|]+/g, ",")
    .trim();

  if (!cleaned) return "";

  const parts = cleaned
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => matchTalentLabel(p))
    .filter(Boolean)
    .slice(0, 2);

  return [...new Set(parts)].join(", ");
}

function matchTalentLabel(text: string): string {
  const lower = text.toLowerCase();
  if (/superintendent/.test(lower)) return "Superintendents";
  if (/project manager|\bpm\b/.test(lower)) return "Project Managers";
  if (/estimat|preconstruction|pre-construction/.test(lower)) return "Estimators";
  if (/forem|field lead|field supervisor/.test(lower)) return "Field Foremen";
  if (/carpent|finish|framing/.test(lower)) return "Skilled Carpenters";

  const exact = TALENT_TYPES.find((t) => t.toLowerCase() === lower);
  return exact ?? "";
}

function blob(input: ConstructionTalentInput): string {
  return [
    cleanText(input.companyNameNormalized),
    cleanText(input.companyDescription),
    cleanText(input.companyProductsServices),
    cleanText(input.title)
  ]
    .join(" ")
    .toLowerCase();
}

function heuristicFallback(input: ConstructionTalentInput): ConstructionTalentOutput {
  const text = blob(input);
  const title = cleanText(input.title).toLowerCase();

  let companyType: (typeof FACILITY_TYPES)[number] = "Commercial GCs";
  if (/subcontract|electric|mechanical|hvac|plumb|roof|concrete|specialty trade/.test(text)) {
    companyType = "Subcontractors";
  } else if (/custom home|luxury home|residential builder|home remodel|home renovation/.test(text)) {
    companyType = "Custom Home Builders";
  } else if (/multi.?family|multifamily|apartment|lihtc|affordable housing|hud/.test(text)) {
    companyType = "Multi-Family Builders";
  } else if (/heavy civil|civil|highway|paving|excav|grading|utility construction/.test(text)) {
    companyType = "Heavy Civil Contractors";
  }

  let talentType = "Superintendents";
  if (/estimat|preconstruction|pre-construction|vp.*precon/.test(title)) {
    talentType = "Estimators";
  } else if (/project manager|\bpm\b|operations|coo|vp ops/.test(title)) {
    talentType = "Project Managers";
  } else if (/superintendent|field ops|construction manager/.test(title)) {
    talentType = "Superintendents";
  } else if (/forem|field supervisor|site supervisor/.test(title)) {
    talentType = "Field Foremen";
  } else if (/carpent|finish|framing/.test(text) || /carpent/.test(title)) {
    talentType = "Skilled Carpenters";
  } else if (companyType === "Custom Home Builders") {
    talentType = "Skilled Carpenters, Superintendents";
  } else if (companyType === "Heavy Civil Contractors") {
    talentType = "Superintendents, Field Foremen";
  } else if (companyType === "Subcontractors") {
    talentType = "Estimators, Superintendents";
  }

  return {
    companyType,
    talentType: normalizeTalentType(talentType) || "Superintendents"
  };
}

function mergeWithHeuristic(
  parsed: ConstructionTalentOutput,
  input: ConstructionTalentInput
): ConstructionTalentOutput {
  const fallback = heuristicFallback(input);
  return {
    companyType: parsed.companyType || fallback.companyType,
    talentType: parsed.talentType || fallback.talentType
  };
}
