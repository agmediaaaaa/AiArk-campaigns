import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";
import {
  checkHumanEmail,
  critiqueFailedEmail,
  countWords,
  htmlToPlain,
  type HumanizeCheckResult
} from "./humanizeEmailCheck.js";
import { programmaticEmailCheck } from "./programmaticEmailCheck.js";

export type HumanizerMode = "strict" | "relaxed";

export type GcColdEmailInput = {
  firstName: string;
  lastName?: string;
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
  candidateCount: number;
};

export type GcColdEmailOutput = {
  coldEmailHtml: string;
  coldEmailPlain: string;
  candidateCount: number;
  humanizer: HumanizeCheckResult;
  attempts: number;
};

const EXAMPLE = `Mike, Smart Energy's insulation work around Detroit bottlenecks when field foremen fall behind mechanical schedules.
We have a foreman who has kept mission-critical insulation jobs moving without slowing the mechanical contractor.
We are in touch with 8 candidates who would fit that kind of role.
Any field roles you are hiring for or planning to add soon?`;

const GENERATE_SYSTEM = `You write short outcome-focused cold emails for a construction recruiting firm reaching out to GC executives.

The firm HAS candidates and wants to connect executives with those candidates. You are NOT recruiting the executive to join Smart Energy or their company.

Write exactly 4 lines separated by newlines. Under 60 words total.

Line 1: Opener referencing their company work, location, or size — human, specific, not templated.
Line 2: One anonymized candidate proof — what someone in our network has done (no names).
Line 3: Say we can connect them with exactly N candidates like that (use the provided N).
Line 4: Ask what they are hiring for — openings, hard-to-fill roles, or near-term plans.

Rules:
- Start with "{firstName}," only. No Hi/Hello/Dear/I hope this message.
- No signature.
- No spam words or symbols.
- Outcome-focused on what the prospect gets (qualified candidates), not how great we are.
- Sound like a peer, not AI or a mail merge.
- Do NOT write "join our team" or "opportunity" directed at the executive.

Example (structure and tone only):
${EXAMPLE}

Return ONLY valid JSON: {"lines":["line1","line2","line3","line4"]}`;

const REWRITE_SYSTEM = `Rewrite a cold email that failed quality review for a construction recruiting firm.

We offer candidates TO the executive — never ask the executive to join a company.

Keep 4 lines, under 60 words, same first name, same candidate count, same JSON format.
Fix every issue. Match the human tone of this example:
${EXAMPLE}

Return ONLY valid JSON: {"lines":["line1","line2","line3","line4"]}`;

export function pickCandidateCount(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return 6 + (hash % 9);
}

export function linesToHtml(lines: string[]): string {
  const safe = lines.map((l) => l.trim()).filter(Boolean);
  if (safe.length === 0) return "<div></div>";
  return `<div>${safe.join("<br></br>")}</div>`;
}

function buildFallbackLines(input: GcColdEmailInput): string[] {
  const first = cleanText(input.firstName);
  const company = cleanText(input.companyNameNormalized) || cleanText(input.companyName);
  const city = cleanText(input.city);
  const talent = (cleanText(input.talentType).split(",")[0] || "project managers").toLowerCase();
  const n = input.candidateCount;
  const place = city ? ` in ${city}` : "";

  return [
    `${first}, ${company}${place} usually needs strong ${talent} when schedules tighten.`,
    `We know one in our network who has kept similar jobs on track through closeout.`,
    `We can connect you with ${n} candidates along those lines.`,
    `What roles are you hiring for right now?`
  ];
}

function buildGeneratePrompt(input: GcColdEmailInput): string {
  return [
    `First Name: ${cleanText(input.firstName)}`,
    `Title: ${cleanText(input.title)}`,
    `Company: ${cleanText(input.companyNameNormalized) || cleanText(input.companyName)}`,
    `Company Type: ${cleanText(input.companyType)}`,
    `Talent Type Needed: ${cleanText(input.talentType)}`,
    `Location: ${cleanText(input.city)}${input.state ? `, ${cleanText(input.state)}` : ""}`,
    `Employee Size: ${cleanText(input.companySize)}`,
    `Services: ${cleanText(input.companyProductsServices)}`,
    `Description: ${cleanText(input.companyDescription)}`,
    `Candidate Count (use exactly in line 3): ${input.candidateCount}`
  ].join("\n");
}

function parseLines(raw: string): string[] {
  const parsed = JSON.parse(raw) as {
    lines?: unknown;
    line1?: string;
    line2?: string;
    line3?: string;
    line4?: string;
  };

  if (Array.isArray(parsed.lines)) {
    const lines = parsed.lines.map(String).map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 4) return lines.slice(0, 4);
  }

  const fromKeys = [parsed.line1, parsed.line2, parsed.line3, parsed.line4]
    .map((l) => (l ? String(l).trim() : ""))
    .filter(Boolean);
  if (fromKeys.length >= 4) return fromKeys.slice(0, 4);

  throw new Error(`expected 4 lines, got ${raw.slice(0, 200)}`);
}

