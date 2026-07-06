import type { GtmMotion } from "./classifyGtmMotion.js";

export type GtmOutreachFrame = {
  connectOutcome: string;
  buyerPersonaHint: string;
  performanceLine: string;
  ctaOpener: string;
  timeframe: string;
};

const PERFORMANCE_LINES = [
  "We operate entirely on a performance basis, meaning we only get paid when the meetings actually hit your calendar.",
  "We work strictly on a performance basis—you only pay for results, not promises.",
  "Our model is 100% performance-based, so you only pay when the conversations land on your calendar.",
  "We handle this entirely on a performance basis, so we only get paid when the meetings land.",
  "Because we're 100% performance-based, you only pay when we actually deliver the pipeline."
] as const;

const CTA_OPENERS = [
  "Worth a quick call to go over the",
  "Let me know if you're open to a quick call to look over the",
  "Open to a quick call to review the",
  "Would you be open to a quick call this week to look over the",
  "Open to a quick call to go over the"
] as const;

export function gtmOutreachFrame(motion: GtmMotion, accountListSize: number): GtmOutreachFrame {
  switch (motion) {
    case "enterprise_sales":
      return {
        connectOutcome: "4–6 qualified buyers for buying conversations this quarter",
        buyerPersonaHint: "enterprise decision-makers and budget owners in their category",
        performanceLine: PERFORMANCE_LINES[1]!,
        ctaOpener: CTA_OPENERS[1]!,
        timeframe: "this quarter"
      };
    case "marketplace":
      return {
        connectOutcome: "12–18 qualified supplier-side leads for activation conversations over the next 60 days",
        buyerPersonaHint: "supply-side operators whose revenue model matches the platform",
        performanceLine: PERFORMANCE_LINES[3]!,
        ctaOpener: CTA_OPENERS[3]!,
        timeframe: "the next 60 days"
      };
    case "hybrid_plg_sales":
      return {
        connectOutcome: "8 qualified sales conversations from mid-market accounts that fit their ICP within 60 days",
        buyerPersonaHint: "mid-market accounts that never self-activate",
        performanceLine: PERFORMANCE_LINES[4]!,
        ctaOpener: CTA_OPENERS[4]!,
        timeframe: "within 60 days"
      };
    case "plg":
      return {
        connectOutcome: "30 qualified signups from accounts that match their ICP within 60 days",
        buyerPersonaHint: "teams that fit their product profile but haven't signed up",
        performanceLine: PERFORMANCE_LINES[4]!,
        ctaOpener: CTA_OPENERS[2]!,
        timeframe: "within 60 days"
      };
    case "sales_led_b2b":
    default:
      return {
        connectOutcome: "15–20 qualified buyers for demos over the next 60 days",
        buyerPersonaHint: "buyers in their target market who match their ICP",
        performanceLine: PERFORMANCE_LINES[0]!,
        ctaOpener: CTA_OPENERS[0]!,
        timeframe: "the next 60 days"
      };
  }
}

export function buildCtaTemplate(frame: GtmOutreachFrame, companyName: string, accountListSize: number): string {
  const supplyHint = frame.connectOutcome.includes("supplier") ? " for your supply side" : "";
  return `${frame.ctaOpener} ${accountListSize} high-value accounts our system just flagged for ${companyName}${supplyHint}?`;
}

export function buildValueLineTemplate(frame: GtmOutreachFrame, buyerPhrase: string): string {
  const connect = frame.connectOutcome.replace("qualified buyers", buyerPhrase);
  return `We can connect you with ${connect}. ${frame.performanceLine}`;
}
