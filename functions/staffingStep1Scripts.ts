/**
 * Spintax Step 1 scripts for staffing campaigns.
 *
 * Uses {{random|a|b|c}} with nested {{custom_*}} / {{company_name}} vars.
 * Date tag uses double braces only: {{pipl_date "now_wd 2Days" "dddd"}}
 *
 * Each random phrase in a block is written to work with every phrase
 * in the following blocks (grammar + logic).
 */
export type Step1Variant = {
  variation: string;
  name: string;
  subject: string;
  body: string;
};

const DATE = `{{pipl_date "now_wd 2Days" "dddd"}}`;

const CTA = `{{random|Are you free for 10 minutes on ${DATE} to go over the accounts and see the opportunities?|Do you have 10 minutes available on ${DATE} to review the accounts and explore the opportunities?|Would you be free for a quick 10-minute chat on ${DATE} to go through the accounts and see the opportunities?}}`;

const SIG = `- {{sender_first_name}}`;

export const STAFFING_STEP1_SCRIPTS: Step1Variant[] = [
  {
    variation: "A",
    name: "System — Companies identified",
    subject: "{{first_name}}",
    body: `{{first_name}}, {{random|we've identified a few companies currently hiring {{custom_talent_type}} that look like a strong fit for {{company_name}}.|we've found several companies currently hiring {{custom_talent_type}} that appear to be a strong match for {{company_name}}.|we identified a handful of companies currently looking for {{custom_talent_type}} that seem well aligned with {{company_name}}.}}

{{random|We help recruiting firms turn opportunities like these into qualified conversations by reaching out, qualifying interest, and introducing you to hiring teams.|We help recruiting firms convert opportunities like these into qualified conversations by handling outreach, gauging interest, and connecting you with hiring teams.|We support recruiting firms in turning opportunities like these into qualified conversations through targeted outreach, interest qualification, and introductions to hiring teams.}} {{random|We work on a performance basis, so we only charge for qualified introductions.|We operate on a performance-based model, meaning you only pay for qualified introductions.|Our model is performance-based, so you only pay for qualified introductions.}}

${CTA}

${SIG}`
  },
  {
    variation: "B",
    name: "System — Market research",
    subject: "{{first_name}}",
    body: `{{first_name}}, {{random|we've been researching {{custom_buyer_type}} and found several currently hiring {{custom_talent_type}}.|while looking at {{custom_buyer_type}}, we found several companies currently hiring {{custom_talent_type}}.|we've been tracking hiring among {{custom_buyer_type}} and came across several currently looking for {{custom_talent_type}}.}}

{{random|We don't sell lead lists — we reach out, qualify the opportunity, and introduce recruiting firms directly to hiring teams.|Rather than selling lists, we reach out, qualify interest, and introduce recruiting firms directly to hiring teams.|We don't hand over lead lists — we handle outreach, qualify the opportunity, and introduce recruiting firms to hiring teams.}} {{random|We only charge when a qualified introduction is made.|You only pay when a qualified introduction is made.|Payment only happens when a qualified introduction is made.}}

${CTA}

${SIG}`
  },
  {
    variation: "C",
    name: "System — Existing pipeline",
    subject: "{{first_name}}",
    body: `{{first_name}}, {{random|we've already identified a handful of companies actively hiring {{custom_talent_type}} that looked relevant for {{company_name}}.|we've already put together a short list of companies actively hiring {{custom_talent_type}} that looked relevant for {{company_name}}.|we've already sourced several companies actively hiring {{custom_talent_type}} that looked like a fit for {{company_name}}.}}

{{random|We handle the outreach and qualification, then introduce you to hiring managers on a performance basis — we only charge when a qualified meeting takes place.|We take care of outreach and qualification, then introduce you to hiring managers on a performance basis — you only pay when a qualified meeting takes place.|We run the outreach and qualification first, then introduce you to hiring managers on a performance basis — we only charge when a qualified meeting happens.}}

${CTA}

${SIG}`
  },
  {
    variation: "D",
    name: "System — Niche alignment",
    subject: "{{first_name}}",
    body: `{{first_name}}, {{random|given {{company_name}}'s focus on placing {{custom_talent_type}}, we researched the market and found companies currently hiring for that profile.|because {{company_name}} focuses on placing {{custom_talent_type}}, we researched the market and found companies currently hiring for that profile.|looking at {{company_name}}'s focus on placing {{custom_talent_type}}, we researched the market and found companies currently hiring for that specialty.}}

{{random|We help recruiting firms get warm introductions into companies like these on a performance basis — we handle the outreach and qualification, and only charge when a qualified meeting takes place.|We help recruiting firms secure warm introductions into companies like these on a performance basis — we handle outreach and qualification, and only charge when a qualified meeting takes place.|We open warm introductions into companies like these for recruiting firms on a performance basis — we handle outreach and qualification, and only charge when a qualified meeting happens.}}

${CTA}

${SIG}`
  },
  {
    variation: "E",
    name: "System — Research discovery",
    subject: "{{first_name}}",
    body: `{{first_name}}, {{random|while researching your market, we came across a handful of companies actively hiring {{custom_talent_type}} that looked like good prospects for {{company_name}}.|while researching your market, we identified several companies actively hiring {{custom_talent_type}} that looked like good prospects for {{company_name}}.|in researching your market, we found a handful of companies actively hiring {{custom_talent_type}} that looked relevant for {{company_name}}.}}

{{random|We help recruiting firms get warm introductions into companies like these on a performance basis — we handle the outreach and qualification, and only charge when a qualified meeting takes place.|We help recruiting firms generate warm introductions into companies like these on a performance basis — we handle outreach and qualification, and only charge when a qualified meeting takes place.|We create warm introductions into companies like these for recruiting firms on a performance basis — we handle the outreach and qualification, and only charge when a qualified meeting happens.}}

${CTA}

${SIG}`
  },
  {
    variation: "F",
    name: "System — Qualified demand",
    subject: "{{first_name}}",
    body: `{{first_name}}, {{random|we've identified a handful of {{custom_buyer_type}} currently hiring {{custom_talent_type}} that look relevant for your team.|we've found several {{custom_buyer_type}} currently hiring {{custom_talent_type}} that look relevant for your team.|we identified a few {{custom_buyer_type}} currently hiring {{custom_talent_type}} that look like a fit for your team.}}

{{random|We reach out, qualify whether there's real hiring demand, and introduce recruiting firms to those hiring teams.|We reach out first, confirm real hiring demand, and introduce recruiting firms to those hiring teams.|We handle outreach, confirm whether hiring demand is real, and introduce recruiting firms to those hiring teams.}} {{random|We only charge when a qualified introduction is made.|You only pay when a qualified introduction is made.|Payment only happens when a qualified introduction is made.}}

${CTA}

${SIG}`
  },
  {
    variation: "G",
    name: "Angle — Companies already hiring",
    subject: "{{first_name}}",
    body: `{{first_name}}, {{random|most recruiting firms don't struggle to place {{custom_talent_type}} — they struggle to get in front of companies that are actually hiring them right now.|for many recruiting firms, placing {{custom_talent_type}} isn't the hard part — getting in front of companies that are actually hiring them is.|the harder part usually isn't placing {{custom_talent_type}} — it's reaching companies that are actively hiring for those roles.}}

{{random|We've identified a few {{custom_buyer_type}} currently hiring {{custom_talent_type}} that look relevant for {{company_name}}.|We've found several {{custom_buyer_type}} currently hiring {{custom_talent_type}} that look relevant for {{company_name}}.|We identified a handful of {{custom_buyer_type}} currently hiring {{custom_talent_type}} that look like a fit for {{company_name}}.}} {{random|We reach out, qualify interest, and introduce you to hiring teams on a performance basis — only charging when a qualified introduction is made.|We handle outreach, qualify interest, and introduce you to hiring teams on a performance basis — only charging when a qualified introduction is made.|We reach out, qualify interest, and introduce you to hiring teams on a performance basis — you only pay when a qualified introduction is made.}}

${CTA}

${SIG}`
  },
  {
    variation: "H",
    name: "Angle — Less wasted outreach",
    subject: "{{first_name}}",
    body: `{{first_name}}, {{random|cold outreach to employers who aren't hiring is one of the fastest ways for a recruiting firm to burn time.|spending BD time on employers that aren't hiring is one of the fastest ways for a recruiting firm to waste effort.|outreach to employers with no active hiring need is one of the quickest ways for a recruiting firm to burn cycles.}}

{{random|We've been researching {{custom_buyer_type}} and found several currently hiring {{custom_talent_type}}.|We've been looking across {{custom_buyer_type}} and found several currently hiring {{custom_talent_type}}.|While researching {{custom_buyer_type}}, we found several companies currently hiring {{custom_talent_type}}.}} {{random|We don't sell lists — we qualify the opportunity first, then introduce {{company_name}} to the hiring team.|Rather than selling lists, we qualify the opportunity first, then introduce {{company_name}} to the hiring team.|We don't hand over lists — we qualify the opportunity first, then introduce {{company_name}} to the hiring team.}} {{random|You only pay when a qualified introduction happens.|We only charge when a qualified introduction happens.|Payment only happens when a qualified introduction is made.}}

${CTA}

${SIG}`
  },
  {
    variation: "I",
    name: "Angle — Warmer conversations",
    subject: "{{first_name}}",
    body: `{{first_name}}, {{random|if {{company_name}} could start more conversations with hiring managers who already need {{custom_talent_type}}, placements get a lot easier.|when {{company_name}} can start more conversations with hiring managers who already need {{custom_talent_type}}, placements tend to move faster.|if {{company_name}} had more conversations with hiring managers already looking for {{custom_talent_type}}, filling roles would get a lot easier.}}

{{random|We've identified a handful of companies actively hiring for that profile.|We've found several companies actively hiring for that profile.|We identified a few companies actively hiring for that profile.}} {{random|We handle the outreach and qualification, then introduce you on a performance basis — only charging when a qualified meeting takes place.|We take care of outreach and qualification, then introduce you on a performance basis — only charging when a qualified meeting takes place.|We run outreach and qualification first, then introduce you on a performance basis — you only pay when a qualified meeting takes place.}}

${CTA}

${SIG}`
  },
  {
    variation: "J",
    name: "Angle — Steadier pipeline",
    subject: "{{first_name}}",
    body: `{{first_name}}, {{random|when BD depends on hoping the right employers raise their hand, pipeline for {{custom_talent_type}} placements gets unpredictable fast.|if BD waits for the right employers to raise their hand, pipeline for {{custom_talent_type}} placements gets unpredictable quickly.|when new business depends on employers coming forward on their own, {{custom_talent_type}} placement pipeline gets unpredictable fast.}}

{{random|While researching your market, we came across companies actively hiring {{custom_talent_type}} that looked like good prospects for {{company_name}}.|While researching your market, we identified companies actively hiring {{custom_talent_type}} that looked like good prospects for {{company_name}}.|In researching your market, we found companies actively hiring {{custom_talent_type}} that looked relevant for {{company_name}}.}} {{random|We help recruiting firms get warm introductions into accounts like these — we handle outreach and qualification, and only charge when a qualified meeting happens.|We help recruiting firms open warm introductions into accounts like these — we handle outreach and qualification, and only charge when a qualified meeting happens.|We create warm introductions into accounts like these for recruiting firms — we handle outreach and qualification, and only charge when a qualified meeting takes place.}}

${CTA}

${SIG}`
  },
  {
    variation: "K",
    name: "Angle — Real hiring demand",
    subject: "{{first_name}}",
    body: `{{first_name}}, {{random|the difference between a useful intro and a dead end is usually whether the company has real hiring demand for {{custom_talent_type}}.|what separates a useful intro from a dead end is usually whether the company has real hiring demand for {{custom_talent_type}}.|a useful intro usually comes down to one thing — whether the company has real hiring demand for {{custom_talent_type}}.}}

{{random|We've identified a handful of {{custom_buyer_type}} currently hiring that look relevant for your team.|We've found several {{custom_buyer_type}} currently hiring that look relevant for your team.|We identified a few {{custom_buyer_type}} currently hiring that look like a fit for your team.}} {{random|We reach out, qualify whether the need is real, and introduce recruiting firms to those hiring teams — only charging when a qualified introduction is made.|We reach out, confirm the need is real, and introduce recruiting firms to those hiring teams — only charging when a qualified introduction is made.|We handle outreach, confirm the need is real, and introduce recruiting firms to those hiring teams — you only pay when a qualified introduction is made.}}

${CTA}

${SIG}`
  }
];

/** HTML bodies for PlusVibe sequence `body` field (div + br only).
 *  One blank line between paragraphs → two <br> tags. */
export function toHtmlBody(plain: string): string {
  const lines = plain
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  return `<div>\n${lines.join("\n<br></br>\n<br></br>\n")}\n</div>`;
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
