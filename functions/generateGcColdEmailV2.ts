import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";
import { countWords, htmlToPlain } from "./humanizeEmailCheck.js";

export type GcScriptInput = {
  firstName: string;
  title?: string;
  companyName: string;
  companyNameNormalized?: string;
  companyDescription?: string;
  companyProductsServices?: string;
  companySize?: string;
  city?: string;
  state?: string;
  companyType: string;
  talentType: string;
  candidateTeaser: string;
  candidateCount: number;
};

export type GcScriptOutput = {
  coldEmailHtml: string;
  coldEmailPlain: string;
  lines: string[];
  wordCount: number;
};

const BANNED = [
  /i noticed/i,
  /impressive/i,
  /high-caliber/i,
  /exceptional/i,
  /elevate/i,
  /seamlessly/i,
  /undoubtedly/i,
  /inspiring/i,
  /usually needs strong/i,
  /hope this message/i,
  /i believe/i,
  /i wanted to reach out/i
];

const EXAMPLE = `Mike, Smart Energy's insulation work around Detroit bottlenecks when field foremen fall behind mechanical schedules.
We have a foreman who has kept mission-critical insulation jobs moving without slowing the mechanical contractor.
We are in touch with 8 candidates who would fit that kind of role.
Any field roles you are hiring for or planning to add soon?`;

function buildContext(input: GcScriptInput): string {
  return [
    `First Name: ${cleanText(input.firstName)}`,
    `Title: ${cleanText(input.title)}`,
    `Company: ${cleanText(input.companyNameNormalized) || cleanText(input.companyName)}`,
    `Company Type: ${cleanText(input.companyType)}`,
    `Talent Type Needed: ${cleanText(input.talentType)}`,
    `Blind Candidate Teaser: ${cleanText(input.candidateTeaser)}`,
    `Location: ${cleanText(input.city)}${input.state ? `, ${cleanText(input.state)}` : ""}`,
    `Employee Size: ${cleanText(input.companySize)}`,
    `Services: ${cleanText(input.companyProductsServices)}`,
    `Description: ${cleanText(input.companyDescription)}`,
    `Candidate Count: ${input.candidateCount}`
  ].join("\n");
}

function lineIssues(line: string, lineNumber: number, input: GcScriptInput, allLines: string[]): string[] {
  const issues: string[] = [];
  const first = cleanText(input.firstName);

  if (lineNumber === 1 && !line.startsWith(`${first},`)) issues.push("Line 1 must start with first name and comma");
  if (BANNED.some((p) => p.test(line))) issues.push("Remove AI/template phrasing");
  if (lineNumber === 3 && !line.includes(String(input.candidateCount))) {
    issues.push(`Line 3 must include candidate count ${input.candidateCount}`);
  }
  if (lineNumber === 4 && (!/\?/.test(line) || !/\b(hiring|hire|openings?|roles?|fill|staff|add|planning|looking for)\b/i.test(line))) {
    issues.push("Line 4 must ask about hiring with a question");
  }
  if (countWords(allLines.join(" ")) >= 60) issues.push("Total email must stay under 60 words");

  const maxByLine = [18, 18, 16, 14];
  if (countWords(line) > (maxByLine[lineNumber - 1] ?? 18)) {
    issues.push(`Line ${lineNumber} too long`);
  }
  return issues;
}

async function writeLine(
  input: GcScriptInput,
  lineNumber: 1 | 2 | 3 | 4,
  priorLines: string[],
  fixNotes: string[] = []
): Promise<string> {
  const prompts: Record<number, string> = {
    1: "Write line 1 only. One short, specific opener about their company work, project type, location, or size. Sound human. No compliments.",
    2: "Write line 2 only. One anonymized candidate proof tied to the teaser and talent type. Mention a concrete outcome, not adjectives.",
    3: `Write line 3 only. Say we can connect them with exactly ${input.candidateCount} candidates like that. Vary phrasing.`,
    4: "Write line 4 only. Ask what they are hiring for or what roles are hard to fill. End with ?."
  };

  const openai = getOpenAI();
  const out = await withRetry(
    () =>
      openai.chat.completions.create({
        model: DEFAULT_CHAT_MODEL,
        temperature: 0.8,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You write one line at a time for construction recruiting cold emails.
Tone example:\n${EXAMPLE}
Never use: I noticed, impressive, high-caliber, elevate, seamlessly, I believe, I wanted to reach out.
Return ONLY JSON: {"line":"..."}`
          },
          {
            role: "user",
            content: [
              buildContext(input),
              priorLines.length ? `Prior lines:\n${priorLines.join("\n")}` : "",
              prompts[lineNumber],
              fixNotes.length ? `Fix:\n${fixNotes.join("\n")}` : ""
            ]
              .filter(Boolean)
              .join("\n\n")
          }
        ]
      }),
    { label: `openai.gcLine${lineNumber} ${cleanText(input.firstName)}` }
  );

  const parsed = JSON.parse(out.choices[0]?.message?.content?.trim() ?? "{}") as { line?: string };
  const line = String(parsed.line ?? "").trim();
  if (!line) throw new Error(`empty line ${lineNumber}`);
  return line;
}

export function linesToHtml(lines: string[]): string {
  return `<div>${lines.join("<br></br>")}</div>`;
}

export async function generateGcColdEmailV2(
  input: GcScriptInput,
  opts: { maxRewrites?: number } = {}
): Promise<GcScriptOutput> {
  const maxRewrites = opts.maxRewrites ?? 3;
  let best: string[] = [];
  let bestWords = 999;

  for (let attempt = 0; attempt <= maxRewrites; attempt++) {
    const lines: string[] = [];
    const fixNotes: string[] = attempt > 0 ? ["Previous draft was too long or templated. Be shorter and more specific."] : [];

    for (const n of [1, 2, 3, 4] as const) {
      let line = "";
      let localFix = [...fixNotes];
      for (let tries = 0; tries < 3; tries++) {
        line = await writeLine(input, n, lines, localFix);
        const issues = lineIssues(line, n, input, [...lines, line]);
        if (issues.length === 0) break;
        localFix = issues;
      }
      lines.push(line);
    }

    const words = countWords(lines.join(" "));
    if (words < bestWords) {
      best = lines;
      bestWords = words;
    }
    if (words < 60 && !BANNED.some((p) => p.test(lines.join(" ")))) {
      const html = linesToHtml(lines);
      return { coldEmailHtml: html, coldEmailPlain: htmlToPlain(html), lines, wordCount: words };
    }
  }

  const html = linesToHtml(best);
  return { coldEmailHtml: html, coldEmailPlain: htmlToPlain(html), lines: best, wordCount: bestWords };
}
