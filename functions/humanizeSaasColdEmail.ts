import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { validateSaasColdEmailParts } from "./validateColdEmail.js";

export type SaasEmailParts = {
  opening_line: string;
  value_line: string;
  cta: string;
};

const HUMANIZER_SYSTEM = `You humanize B2B cold email copy. Return strict JSON only:
{
  "opening_line": "...",
  "value_line": "...",
  "cta": "..."
}

Rules:
- Keep the exact 3-block structure and ALL numbers/metrics (demo counts, account list size, timeframes).
- Keep the performance/pay-on-results model — do not remove or soften it.
- Make it sound like one operator wrote it to another: natural, direct, not marketing-speak.
- Remove robotic phrasing, empty compliments, and words like "specialize", "impressive", "unique", "innovative".
- Do NOT add Hi/Hello/Dear, signatures, or repeat the first name inside body lines.
- Do NOT claim we already know their niche deeply or that leads are actively looking for them.
- Total body under 72 words (opening + value_line + cta).
- value_line MUST start with "We can connect you with" and include performance-basis language.
- cta MUST ask for a quick call and mention the flagged account list count.`;

export async function humanizeSaasColdEmail(
  parts: SaasEmailParts,
  context: { firstName: string; companyName: string; accountListSize: number }
): Promise<SaasEmailParts> {
  const openai = getOpenAI();
  const user = `First name (salutation only, do not repeat in body): ${context.firstName}
Company: ${context.companyName}
Account list size to keep in CTA: ${context.accountListSize}

Draft to humanize:
Opening: ${parts.opening_line}
Value line: ${parts.value_line}
CTA: ${parts.cta}`;

  for (let attempt = 0; attempt <= 2; attempt++) {
    const out = await withRetry(
      () =>
        openai.chat.completions.create({
          model: DEFAULT_CHAT_MODEL,
          temperature: 0.55,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: HUMANIZER_SYSTEM },
            {
              role: "user",
              content:
                attempt > 0
                  ? `${user}\n\nRewrite — previous version failed validation or sounded robotic.`
                  : user
            }
          ]
        }),
      { label: `openai.humanizeSaas "${context.firstName}"` }
    );

    const parsed = parseHumanized(out.choices[0]?.message?.content ?? "{}");
    const val = validateSaasColdEmailParts(parsed, context.firstName, context.accountListSize);
    if (val.ok || attempt === 2) return parsed;
  }

  return parts;
}

function parseHumanized(raw: string): SaasEmailParts {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return {
      opening_line: clean(obj.opening_line),
      value_line: clean(obj.value_line),
      cta: clean(obj.cta)
    };
  } catch {
    return { opening_line: "", value_line: "", cta: "" };
  }
}

function clean(v: unknown): string {
  return String(v ?? "")
    .replace(/^["']|["']$/g, "")
    .trim();
}
