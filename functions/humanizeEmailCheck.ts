import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";

export type HumanizeCheckResult = {
  pass: boolean;
  score: number;
  issues: string[];
  raw?: string;
};

const SYSTEM = `You are a cold email quality reviewer for construction recruiting outreach.
Evaluate whether the email reads human, natural, and outcome-focused — not AI-generated or templated.

Return ONLY valid JSON:
{"pass": boolean, "score": number, "issues": string[]}

pass=true only when ALL are true:
- Sounds like a real person wrote it, not a mail merge or AI template
- Does NOT open with Hi/Hello/Dear or similar salutations
- Starts with the prospect first name followed by a comma
- Under 60 words in plain text (ignore HTML tags)
- No signature block at the end
- No spam trigger language (free, guaranteed, act now, limited time, !!!, $$$, etc.)
- No excessive punctuation or symbols
- Outcome-focused for the prospect, not bragging about the sender
- Four distinct beats: opener, candidate proof, bench count line, hiring question CTA
- Bench line mentions a specific number of candidates between 6 and 14
- Does NOT contain a standalone blind teaser label line (e.g. "Miami superintendent, commercial builds")
- HTML uses only div and br tags

score is 0-100 (80+ typically passes if pass=true).`;

export async function checkHumanEmail(
  plainText: string,
  html: string
): Promise<HumanizeCheckResult> {
  try {
    const openai = getOpenAI();
    const out = await withRetry(
      () =>
        openai.chat.completions.create({
          model: DEFAULT_CHAT_MODEL,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM },
            {
              role: "user",
              content: `Plain text:\n${plainText}\n\nHTML:\n${html}`
            }
          ]
        }),
      { label: "openai.humanizeCheck" }
    );

    const raw = out.choices[0]?.message?.content?.trim() ?? "";
    const parsed = JSON.parse(raw) as {
      pass?: boolean;
      score?: number;
      issues?: string[];
    };

    return {
      pass: parsed.pass === true,
      score: typeof parsed.score === "number" ? parsed.score : 0,
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
      raw
    };
  } catch (err) {
    console.warn(`[humanizeEmailCheck] checker failed: ${(err as Error).message}`);
    return {
      pass: false,
      score: 0,
      issues: ["humanizer checker error"]
    };
  }
}

export function htmlToPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?div>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
