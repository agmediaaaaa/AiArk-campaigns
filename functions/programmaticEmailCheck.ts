import { countWords, htmlToPlain } from "./humanizeEmailCheck.js";

export type ProgrammaticCheckResult = {
  pass: boolean;
  issues: string[];
};

const SPAM_PATTERNS = [
  /\bfree\b/i,
  /\bguaranteed?\b/i,
  /\bact now\b/i,
  /\blimited time\b/i,
  /!{2,}/,
  /\$/,
  /[!]{2,}/,
  /\bclick here\b/i,
  /\bunsubscribe\b/i
];

const WRONG_DIRECTION = [
  /join our team/i,
  /opportunity to join/i,
  /would you be open to a quick chat about this opportunity/i,
  /hope this message finds you well/i
];

const SINGLE_CANDIDATE = [
  /\bwe have a \w+/i,
  /\bwe have one\b/i,
  /\bi have a \w+ who\b/i,
  /\bconnect you with (that|this|the) (person|candidate|profile|pm|superintendent)\b/i,
  /\bintroduce you to (that|this|the|one)\b/i
];

export function programmaticEmailCheck(
  html: string,
  firstName: string,
  candidateCount: number
): ProgrammaticCheckResult {
  const issues: string[] = [];
  const plain = htmlToPlain(html);
  const words = countWords(plain);
  const first = firstName.trim();

  if (!html.startsWith("<div>") || !html.endsWith("</div>")) {
    issues.push("HTML must use div wrapper");
  }
  if (/<(?!div|br)[a-z]/i.test(html)) {
    issues.push("HTML must only use div and br tags");
  }
  if (words >= 60) issues.push(`Too long: ${words} words`);
  if (!plain.toLowerCase().startsWith(`${first.toLowerCase()},`)) {
    issues.push("Must start with first name and comma");
  }
  if (/^(hi|hello|dear)\b/i.test(plain)) issues.push("No salutations");

  for (const p of SPAM_PATTERNS) {
    if (p.test(plain)) {
      issues.push("Contains spam trigger language");
      break;
    }
  }
  for (const p of WRONG_DIRECTION) {
    if (p.test(plain)) {
      issues.push("Wrong direction or templated opener");
      break;
    }
  }

  if (/[!$]/.test(plain)) issues.push("No dollar signs or symbol spam");
  if (SINGLE_CANDIDATE.some((p) => p.test(plain))) {
    issues.push("Do not offer one specific candidate or the teaser person");
  }
  if (!plain.includes(String(candidateCount))) {
    issues.push(`Must mention candidate count ${candidateCount}`);
  }
  if (!/\?/.test(plain)) issues.push("Must include a hiring question");
  if (
    !/\b(hiring|hire|openings?|roles?|fill|staff|recruit|add|planning|looking for|need|staffing|positions?)\b/i.test(
      plain
    )
  ) {
    issues.push("Must ask about hiring or roles");
  }

  const lineCount = html
    .replace(/<\/?div>/gi, "")
    .split(/<br\s*\/?>/i)
    .map((s) => s.trim())
    .filter(Boolean).length;
  if (lineCount < 4) issues.push("Should have 4 lines");

  return { pass: issues.length === 0, issues };
}
