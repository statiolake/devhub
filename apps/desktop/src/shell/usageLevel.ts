/**
 * How near its end a measure of use is, as every usage meter colours it: the
 * context under the composer and the Sidebar's rate-limit readout. One rule,
 * so a bar that is coloured in one place is coloured the same in the other. A meter is quiet until it is `near` (75%), drawn in the
 * warning ink (`--waiting`), and in the danger ink (`--danger`) when `at` its
 * end (90%); nothing about a measure far from its end is worth colour.
 */
export type UsageLevel = "calm" | "near" | "at";

export function usageLevel(percent: number | undefined): UsageLevel {
  if (percent === undefined || percent < 75) return "calm";
  return percent < 90 ? "near" : "at";
}
