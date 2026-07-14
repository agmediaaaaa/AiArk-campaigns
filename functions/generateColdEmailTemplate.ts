import { cleanText } from "./classifyMx.js";
import type { ColdEmailInput } from "./generateColdEmail.js";

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function pick<T>(arr: T[], seed: string, salt: string): T {
  return arr[hash(`${seed}:${salt}`) % arr.length]!;
}

function regionLabel(city: string, state: string): string {
  const c = cleanText(city);
  const s = cleanText(state);
  if (c && s) return `${c} area`;
  if (c) return c;
  if (s) return s;
  return "your market";
}

function sizeNote(size: string): string {
  const n = Number(cleanText(size));
  if (n > 0 && n < 30) return "a lean team";
  if (n >= 30 && n < 100) return "a mid-size team";
  if (n >= 100) return "a multi-site operation";
  return "your team";
}

function talentPrimary(talent: string): string {
  const t = cleanText(talent).toLowerCase();
  if (t.includes("rn")) return "RNs";
  if (t.includes("cna")) return "CNAs";
  if (t.includes("therapist") || t.includes("pt") || t.includes("dpt")) return "therapists";
  if (t.includes("counselor") || t.includes("lcsw")) return "counselors";
  if (t.includes("physician") || t.includes("md")) return "physicians";
  if (t.includes("caregiver")) return "caregivers";
  return talent.split(",")[0]?.trim() || "clinical staff";
}

function facilityPain(input: ColdEmailInput, seed: string): string {
  const f = cleanText(input.facilityType).toLowerCase();
  const region = regionLabel(input.city ?? "", input.state ?? "");
  const team = sizeNote(input.companySize ?? "");

  const pains: Record<string, string[]> = {
    default: [
      `open roles in ${region} tend to stall intake before referrals even notice`,
      `${team} in ${region} feels every unfilled shift in the weekly census`,
      `coverage gaps in ${region} usually show up before the job post does`
    ],
    rehab: [
      `one open therapy slot in ${region} can ripple across the whole week's discharges`,
      `inpatient rehab census in ${region} drops when therapy coverage slips`,
      `discharge planning stalls when ${team} is short a therapist in ${region}`
    ],
    home: [
      `home visit routes in ${region} break down when one caregiver callout turns into three`,
      `${team} covering ${region} loses referrals when visit windows get missed`,
      `same-day starts in ${region} are hard when caregiver coverage is thin`
    ],
    hospice: [
      `weekend nurse coverage across ${region} is where hospice census gets fragile`,
      `on-call gaps in ${region} show up fast when census climbs`,
      `families in ${region} feel staffing gaps before your board does`
    ],
    behavioral: [
      `admissions slow in ${region} when counselor caseloads stay above waterline`,
      `beds stay empty in ${region} when clinical coverage cannot keep pace`,
      `dual-program clinics in ${region} stall when one therapist lane is open`
    ],
    sleep: [
      `scoring backlogs in ${region} pile up when a sleep tech leaves mid-quarter`,
      `chair turnover in ${region} widens when consult rooms sit empty a week`,
      `DME orders stack up when sleep tech coverage slips in ${region}`
    ]
  };

  let bucket = pains.default!;
  if (f.includes("rehab") || f.includes("therapy") || f.includes("pt")) bucket = pains.rehab!;
  else if (f.includes("home")) bucket = pains.home!;
  else if (f.includes("hospice") || f.includes("palliative")) bucket = pains.hospice!;
  else if (f.includes("behavioral") || f.includes("mental")) bucket = pains.behavioral!;
  else if (f.includes("sleep")) bucket = pains.sleep!;

  return pick(bucket, seed, "pain");
}

function proofLine(seed: string): string {
  const proofs = [
    "Someone we placed last month started in a similar setting on day four.",
    "A similar operator filled a hard role in under two weeks last quarter.",
    "We recently placed someone at a comparable clinic with a ninety-day stay.",
    "A peer facility in a nearby market cleared a backlog after one hire.",
    "A similar team cut open-role downtime after one targeted placement."
  ];
  return pick(proofs, seed, "proof");
}

function teaserLine(input: ColdEmailInput, seed: string): string {
  const talent = talentPrimary(input.talentType ?? "");
  const region = cleanText(input.state) || cleanText(input.city) || "local";
  const f = cleanText(input.facilityType).toLowerCase();
  const talentWord = talent.toLowerCase().replace(/s$/, "");

  const teasers = [
    `Eight-year ${talentWord}, ${region} licensed, outpatient ready`,
    `${talent}, ${region} market, week-one availability, clinic seasoned`,
    `Ten-year ${talentWord}, ${f.includes("home") ? "home health" : "facility"} background, reliable`,
    `${talent}, ${region} commutable, credentialed, open to contract`,
    `Seven-year ${talentWord}, multi-site comfort, ${region} based`
  ];
  return pick(teasers, seed, "teaser");
}

function ctaLine(input: ColdEmailInput, seed: string): string {
  const talent = talentPrimary(input.talentType ?? "");
  const ctas = [
    `Are you currently hiring ${talent.toLowerCase()} or other clinical roles?`,
    `Are ${talent.toLowerCase()} openings a priority for you right now?`,
    `Are you hiring more for ${talent.toLowerCase()} coverage this quarter?`,
    `Which roles are you staffing for over the next few months?`,
    `Are you adding ${talent.toLowerCase()} now or planning for later this year?`
  ];
  return pick(ctas, seed, "cta");
}

export function generateColdEmailTemplate(input: ColdEmailInput): string {
  const firstName = cleanText(input.firstName);
  if (!firstName) return "";

  const seed =
    cleanText(input.companyName) +
    cleanText(input.email as string) +
    firstName +
    cleanText(input.facilityType);

  const opener = `${firstName}, ${facilityPain(input, seed)}.`;
  const proof = proofLine(seed);
  const teaser = teaserLine(input, seed);
  const cta = ctaLine(input, seed);

  return `<div>${opener}<br></br>${proof}<br></br>${teaser}<br></br>${cta}</div>`;
}
