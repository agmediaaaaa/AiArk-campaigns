import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";
import { countWords, htmlToPlain } from "./humanizeEmailCheck.js";
import { programmaticEmailCheck } from "./programmaticEmailCheck.js";

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
  pass: boolean;
  issues: string[];
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
  /i wanted to reach out/i,
  /\$/,
  /[!]{2,}/
];

const SINGLE_CANDIDATE = [
  /\bwe have a \w+/i,
  /\bwe have one\b/i,
  /\bi have a \w+ who\b/i,
  /\bone (project manager|superintendent|foreman|estimator|pm)\b/i,
  /\bconnect you with (that|this|the) (person|candidate|profile|pm|superintendent)\b/i,
  /\bintroduce you to (that|this|the|one)\b/i
];

const GENERIC_LINE1 = [
  /\bis active in\b/i,
  /\bfocus(es|ing)? on\b/i,
  /\bspecializes? in\b/i,
  /\bhandles\b/i,
  /\bmanages\b/i
];

const LINE1_PRESSURE_SIGNALS =
  /\b(juggling|bottleneck|thin|backlog|turnover|schedule|delivery|staffing|pipeline|slips?|slowdowns?|capacity|coverage|coordination)\b/i;

const EXAMPLE = `Mike, Smart Energy's insulation work around Detroit bottlenecks when field foremen fall behind mechanical schedules.
People in our network with similar commercial insulation backgrounds have kept mission-critical jobs on schedule without slowing mechanical contractors.
We are in touch with 8 candidates who would fit that kind of role.
Any field roles you are hiring for or planning to add soon?`;

const MAX_TOTAL_WORDS = 55;
const MAX_BY_LINE = [15, 15, 13, 12];

