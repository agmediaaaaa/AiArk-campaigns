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

pass=true when the email meets core quality bars. Be reasonable — do not fail emails for minor stylistic choices.

pass=true when ALL core checks pass:
- Does NOT open with Hi/Hello/Dear
- Starts with the prospect first name followed by a comma
- Under 60 words in plain text (ignore HTML tags)
- No signature block at the end
- No spam trigger language (free, guaranteed, act now, limited time, !!!, $$$)
- Outcome-focused: offering candidates TO the executive, not recruiting them to a job
- Four beats present: opener, candidate proof, bench count line, hiring question
- Bench line mentions the candidate count number
- HTML uses only div and br tags

ALLOWED (do NOT fail for these):
- Mentioning the company name in line 1 after the first name (e.g. "Mike, Smart Energy's work...")
- Conversational or direct tone
- Slight informality

score is 0-100. pass=true if score >= 65 OR all core checks above are clearly met.`;

export async function checkHumanEmail(
  plainText: string,
  html: string
): Promise<HumanizeCheckResult> {
  for (let attempt = 1; attempt <= 2; attempt++) {
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
        { label: `openai.humanizeCheck attempt=${attempt}` }
      );

      const raw = out.choices[0]?.message?.content?.trim() ?? "";
      const parsed = JSON.parse(raw) as {
        pass?: boolean;
        score?: number;
        issues?: string[];
      };

      return {
        pass: parsed.pass === true || (typeof parsed.score === "number" && parsed.score >= 65),
        score: typeof parsed.score === "number" ? parsed.score : 0,
        issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
        raw
      };
    } catch (err) {
      if (attempt === 2) {
        console.warn(`[humanizeEmailCheck] checker failed: ${(err as Error).message}`);
        return {
          pass: false,
          score: 0,
          issues: ["humanizer checker error"]
        };
      }
    }
  }

  return { pass: false, score: 0, issues: ["humanizer checker error"] };
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
