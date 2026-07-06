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

const PROMPT = (input: ConstructionTalentInput) => `You classify general contractor and construction companies for recruiting outreach.
Return exactly two lines in this exact format:
company_type: <broad short GC segment label>
talent_type: <one or two plural short talent labels, comma-separated>

Rules:
- company_type must be broad and short (1-4 words), e.g. Commercial GC, Residential GC, Heavy Civil, Industrial, Tenant Improvement, Design-Build, Specialty Subcontractor.
- talent_type must contain 1 or 2 labels only.
- talent labels must be plural construction hiring roles (examples: Project Managers, Superintendents, Estimators, Project Engineers, Foremen).
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
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "Return exactly two lines: company_type and talent_type. No markdown, no extra text."
            },
            { role: "user", content: PROMPT(input) }
          ]
        }),
      { label: `openai.constructionTalent "${(name || desc || prod).slice(0, 40)}"` }
    );

    const raw = out.choices[0]?.message?.content?.trim() ?? "";
    return parseOutput(raw);
  } catch (err) {
    console.warn(`[enrichConstructionTalent] fallback values: ${(err as Error).message}`);
    return { companyType: "unknown", talentType: "" };
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
  if (compact.endsWith("s") || compact.endsWith("S")) return compact;
  return `${compact}s`;
}
