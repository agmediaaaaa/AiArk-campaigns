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
  companyType: string;
  talentType: string;
};

const ROLE_BANK = [
  "Superintendents",
  "Estimators",
  "Project Engineers",
  "Foremen",
  "Field Engineers",
  "Safety Managers",
  "Operations Managers",
  "Site Managers",
  "Quantity Surveyors",
  "MEP Coordinators",
  "Scheduling Coordinators",
  "Preconstruction Managers"
];

const PROMPT = (input: ConstructionTalentInput) => `You classify construction companies for recruiting outreach and pick the talent they MOST need to hire.
Return exactly two lines in this exact format:
company_type: <broad short GC segment label>
talent_type: <one or two plural short talent labels, comma-separated>

Rules for company_type:
- Broad and short (1-4 words), e.g. Commercial GC, Residential GC, Heavy Civil, Industrial, Tenant Improvement, Design-Build, Specialty Subcontractor, Roofing Subcontractor, Electrical Subcontractor, Mechanical Subcontractor, Concrete Subcontractor.

Rules for talent_type:
- Prefer the role that matches their craft, scale, and delivery model — NOT a generic default.
- Do NOT default to Project Managers. Use Project Managers only when company data clearly points to PM-heavy delivery and no better role fits.
- Strong defaults by specialty:
  - Roofing / exteriors / waterproofing -> Superintendents, Foremen
  - Electrical / low-voltage -> Estimators, Superintendents
  - Mechanical / HVAC / plumbing -> Superintendents, Estimators
  - Concrete / foundations / heavy civil -> Superintendents, Field Engineers
  - Painting / finishes / TI -> Superintendents, Estimators
  - Design-build GCs / commercial GCs with multiple jobs -> Superintendents, Estimators
  - Engineering / consulting firms -> Project Engineers, Field Engineers
- Allowed roles include: Superintendents, Estimators, Project Engineers, Foremen, Field Engineers, Safety Managers, Operations Managers, Site Managers, MEP Coordinators, Scheduling Coordinators, Preconstruction Managers, Project Managers.
- Return 1 or 2 plural labels only.
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
    return { companyType: "unknown", talentType: "" };
  }

  try {
    const openai = getOpenAI();
    const out = await withRetry(
      () =>
        openai.chat.completions.create({
          model: DEFAULT_CHAT_MODEL,
          temperature: 0.35,
          messages: [
            {
              role: "system",
              content:
                "Return exactly two lines: company_type and talent_type. Prefer specialized construction roles over Project Managers unless PM is clearly the best fit. No markdown."
            },
            { role: "user", content: PROMPT(input) }
          ]
        }),
      { label: `openai.constructionTalent "${(name || desc || prod).slice(0, 40)}"` }
    );

    const raw = out.choices[0]?.message?.content?.trim() ?? "";
    const parsed = parseOutput(raw);
    return diversifyAwayFromDefaultPm(parsed, input);
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
      companyType = normalizeLabel(companyMatch[1] ?? "", 4);
      continue;
    }

    const talentMatch = line.match(/^talent_type\s*:\s*(.+)$/i);
    if (talentMatch) {
      talentType = normalizeTalentType(talentMatch[1] ?? "");
    }
  }

  return {
    companyType: companyType || "unknown",
    talentType
  };
}

function normalizeLabel(text: string, maxWords: number): string {
  const cleaned = text.replace(/^["']|["']$/g, "").replace(/[.]+$/, "").trim();
  if (!cleaned) return "";
  return cleaned.split(/\s+/).slice(0, maxWords).join(" ");
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
    .map((p) => toPluralShortLabel(p))
    .filter(Boolean)
    .slice(0, 2);

  return parts.join(", ");
}

function toPluralShortLabel(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (/managers$/i.test(compact) || /s$/i.test(compact)) return compact;
  if (/man$/i.test(compact)) return compact.replace(/man$/i, "men");
  return `${compact}s`;
}

function blob(input: ConstructionTalentInput): string {
  return [
    cleanText(input.companyNameNormalized),
    cleanText(input.companyDescription),
    cleanText(input.companyProductsServices)
  ]
    .join(" ")
    .toLowerCase();
}

function heuristicFallback(input: ConstructionTalentInput): ConstructionTalentOutput {
  const text = blob(input);
  if (/roof|waterproof|siding|exterior/.test(text)) {
    return { companyType: "Specialty Subcontractor", talentType: "Superintendents, Foremen" };
  }
  if (/electric|low.?voltage|lighting/.test(text)) {
    return { companyType: "Electrical Subcontractor", talentType: "Estimators, Superintendents" };
  }
  if (/hvac|mechanical|plumb|sheet metal|air conditioning/.test(text)) {
    return { companyType: "Mechanical Subcontractor", talentType: "Superintendents, Estimators" };
  }
  if (/concrete|excav|foundat|civil|paving|asphalt|grading/.test(text)) {
    return { companyType: "Heavy Civil", talentType: "Superintendents, Field Engineers" };
  }
  if (/paint|finish|drywall|flooring|interior|tenant/.test(text)) {
    return { companyType: "Tenant Improvement", talentType: "Superintendents, Estimators" };
  }
  if (/engineer|consult/.test(text)) {
    return { companyType: "Engineering", talentType: "Project Engineers, Field Engineers" };
  }
  if (/design.?build|general contract|gc\b/.test(text)) {
    return { companyType: "Commercial GC", talentType: "Superintendents, Estimators" };
  }
  return { companyType: "Commercial GC", talentType: "Superintendents, Estimators" };
}

function diversifyAwayFromDefaultPm(
  parsed: ConstructionTalentOutput,
  input: ConstructionTalentInput
): ConstructionTalentOutput {
  const first = (parsed.talentType.split(",")[0] ?? "").trim();
  const isPmHeavy = /^project managers?$/i.test(first) || !parsed.talentType;
  if (!isPmHeavy) return parsed.talentType ? parsed : heuristicFallback(input);

  const fallback = heuristicFallback(input);
  // If specialty heuristic found a better role, prefer that.
  if (!/^project managers?/i.test(fallback.talentType.split(",")[0] ?? "")) {
    return {
      companyType: parsed.companyType !== "unknown" ? parsed.companyType : fallback.companyType,
      talentType: fallback.talentType
    };
  }

  // Soft rotate across role bank for generic commercial firms so scripts do not all say PM.
  const seed = blob(input);
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const primary = ROLE_BANK[hash % ROLE_BANK.length]!;
  const secondary = ROLE_BANK[(hash + 3) % ROLE_BANK.length]!;
  return {
    companyType: parsed.companyType !== "unknown" ? parsed.companyType : "Commercial GC",
    talentType: `${primary}, ${secondary}`
  };
}
