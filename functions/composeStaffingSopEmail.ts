import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";

export type StaffingSopInput = {
  firstName: string;
  companyName: string;
  talentType: string;
  buyerType: string;
  companyDescription?: string;
  companyProductsServices?: string;
  rowIndex: number;
};

export type StaffingSopResult = {
  subject: string;
  body: string;
  wordCount: number;
  framework: number;
  talentType: string;
  buyerType: string;
};

const MAX_WORDS = 60;

const SPAM_PHRASES = [
  "free",
  "guarantee",
  "guaranteed",
  "act now",
  "limited time",
  "urgent",
  "urgency",
  "click here",
  "exclusive",
  "amazing",
  "incredible",
  "risk-free",
  "no obligation",
  "winner",
  "congratulations",
  "special offer",
  "last chance",
  "act fast",
  "100%",
  "buy now",
  "no cost",
  "double your",
  "opportunity",
  "opportunities",
  "great fit",
  "good match",
  "let's explore",
  "work together",
  "i specialize",
  "partnering",
  "right now",
  "i'd love",
  "i love",
  "let me know!",
  "we work with",
  "i help",
  "we help"
];

export function countWords(html: string): number {
  const plain = html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.split(/\s+/).filter(Boolean).length;
}

export function firstNameOnly(raw?: string): string {
  const name = cleanText(raw);
  if (!name) return "there";
  return name.split(/\s+/)[0]!.replace(/[^a-zA-Z'-]/g, "") || "there";
}

function containsSpam(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes("$")) return true;
  return SPAM_PHRASES.some((p) => lower.includes(p));
}

function inferTalentAndBuyer(input: {
  products?: string;
  description?: string;
  industry?: string;
}): { talentType: string; buyerType: string } {
  const text = `${cleanText(input.products)} ${cleanText(input.description)} ${cleanText(input.industry)}`.toLowerCase();

  if (/\bnanny|household|domestic|estate manager|housekeeper|personal chef/.test(text)) {
    return { talentType: "nannies and household staff", buyerType: "private households" };
  }
  if (/\bcrna|anesthesia|physician|nurse practitioner|advanced practice/.test(text)) {
    return { talentType: "advanced practice clinicians", buyerType: "hospitals and surgical facilities" };
  }
  if (/\bnurs|rn\b|lpn|cna|lvn|allied|therapy|clinical/.test(text) && /\bhealth|hospital|medical|staffing/.test(text)) {
    return { talentType: "nurses and allied clinicians", buyerType: "healthcare facilities" };
  }
  if (/\bhealth tech|healthcare it|ehr|epic|cerner/.test(text)) {
    return { talentType: "healthcare IT talent", buyerType: "providers and health tech firms" };
  }
  if (/\bpharma|biotech|diagnostics/.test(text)) {
    return { talentType: "pharma and biotech executives", buyerType: "pharma and biotech companies" };
  }
  if (/\bsurgical services|perioperative|or nurse manager/.test(text)) {
    return { talentType: "Directors of Surgical Services", buyerType: "hospitals and surgery centers" };
  }
  if (/\baccounting|finance|controller|cfo|audit|tax/.test(text)) {
    return { talentType: "accounting and finance professionals", buyerType: "mid-market companies" };
  }
  if (/\bit\b|software|engineer|developer|cloud|technology/.test(text) && /\bfinanc|bank|fintech/.test(text)) {
    return { talentType: "technology and financial services talent", buyerType: "tech and finance employers" };
  }
  if (/\bit\b|software|engineer|developer|cloud|sap|java/.test(text)) {
    return { talentType: "IT professionals", buyerType: "companies hiring technical talent" };
  }
  if (/\bexecutive|c-suite|retained|search/.test(text)) {
    return { talentType: "executive leadership", buyerType: "employers hiring senior leaders" };
  }
  if (/\bwarehouse|logistics|industrial|manufacturing|assembly/.test(text)) {
    return { talentType: "industrial and logistics talent", buyerType: "manufacturing and logistics employers" };
  }
  if (/\bcreative|marketing|design|copy/.test(text)) {
    return { talentType: "creative and marketing talent", buyerType: "companies hiring creative teams" };
  }
  return { talentType: "specialized contract talent", buyerType: "employers in their niche" };
}

export async function enrichTalentAndBuyer(input: {
  companyName?: string;
  products?: string;
  description?: string;
  industry?: string;
  title?: string;
}): Promise<{ talentType: string; buyerType: string }> {
  const fallback = inferTalentAndBuyer(input);
  const name = cleanText(input.companyName);
  const desc = cleanText(input.description);
  const prod = cleanText(input.products);
  if (!name && !desc && !prod) return fallback;

  try {
    const openai = getOpenAI();
    const out = await withRetry(
      () =>
        openai.chat.completions.create({
          model: DEFAULT_CHAT_MODEL,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content:
                "Return exactly two lines:\ntalent_type: <1-5 word plural talent label they place>\nbuyer_type: <1-6 word label for companies that hire that talent>\nNo markdown."
            },
            {
              role: "user",
              content: `Company: ${name}\nIndustry: ${cleanText(input.industry)}\nProducts: ${prod.slice(0, 300)}\nDescription: ${desc.slice(0, 400)}\nTitle: ${cleanText(input.title)}`
            }
          ]
        }),
      { label: `openai.talentBuyer "${(name || "x").slice(0, 30)}"` }
    );
    const raw = out.choices[0]?.message?.content?.trim() ?? "";
    let talentType = "";
    let buyerType = "";
    for (const line of raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      const t = line.match(/^talent_type\s*:\s*(.+)$/i);
      if (t) talentType = t[1]!.replace(/^["']|["']$/g, "").replace(/[.]+$/, "").trim();
      const b = line.match(/^buyer_type\s*:\s*(.+)$/i);
      if (b) buyerType = b[1]!.replace(/^["']|["']$/g, "").replace(/[.]+$/, "").trim();
    }
    return {
      talentType: talentType || fallback.talentType,
      buyerType: buyerType || fallback.buyerType
    };
  } catch {
    return fallback;
  }
}

function localEmail(input: StaffingSopInput): StaffingSopResult {
  const first = firstNameOnly(input.firstName);
  const company = cleanText(input.companyName) || "your firm";
  const talent = cleanText(input.talentType) || "specialized talent";
  const buyers = cleanText(input.buyerType) || "employers in their niche";
  const framework = (input.rowIndex % 6) + 1;

  const variants: Array<() => { subject: string; paragraphs: string[] }> = [
    () => ({
      subject: `${first} — a few employers`,
      paragraphs: [
        `While reviewing ${company}'s focus on placing ${talent}, I pulled several ${buyers} already hiring for that profile.`,
        `I introduce recruiting firms to hiring managers only after demand is confirmed.`,
        `Want to see what we pulled?`
      ]
    }),
    () => ({
      subject: `${first} — hiring activity`,
      paragraphs: [
        `Hiring for ${talent} looks active among ${buyers}.`,
        `I open conversations between firms like ${company} and those hiring managers when the need is clear.`,
        `Worth taking a look?`
      ]
    }),
    () => ({
      subject: `${first} — account list`,
      paragraphs: [
        `I already have a short pipeline of ${buyers} that are hiring ${talent} in ${company}'s lane.`,
        `Each account is checked for real hiring demand before any intro goes out.`,
        `Open to reviewing a few?`
      ]
    }),
    () => ({
      subject: `${first} — niche match`,
      paragraphs: [
        `Given ${company}'s focus on placing ${talent}, a few ${buyers} stood out as actively looking.`,
        `I can open those conversations when the fit looks real.`,
        `Curious to see a few?`
      ]
    }),
    () => ({
      subject: `${first} — market notes`,
      paragraphs: [
        `While scanning the market, several ${buyers} lined up with ${company}'s ${talent} placement focus.`,
        `My work is making intros into those teams when they are staffing.`,
        `Happy to share them?`
      ]
    }),
    () => ({
      subject: `${first} — qualified demand`,
      paragraphs: [
        `A handful of ${buyers} are actively adding ${talent} that match ${company}'s specialty.`,
        `Intros only move once hiring need is clear on their side.`,
        `Interested in seeing a few?`
      ]
    }),
    () => ({
      subject: `${first} — relevant accounts`,
      paragraphs: [
        `${company}'s work with ${talent} caught my attention because a few ${buyers} are staffing those roles.`,
        `I make introductions to the hiring managers on a contingent basis.`,
        `Want to see the companies?`
      ]
    }),
    () => ({
      subject: `${first} — demand check`,
      paragraphs: [
        `I came across several ${buyers} recruiting ${talent} that look relevant for ${company}.`,
        `Demand gets qualified before I make any introduction.`,
        `Open to a quick look?`
      ]
    }),
    () => ({
      subject: `${first} — short list`,
      paragraphs: [
        `I put together a short list of ${buyers} currently looking for ${talent}.`,
        `If useful for ${company}, I can share the accounts and open intros from there.`,
        `Happy to share them?`
      ]
    }),
    () => ({
      subject: `${first} — employer list`,
      paragraphs: [
        `A few ${buyers} hiring ${talent} appear aligned with what ${company} places.`,
        `I connect staffing firms to those managers after confirming the req is live.`,
        `Want to review a few accounts?`
      ]
    }),
    () => ({
      subject: `${first} — niche hiring`,
      paragraphs: [
        `Your lane in ${talent} maps to several ${buyers} I have been tracking.`,
        `Intros are only made when hiring demand checks out.`,
        `Curious to see a few?`
      ]
    }),
    () => ({
      subject: `${first} — active reqs`,
      paragraphs: [
        `There is clear hiring signal for ${talent} among ${buyers} that look right for ${company}.`,
        `I can introduce you to those hiring managers when you want the list.`,
        `Worth taking a look?`
      ]
    })
  ];

  const pick = variants[(framework - 1) % variants.length]!();
  const body = `<div>\n${first},\n<br></br>\n${pick.paragraphs.join("\n<br></br>\n")}\n</div>`;
  return {
    subject: pick.subject.slice(0, 49),
    body,
    wordCount: countWords(body),
    framework,
    talentType: talent,
    buyerType: buyers
  };
}

function normalizeBody(html: string, first: string): string {
  let inner = html.trim();
  inner = inner.replace(/^```(?:html)?/i, "").replace(/```$/i, "").trim();
  inner = inner.replace(/^<div>/i, "").replace(/<\/div>$/i, "").trim();
  inner = inner.replace(/<br\s*\/?\s*>\s*<\/br>/gi, "<br></br>");
  inner = inner.replace(/<\/br>/gi, "");
  inner = inner.replace(/<br\s*\/?>/gi, "<br></br>");
  inner = inner.replace(/(?:<br><\/br>\s*){2,}/g, "<br></br>");
  // Strip signatures / closings the model may add
  inner = inner
    .replace(/(?:<br><\/br>\s*)+(?:[-–—]\s*)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s*$/g, "")
    .replace(/(?:<br><\/br>\s*)+(?:Best|Thanks|Regards|Cheers|Sincerely)[,.]?[\s\S]*$/i, "")
    .trim();

  // Force first line = name only
  const parts = inner
    .split(/<br><\/br>/i)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (parts.length === 0) return "";
  const nameLine = `${first},`;
  if (/^[A-Za-z' -]+,$/.test(parts[0]!)) {
    parts[0] = nameLine;
  } else {
    parts.unshift(nameLine);
  }
  return `<div>\n${parts.join("\n<br></br>\n")}\n</div>`;
}

export async function composeStaffingSopEmail(
  input: StaffingSopInput,
  opts: { fallbackOnly?: boolean } = {}
): Promise<StaffingSopResult> {
  const local = localEmail(input);
  if (opts.fallbackOnly) return local;

  const first = firstNameOnly(input.firstName);
  const framework = (input.rowIndex % 6) + 1;
  const frameworkHints: Record<number, string> = {
    1: "Lead with companies already identified that hire their talent.",
    2: "Lead with hiring demand among their buyer type.",
    3: "Lead with an existing pipeline of target employer accounts.",
    4: "Lead by referencing their specialization, then companies looking for that talent.",
    5: "Lead with a research discovery angle into relevant employers.",
    6: "Lead with qualified demand and intros only after confirming hiring need."
  };

  try {
    const openai = getOpenAI();
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await withRetry(
        () =>
          openai.chat.completions.create({
            model: DEFAULT_CHAT_MODEL,
            temperature: 0.9 + attempt * 0.05,
            messages: [
              {
                role: "system",
                content: `You write original cold emails for staffing-firm founders.
Return ONLY valid JSON: {"subject":"...","body":"..."}.
Body rules:
- Single HTML block starting with <div> and ending with </div>
- Use only <br></br> for line breaks (never stack them, never output lone </br>)
- First line is ONLY the recipient first name followed by a comma
- Then 2-3 short paragraphs separated by <br></br>
- Under 60 words (body text only)
- No signature, no sender name, no closing name, no Best/Thanks/Regards
- Plain conversational English
- Communicate naturally: companies currently hiring their talent; those employers fit their niche; you introduce staffing firms to hiring managers after confirming demand; ask if they want to see a few examples
- Position as a business development partner (never as a recruiter, staffing agency, lead list, or marketing agency)
- Do NOT explain outbound process, technology, or infrastructure
- Banned words/phrases: opportunity/opportunities, free, guarantee, urgent, exclusive, amazing, partnering, specialize, let's explore, work together, great fit, good match, right now, I'd love, we work with, I help, we help, dollar symbols, clickbait, all caps, exclamation marks
- Prefer CTAs like: Interested in seeing a few? Worth taking a look? Happy to share them? Want to see what we found? Open to a quick look? Curious to see a few?
- Frameworks define thought process only — write fresh wording every time; never template-swap
- One conversational CTA only
Subject: under 50 characters, no hype/urgency/promo language.`
              },
              {
                role: "user",
                content: `First name: ${first}
Company: ${cleanText(input.companyName)}
Talent type: ${cleanText(input.talentType)}
Buyer type: ${cleanText(input.buyerType)}
Framework ${framework} guidance: ${frameworkHints[framework]}
Variation seed: ${input.rowIndex}-${attempt}
Write a completely original email. Do not add a signature.`
              }
            ]
          }),
        { label: `openai.sopEmail "${first}" a${attempt}` }
      );

      const raw = out.choices[0]?.message?.content?.trim() ?? "";
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;
      let parsed: { subject?: string; body?: string };
      try {
        parsed = JSON.parse(jsonMatch[0]) as { subject?: string; body?: string };
      } catch {
        continue;
      }
      const subject = cleanText(parsed.subject).slice(0, 49) || local.subject;
      const body = normalizeBody(cleanText(parsed.body) || "", first);
      const wordCount = countWords(body);
      if (
        wordCount === 0 ||
        wordCount > MAX_WORDS ||
        !body.startsWith("<div>") ||
        !body.endsWith("</div>") ||
        body.includes("</br>") ||
        containsSpam(`${subject}\n${body}`)
      ) {
        continue;
      }
      return {
        subject,
        body,
        wordCount,
        framework,
        talentType: input.talentType,
        buyerType: input.buyerType
      };
    }
    return local;
  } catch {
    return local;
  }
}
