/**
 * Variable-based Step 1 scripts for staffing campaigns.
 *
 * Set 1 (A–F): system / offer-clarity scripts
 * Set 2 (G–K): pain / dream-outcome angles (excludes prior "crowded accounts" angle)
 *
 * CTA always asks for a call to go over accounts / opportunities,
 * using {{{pipl_date "now_wd 2Days" "dddd"}}}
 *
 * Variables:
 *   {{first_name}} {{company_name}} {{custom_talent_type}} {{custom_buyer_type}}
 */
export type Step1Variant = {
  variation: string;
  name: string;
  subject: string;
  body: string;
};

const CALL_DAY = `{{{pipl_date "now_wd 2Days" "dddd"}}}`;

const CTA_CALL = `Are you free for 10 minutes on ${CALL_DAY} to go over the accounts and see the opportunities?`;

/** Plain-text scripts (no HTML wrappers). */
export const STAFFING_STEP1_SCRIPTS: Step1Variant[] = [
  // ——— Previous system / offer scripts ———
  {
    variation: "A",
    name: "System — Companies identified",
    subject: "{{first_name}} — a few companies",
    body: `{{first_name}},

We've identified a few companies currently hiring {{custom_talent_type}} that look like a strong fit for {{company_name}}.

We help recruiting firms turn opportunities like these into qualified conversations by reaching out, qualifying interest, and introducing you to hiring teams. We work on a performance basis, so we only charge for qualified introductions.

${CTA_CALL}`
  },
  {
    variation: "B",
    name: "System — Market research",
    subject: "{{first_name}} — hiring activity",
    body: `{{first_name}},

We've been researching {{custom_buyer_type}} and found several currently hiring {{custom_talent_type}}.

We don't sell lead lists—we reach out, qualify the opportunity, and introduce recruiting firms directly to hiring teams. We only charge when a qualified introduction is made.

${CTA_CALL}`
  },
  {
    variation: "C",
    name: "System — Existing pipeline",
    subject: "{{first_name}} — accounts identified",
    body: `{{first_name}},

We've already identified a handful of companies actively hiring {{custom_talent_type}} that looked relevant for {{company_name}}.

We handle the outreach and qualification, then introduce you to hiring managers on a performance basis—we only charge when a qualified meeting takes place.

${CTA_CALL}`
  },
  {
    variation: "D",
    name: "System — Niche alignment",
    subject: "{{first_name}} — niche fit",
    body: `{{first_name}},

Given {{company_name}}'s focus on placing {{custom_talent_type}}, we researched the market and found companies currently hiring for that profile.

We help recruiting firms get warm introductions into companies like these on a performance basis—we handle the outreach and qualification, and only charge when a qualified meeting takes place.

${CTA_CALL}`
  },
  {
    variation: "E",
    name: "System — Research discovery",
    subject: "{{first_name}} — market notes",
    body: `{{first_name}},

While researching your market, we came across a handful of companies actively hiring {{custom_talent_type}} that looked like good prospects for {{company_name}}.

We help recruiting firms get warm introductions into companies like these on a performance basis—we handle the outreach and qualification, and only charge when a qualified meeting takes place.

${CTA_CALL}`
  },
  {
    variation: "F",
    name: "System — Qualified demand",
    subject: "{{first_name}} — qualified demand",
    body: `{{first_name}},

We've identified a handful of {{custom_buyer_type}} currently hiring {{custom_talent_type}} that look relevant for your team.

We reach out, qualify whether there's real hiring demand, and introduce recruiting firms to those hiring teams. We only charge when a qualified introduction is made.

${CTA_CALL}`
  },

  // ——— Pain / dream-outcome angles (liked set, excluding crowded-accounts) ———
  {
    variation: "G",
    name: "Angle — Companies already hiring",
    subject: "{{first_name}} — hiring demand",
    body: `{{first_name}},

Most recruiting firms don't struggle to place {{custom_talent_type}} — they struggle to get in front of companies that are actually hiring them right now.

We've identified a few {{custom_buyer_type}} currently hiring {{custom_talent_type}} that look relevant for {{company_name}}. We reach out, qualify interest, and introduce you to hiring teams on a performance basis — only charging when a qualified introduction is made.

${CTA_CALL}`
  },
  {
    variation: "H",
    name: "Angle — Less wasted outreach",
    subject: "{{first_name}} — less wasted outreach",
    body: `{{first_name}},

Cold outreach to employers who aren't hiring is one of the fastest ways for a recruiting firm to burn time.

We've been researching {{custom_buyer_type}} and found several currently hiring {{custom_talent_type}}. We don't sell lists — we qualify the opportunity first, then introduce {{company_name}} to the hiring team. You only pay when a qualified introduction happens.

${CTA_CALL}`
  },
  {
    variation: "I",
    name: "Angle — Warmer conversations",
    subject: "{{first_name}} — warmer conversations",
    body: `{{first_name}},

If {{company_name}} could start more conversations with hiring managers who already need {{custom_talent_type}}, placements get a lot easier.

We've identified a handful of companies actively hiring for that profile. We handle the outreach and qualification, then introduce you on a performance basis — only charging when a qualified meeting takes place.

${CTA_CALL}`
  },
  {
    variation: "J",
    name: "Angle — Steadier pipeline",
    subject: "{{first_name}} — steadier pipeline",
    body: `{{first_name}},

When BD depends on hoping the right employers raise their hand, pipeline for {{custom_talent_type}} placements gets unpredictable fast.

While researching your market, we came across companies actively hiring {{custom_talent_type}} that looked like good prospects for {{company_name}}. We help recruiting firms get warm introductions into accounts like these — we handle outreach and qualification, and only charge when a qualified meeting happens.

${CTA_CALL}`
  },
  {
    variation: "K",
    name: "Angle — Real hiring demand",
    subject: "{{first_name}} — qualified demand",
    body: `{{first_name}},

The difference between a useful intro and a dead end is usually whether the company has real hiring demand for {{custom_talent_type}}.

We've identified a handful of {{custom_buyer_type}} currently hiring that look relevant for your team. We reach out, qualify whether the need is real, and introduce recruiting firms to those hiring teams — only charging when a qualified introduction is made.

${CTA_CALL}`
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
