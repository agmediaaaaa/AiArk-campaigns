import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";

export type TeaserInput = {
  companyType: string;
  talentType: string;
  city?: string;
  state?: string;
  companyDescription?: string;
  companyProductsServices?: string;
};

export async function enrichCandidateTeaser(input: TeaserInput): Promise<string> {
  const talent = cleanText(input.talentType).split(",")[0] || "Superintendents";
  const location = [cleanText(input.city), cleanText(input.state)].filter(Boolean).join(", ");

  try {
    const openai = getOpenAI();
    const out = await withRetry(
      () =>
        openai.chat.completions.create({
          model: DEFAULT_CHAT_MODEL,
          temperature: 0.4,
          messages: [
            {
              role: "system",
              content:
                "Return one blind candidate teaser label only. 8-10 words. No names. No quotes. Must mention the provided talent role and project/company context. Do not invent Project Managers when another role is provided."
            },
            {
              role: "user",
              content: [
                `Company Type: ${cleanText(input.companyType)}`,
                `Talent Needed (prefer first label): ${cleanText(input.talentType)}`,
                `Location: ${location}`,
                `Services: ${cleanText(input.companyProductsServices)}`,
                `Description: ${cleanText(input.companyDescription)}`,
                "",
                "Example: Michigan superintendent, commercial TI and ground-up builds",
                "Example: Tampa estimator, specialty restoration and roofing bids"
              ].join("\n")
            }
          ]
        }),
      { label: "openai.candidateTeaser" }
    );

    const raw = out.choices[0]?.message?.content?.trim() ?? "";
    const words = raw.replace(/^["']|["']$/g, "").split(/\s+/).filter(Boolean);
    if (words.length >= 6 && words.length <= 12) return words.join(" ");
  } catch (err) {
    console.warn(`[enrichCandidateTeaser] fallback: ${(err as Error).message}`);
  }

  const place = location ? `${location.split(",")[0]} ` : "";
  const role = talent.toLowerCase();
  return `${place}${role}, ${cleanText(input.companyType).toLowerCase()} project delivery`.trim().slice(0, 80);
}
