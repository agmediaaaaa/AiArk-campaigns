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
  /\$\$\$/,
  /\bclick here\b/i,
  /\bunsubscribe\b/i
];

const WRONG_DIRECTION = [
  /join our team/i,
  /opportunity to join/i,
  /would you be open to a quick chat about this opportunity/i,
  /hope this message finds you well/i
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
  if (!plain.startsWith(`${first},`)) issues.push("Must start with first name and comma");
  if (/^(hi|hello|dear)\b/i.test(plain)) issues.push("No salutations");

  for (const p of SPAM_PATTERNS) {
    if (p.test(plain)) issues.push("Contains spam trigger language");
    break;
  }
  for (const p of WRONG_DIRECTION) {
    if (p.test(plain)) issues.push("Wrong direction or templated opener");
    break;
  }

  if (!plain.includes(String(candidateCount))) {
    issues.push(`Must mention candidate count ${candidateCount}`);
  }
  if (!/\?/.test(plain)) issues.push("Must include a hiring question");
  if (!/\b(hiring|hire|openings?|roles?|fill|staff|recruit|add|planning|looking for)\b/i.test(plain)) {
    issues.push("Must ask about hiring or roles");
  }

  const segments = plain.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (segments.length < 3) issues.push("Should have at least 3 distinct beats");

  return { pass: issues.length === 0, issues };
}
