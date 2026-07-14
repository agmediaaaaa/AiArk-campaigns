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

const TEMPLATED_LINE1 = [
  /\bfaces (delays|scheduling|delivery|project)\b/i,
  /\bwithout (experienced )?project managers?\b/i,
  /\bproject managers? (are|is) (crucial|critical|key)\b/i,
  /\bschedule slippage when project managers?\b/i,
  /\bin short supply\b/i,
  /\bstretched thin on multiple jobs\b/i,
  /\brisks? schedule slippage\b/i
];

const EXAMPLE = `Tom, Restocon is expanding its footprint in Tampa's specialty construction market.
People in our network with restoration superintendent backgrounds have kept complex exterior schedules on track.
We can connect you with 9 candidates who match that profile.
What positions are you currently hiring for or finding challenging to fill?`;

const MAX_TOTAL_WORDS = 55;
const MAX_BY_LINE = [16, 16, 13, 12];

function primaryTalent(input: GcScriptInput): string {
  const first = cleanText(input.talentType).split(",")[0]?.trim();
  if (first) return first;
  const teaser = cleanText(input.candidateTeaser);
  if (/\bsuperintendent/i.test(teaser)) return "Superintendents";
  if (/\bestimator/i.test(teaser)) return "Estimators";
  if (/\bforeman|foremen/i.test(teaser)) return "Foremen";
  if (/\bengineer/i.test(teaser)) return "Project Engineers";
  return "Superintendents";
}

function buildContext(input: GcScriptInput): string {
  const company = cleanText(input.companyNameNormalized) || cleanText(input.companyName);
  return [
    `First Name: ${cleanText(input.firstName)}`,
    `Title: ${cleanText(input.title)}`,
    `Company Short Name (use this, not the long legal name): ${company}`,
    `Company Type: ${cleanText(input.companyType)}`,
    `Primary Talent Type (must drive wording): ${primaryTalent(input)}`,
    `Talent Types Needed: ${cleanText(input.talentType)}`,
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
  const company = cleanText(input.companyNameNormalized) || cleanText(input.companyName);
  const talent = primaryTalent(input);

  if (lineNumber === 1 && !line.startsWith(`${first},`)) issues.push("Line 1 must start with first name and comma");
  if (lineNumber === 1 && GENERIC_LINE1.some((p) => p.test(line))) {
    issues.push("Line 1 must avoid generic company descriptions");
  }
  if (lineNumber === 1 && TEMPLATED_LINE1.some((p) => p.test(line))) {
    issues.push("Line 1 is templated; write a company-specific market or delivery situation instead");
  }
  if (lineNumber === 1 && company && !line.toLowerCase().includes(company.split(/\s+/)[0]!.toLowerCase())) {
    issues.push(`Line 1 should mention the short company name (${company})`);
  }
  if (lineNumber === 2 && !new RegExp(talent.split(/\s+/)[0]!, "i").test(line) && !/\b(superintendent|estimator|foremen|foreman|engineer|coordinator|manager)/i.test(line)) {
    issues.push(`Line 2 should reflect talent type ${talent}`);
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
  const issues: string[] = [];

  if (countWords(plain) >= 60) issues.push(`Too long: ${countWords(plain)} words`);
  if (BANNED.some((p) => p.test(plain))) issues.push("Contains banned phrasing or symbols");
  if (SINGLE_CANDIDATE.some((p) => p.test(plain))) {
    issues.push("Do not offer one specific candidate or the teaser person");
  }
  if (TEMPLATED_LINE1.some((p) => p.test(lines[0] ?? ""))) {
    issues.push("Line 1 is templated PM-delay copy");
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
  const company = cleanText(input.companyNameNormalized) || cleanText(input.companyName);
  const talent = primaryTalent(input);

  const prompts: Record<number, string> = {
    1: `Write line 1 only. Max ${lineBudget} words. Start with first name and comma, then a company-specific market or situation opener using short company name "${company}".
Good shape: "${company} is expanding ... in [city/market]" or "${company}'s [specialty] work around [city] ...".
Do NOT write templated lines like "faces delays without project managers" or "schedule slippage when PMs are thin".
Use only locations from the data. No compliments. No dollar signs.`,
    2: `Write line 2 only. Max ${Math.min(lineBudget, remainingBudget)} words. Use plural network language about ${talent} / teaser profile outcomes (not one person). Example: "People in our network with similar ${talent.toLowerCase()} backgrounds have ...". Never say we have one person.`,
    3: `Write line 3 only. Max ${Math.min(lineBudget, remainingBudget)} words. Must include the number ${input.candidateCount}. Prefer: "We can connect you with ${input.candidateCount} candidates who match that profile."`,
    4: `Write line 4 only. Max ${Math.min(lineBudget, remainingBudget)} words. Ask what they are hiring for or what roles are hard to fill. End with ?.`
  };

  const openai = getOpenAI();
  const out = await withRetry(
    () =>
      openai.chat.completions.create({
        model: DEFAULT_CHAT_MODEL,
        temperature: 0.75,
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
Line 1 must feel unique to the company market/situation — never a generic "faces delays without project managers" template.
Role language must follow the primary talent type (${talent}), not default to project managers.
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
            "Previous draft failed quality checks. Make line 1 company-specific like the Restocon example. Use the enriched talent type. No dollar signs. No single-candidate language. No PM-delay templates.",
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

    if (words < bestWords || (words === bestWords && issues.length < bestIssues.length)) {
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