function validateLines(lines: string[], input: GcColdEmailInput): string[] {
  const issues: string[] = [];
  const plain = lines.join(" ");
  const words = countWords(plain);
  const first = cleanText(input.firstName);

  if (words >= 60) issues.push(`Too long: ${words} words`);
  if (!lines[0]?.startsWith(`${first},`)) issues.push("Line 1 must start with first name and comma");
  if (/^(hi|hello|dear)\b/i.test(lines[0] ?? "")) issues.push("No salutations");
  if (/hope this message finds you well/i.test(plain)) issues.push("Remove hope-this-message phrasing");
  if (/join our team|opportunity to join|would you be open to a quick chat about this opportunity/i.test(plain)) {
    issues.push("Wrong direction — we offer candidates to them, not jobs to the executive");
  }
  if (!plain.includes(String(input.candidateCount))) {
    issues.push(`Line 3 must mention candidate count ${input.candidateCount}`);
  }
  if (!/\?/.test(lines[3] ?? "")) issues.push("Line 4 must be a hiring question ending with ?");
  if (!/\b(hiring|hire|openings?|roles?|fill|staff|recruit|bench|add|planning)\b/i.test(lines[3] ?? "")) {
    issues.push("Line 4 must ask about hiring, openings, or roles");
  }

  return issues;
}

async function generateLines(
  input: GcColdEmailInput,
  issues: string[] = []
): Promise<string[]> {
  const openai = getOpenAI();
  const isRewrite = issues.length > 0;

  const out = await withRetry(
    () =>
      openai.chat.completions.create({
        model: DEFAULT_CHAT_MODEL,
        temperature: isRewrite ? 0.6 : 0.75,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: isRewrite ? REWRITE_SYSTEM : GENERATE_SYSTEM },
          {
            role: "user",
            content: isRewrite
              ? `${buildGeneratePrompt(input)}\n\nIssues to fix:\n${issues.join("\n")}`
              : buildGeneratePrompt(input)
          }
        ]
      }),
    { label: `openai.gcColdEmail ${cleanText(input.firstName)}` }
  );

  return parseLines(out.choices[0]?.message?.content?.trim() ?? "");
}

export async function generateGcColdEmail(
  input: GcColdEmailInput,
  opts: { maxAttempts?: number; humanizerMode?: HumanizerMode; seedFeedback?: string[] } = {}
): Promise<GcColdEmailOutput> {
  const maxAttempts = opts.maxAttempts ?? 8;
  const humanizerMode = opts.humanizerMode ?? "strict";
  const candidateCount = input.candidateCount;
  let issues: string[] = (opts.seedFeedback ?? []).filter(Boolean);
  let lastHtml = "";
  let lastPlain = "";
  let lastCheck: HumanizeCheckResult = { pass: false, score: 0, issues: [] };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let lines: string[];
    try {
      lines = await generateLines(input, attempt === 1 ? [] : issues);
    } catch (err) {
      issues = [`Generation parse error: ${(err as Error).message}`];
      continue;
    }

    const html = linesToHtml(lines);
    const plain = htmlToPlain(html);
    const first = cleanText(input.firstName);
    const programmatic = programmaticEmailCheck(html, first, input.candidateCount);

    if (humanizerMode === "relaxed") {
      lastHtml = html;
      lastPlain = plain;
      if (programmatic.pass) {
        return {
          coldEmailHtml: html,
          coldEmailPlain: plain,
          candidateCount,
          humanizer: { pass: true, score: 100, issues: [], raw: "programmatic_pass" },
          attempts: attempt
        };
      }
      const critique = await critiqueFailedEmail(plain, html, programmatic.issues);
      issues = [...programmatic.issues, ...critique].slice(0, 8);
      continue;
    }

    const localIssues = validateLines(lines, input);
    if (localIssues.length > 0) {
      issues = localIssues;
      lastHtml = html;
      lastPlain = plain;
      continue;
    }

    const check = await checkHumanEmail(plain, html);
    lastHtml = html;
    lastPlain = plain;
    lastCheck = check;

    if (check.pass) {
      return {
        coldEmailHtml: html,
        coldEmailPlain: plain,
        candidateCount,
        humanizer: check,
        attempts: attempt
      };
    }

    const critique = await critiqueFailedEmail(
      plain,
      html,
      check.issues.length > 0 ? check.issues : ["Failed human quality check"]
    );
    lastCheck = { ...check, rewriteGuidance: critique };
    issues = [...(check.issues.length > 0 ? check.issues : ["Failed human quality check"]), ...critique].slice(
      0,
      10
    );
  }

  if (humanizerMode === "relaxed" && lastHtml) {
    const programmatic = programmaticEmailCheck(
      lastHtml,
      cleanText(input.firstName),
      input.candidateCount
    );
    if (programmatic.pass || programmatic.issues.length <= 1) {
      return {
        coldEmailHtml: lastHtml,
        coldEmailPlain: lastPlain,
        candidateCount,
        humanizer: {
          pass: true,
          score: programmatic.pass ? 95 : 80,
          issues: programmatic.issues,
          raw: "programmatic_fallback"
        },
        attempts: maxAttempts
      };
    }
    lastCheck = { pass: false, score: 0, issues: programmatic.issues };
  }

  if (humanizerMode === "relaxed") {
    const fallbackLines = buildFallbackLines(input);
    const fallbackHtml = linesToHtml(fallbackLines);
    const fallbackPlain = htmlToPlain(fallbackHtml);
    const fallbackCheck = programmaticEmailCheck(
      fallbackHtml,
      cleanText(input.firstName),
      input.candidateCount
    );
    if (fallbackCheck.pass) {
      return {
        coldEmailHtml: fallbackHtml,
        coldEmailPlain: fallbackPlain,
        candidateCount,
        humanizer: { pass: true, score: 85, issues: [], raw: "template_fallback" },
        attempts: maxAttempts
      };
    }
    lastCheck = { pass: false, score: 0, issues: fallbackCheck.issues };
  }

  return {
    coldEmailHtml: lastHtml,
    coldEmailPlain: lastPlain,
    candidateCount,
    humanizer: lastCheck,
    attempts: maxAttempts
  };
}