function buildContext(input: GcScriptInput): string {
  return [
    `First Name: ${cleanText(input.firstName)}`,
    `Title: ${cleanText(input.title)}`,
    `Company: ${cleanText(input.companyNameNormalized) || cleanText(input.companyName)}`,
    `Company Type: ${cleanText(input.companyType)}`,
    `Talent Type Needed: ${cleanText(input.talentType)}`,
    `Blind Candidate Teaser (profile type only, not a person to introduce): ${cleanText(input.candidateTeaser)}`,
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
  if (lineNumber === 1 && GENERIC_LINE1.some((p) => p.test(line))) {
    issues.push("Line 1 must avoid generic company descriptions");
  }
  if (lineNumber === 1 && !LINE1_PRESSURE_SIGNALS.test(line)) {
    issues.push("Line 1 must mention a talent pressure, scheduling risk, or delivery trend");
  }
  if (BANNED.some((p) => p.test(line))) issues.push("Remove banned phrasing or symbols");
  if (SINGLE_CANDIDATE.some((p) => p.test(line))) {
    issues.push("Do not reference one specific candidate or offer to connect to one person");
  }
  if (lineNumber === 2 && /\bwe have a\b/i.test(line)) {
    issues.push("Line 2 must describe candidate types in the network, not one person");
  }
  if (lineNumber === 3 && !line.includes(String(input.candidateCount))) {
    issues.push(`Line 3 must include candidate count ${input.candidateCount}`);
  }
  if (
    lineNumber === 4 &&
    (!/\?/.test(line) ||
      !/\b(hiring|hire|openings?|roles?|fill|staff|add|planning|looking for)\b/i.test(line))
  ) {
    issues.push("Line 4 must ask about hiring with a question");
  }
  if (countWords(allLines.join(" ")) >= 60) issues.push("Total email must stay under 60 words");

  const maxByLine = MAX_BY_LINE;
  if (countWords(line) > (maxByLine[lineNumber - 1] ?? 18)) {
    issues.push(`Line ${lineNumber} too long`);
  }
  return issues;
}

function fullScriptIssues(lines: string[], input: GcScriptInput, html: string): string[] {
  const plain = htmlToPlain(html);
  const issues = [...lineIssues("", 1, input, lines)]; // noop placeholder
  issues.length = 0;

  if (countWords(plain) >= 60) issues.push(`Too long: ${countWords(plain)} words`);
  if (BANNED.some((p) => p.test(plain))) issues.push("Contains banned phrasing or symbols");
  if (SINGLE_CANDIDATE.some((p) => p.test(plain))) {
    issues.push("Do not offer one specific candidate or the teaser person");
  }
  if (!plain.includes(String(input.candidateCount))) {
    issues.push("Must include candidate count");
  }

  const programmatic = programmaticEmailCheck(html, cleanText(input.firstName), input.candidateCount);
  issues.push(...programmatic.issues);
  return [...new Set(issues)];
}

async function writeLine(
  input: GcScriptInput,
  lineNumber: 1 | 2 | 3 | 4,
  priorLines: string[],
  fixNotes: string[] = []
): Promise<string> {
  const usedWords = countWords(priorLines.join(" "));
  const lineBudget = Math.max(8, MAX_BY_LINE[lineNumber - 1] ?? 12);
  const remainingBudget = Math.max(8, MAX_TOTAL_WORDS - usedWords);

  const prompts: Record<number, string> = {
    1: `Write line 1 only. Max ${lineBudget} words. Start with first name and comma, then describe a specific talent pressure or delivery risk (schedule slippage, bottleneck, backlog, trade coordination gap, turnover risk). Do NOT just describe the company. Use only locations from data. No compliments.`,
    2: `Write line 2 only. Max ${Math.min(lineBudget, remainingBudget)} words. Describe outcomes for candidate TYPES in our network that match the teaser profile. Use plural language like 'people in our network with similar backgrounds'. Never say we have one person or offer to connect one candidate.`,
    3: `Write line 3 only. Max ${Math.min(lineBudget, remainingBudget)} words. Must include the number ${input.candidateCount}. Example shape: "We can connect you with ${input.candidateCount} candidates with backgrounds like that." Do not reference one person.`,
    4: `Write line 4 only. Max ${Math.min(lineBudget, remainingBudget)} words. Ask what they are hiring for or what roles are hard to fill. End with ?.`
  };

  const openai = getOpenAI();
  const out = await withRetry(
    () =>
      openai.chat.completions.create({
        model: DEFAULT_CHAT_MODEL,
        temperature: 0.65,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You write one line at a time for construction recruiting cold emails.
Tone example:\n${EXAMPLE}
Keep the full email under ${MAX_TOTAL_WORDS} words total across 4 lines.
Never use dollar signs, spam words, or symbols.
Never say we have one candidate or will connect them to one specific person.
The teaser is a profile type label, not a person to introduce.
Line 1 must focus on a hiring/scheduling pressure, not a generic company description.
Return ONLY JSON: {"line":"..."}`
          },
          {
            role: "user",
            content: [
              buildContext(input),
              priorLines.length
                ? `Prior lines (${usedWords} words used, ${remainingBudget} words left for remaining lines):\n${priorLines.join("\n")}`
                : "",
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
  opts: { maxRewrites?: number; seedFeedback?: string[] } = {}
): Promise<GcScriptOutput> {
  const maxRewrites = opts.maxRewrites ?? 4;
  let best: string[] = [];
  let bestWords = 999;
  let bestIssues: string[] = ["failed"];

  for (let attempt = 0; attempt <= maxRewrites; attempt++) {
    const lines: string[] = [];
    const fixNotes: string[] =
      attempt > 0
        ? [
            "Previous draft failed quality checks. Shorter, specific, no dollar signs, no single-candidate language.",
            ...(opts.seedFeedback ?? [])
          ]
        : attempt === 0 && opts.seedFeedback?.length
          ? opts.seedFeedback
          : [];

    for (const n of [1, 2, 3, 4] as const) {
      let line = "";
      let localFix = [...fixNotes];
      for (let tries = 0; tries < 3; tries++) {
        line = await writeLine(input, n, lines, localFix);
        const issues = lineIssues(line, n, input, [...lines, line]);
        if (issues.length === 0) break;
        localFix = [...issues, `Keep line ${n} under ${MAX_BY_LINE[n - 1]} words`];
      }
      lines.push(line);
    }

    const html = linesToHtml(lines);
    const words = countWords(htmlToPlain(html));
    const issues = fullScriptIssues(lines, input, html);

    if (words < bestWords) {
      best = lines;
      bestWords = words;
      bestIssues = issues;
    }

    if (issues.length === 0 && words < 60) {
      return {
        coldEmailHtml: html,
        coldEmailPlain: htmlToPlain(html),
        lines,
        wordCount: words,
        pass: true,
        issues: []
      };
    }
  }

  const html = linesToHtml(best);
  return {
    coldEmailHtml: html,
    coldEmailPlain: htmlToPlain(html),
    lines: best,
    wordCount: bestWords,
    pass: bestIssues.length === 0 && bestWords < 60,
    issues: bestIssues
  };
}
