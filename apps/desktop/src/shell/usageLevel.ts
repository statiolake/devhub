/**
 * How near its end a measure of use is, as every usage meter colours it: the
 * context under the composer, the Sidebar's rate-limit readout and the bars in
 * its tooltip. One rule, so a bar that is orange in one place is orange in the
 * others. A meter is quiet until it is `near` (80%) and red when `at` its end
 * (95%); nothing about a measure far from its end is worth colour.
 */
export type UsageLevel = "calm" | "near" | "at";

export function usageLevel(percent: number | undefined): UsageLevel {
  if (percent === undefined || percent < 80) return "calm";
  return percent < 95 ? "near" : "at";
}
