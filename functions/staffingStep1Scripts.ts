/**
 * Variable-based Step 1 scripts for staffing SOP frameworks.
 * Uses PlusVibe merge fields — not pre-rendered lead copy.
 *
 * Variables:
 *   {{first_name}} {{company_name}} {{custom_talent_type}} {{custom_buyer_type}} {{sender_first_name}}
 *
 * Note: PlusVibe stores custom fields with a `custom_` prefix, so talent/buyer
 * must be referenced as {{custom_talent_type}} / {{custom_buyer_type}}.
 */
export type Step1Variant = {
  variation: string;
  name: string;
  subject: string;
  body: string;
};

/** Plain-text scripts (no HTML wrappers). Line breaks are real newlines. */
export const STAFFING_STEP1_SCRIPTS: Step1Variant[] = [
  {
    variation: "A",
    name: "Framework 1 — Companies Already Identified",
    subject: "{{first_name}} — a few companies",
    body: `{{first_name}},

I've identified companies hiring {{custom_talent_type}} that look relevant for {{company_name}}.

I introduce recruiting firms to hiring managers on a performance basis.

Want to see a few of those companies?

- {{sender_first_name}}`
  },
  {
    variation: "B",
    name: "Framework 2 — Market Activity",
    subject: "{{first_name}} — hiring activity",
    body: `{{first_name}},

I've been seeing strong hiring activity among {{custom_buyer_type}} for {{custom_talent_type}}.

I help recruiting firms start conversations with those employers.

Open to looking at a few examples?

- {{sender_first_name}}`
  },
  {
    variation: "C",
    name: "Framework 3 — Existing Pipeline",
    subject: "{{first_name}} — account pipeline",
    body: `{{first_name}},

I've already built a pipeline of employers hiring {{custom_talent_type}}.

I qualify hiring demand before making any introductions.

Want to review a few of those accounts?

- {{sender_first_name}}`
  },
  {
    variation: "D",
    name: "Framework 4 — Niche Alignment",
    subject: "{{first_name}} — niche fit",
    body: `{{first_name}},

Given {{company_name}}'s focus on placing {{custom_talent_type}}, that specialty stood out.

I've found companies currently looking for that talent.

Curious to see the companies?

- {{sender_first_name}}`
  },
  {
    variation: "E",
    name: "Framework 5 — Research Discovery",
    subject: "{{first_name}} — market notes",
    body: `{{first_name}},

While researching the market, I came across several employers relevant to your niche.

I generate introductions into those companies.

Happy to share the accounts?

- {{sender_first_name}}`
  },
  {
    variation: "F",
    name: "Framework 6 — Qualified Demand",
    subject: "{{first_name}} — qualified demand",
    body: `{{first_name}},

I've identified employers actively hiring {{custom_talent_type}}.

Introductions only happen after hiring demand is confirmed.

Interested in reviewing a few?

- {{sender_first_name}}`
  }
];

/** HTML bodies for PlusVibe sequence `body` field (div + br only). */
export function toHtmlBody(plain: string): string {
  const lines = plain
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  return `<div>\n${lines.join("\n<br></br>\n")}\n</div>`;
}

export function getStep1SequencePayload(waitTimeDays = 3) {
  return [
    {
      step: 1,
      wait_time: waitTimeDays,
      variations: STAFFING_STEP1_SCRIPTS.map((v) => ({
        variation: v.variation,
        name: v.name,
        subject: v.subject,
        body: toHtmlBody(v.body)
      }))
    }
  ];
}
