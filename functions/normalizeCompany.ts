import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";

const PROMPT = (raw: string) => `Normalize this company name for a cold email greeting line.

Return a SHORT brand-style trade name people would recognize in conversation.
Rules:
- Prefer the distinctive brand/trade name over the full legal entity.
- Strip legal suffixes (Inc, LLC, Ltd, Corp, Co, Company, Group, Holdings) when they are not needed for recognition.
- Keep key words that distinguish the brand (e.g. Restocon, Double P Construction, Smart Energy).
- Target about 1-4 words. Max 5 words.
- Proper capitalization. No quotes. No punctuation at the end.
- Do not invent a new brand; shorten only.

Raw company name: ${raw}`;

function stripLegalSuffixes(name: string): string {
  return name
    .replace(
      /,?\s*\b(incorporated|inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|lp|llp)\.?$/gi,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function shortenLocally(raw: string): string {
  const stripped = stripLegalSuffixes(raw);
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length <= 4) return stripped;
  // Keep first 3-4 content words after stripping common trailing noise.
  return words.slice(0, 4).join(" ");
}

export async function normalizeCompany(rawCompanyName: unknown): Promise<string> {
  const raw = cleanText(rawCompanyName);
  if (!raw) return "";

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
                "You output only a short normalized company trade name. No preface, quotes, or trailing punctuation. Prefer short brand forms."
            },
            { role: "user", content: PROMPT(raw) }
          ]
        }),
      { label: `openai.normalize "${raw.slice(0, 40)}"` }
    );
    const content = out.choices[0]?.message?.content?.trim() ?? "";
    if (!content) return shortenLocally(raw);
    const cleaned = content.replace(/^["']|["']$/g, "").trim();
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length > 5) return words.slice(0, 4).join(" ");
    return cleaned || shortenLocally(raw);
  } catch (err) {
    console.warn(`[normalizeCompany] fallback to raw for "${raw}": ${(err as Error).message}`);
    return shortenLocally(raw);
  }
}
