/**
 * The list prices the Tokens view weighs usage by, pinned in this one place.
 *
 * What a request would cost at Anthropic's first-party API list price, per
 * million tokens, for the Claude models DevHub can run. It is an **estimate**:
 * a person on a Claude plan is not billed this — their plan's 5-hour and weekly
 * windows are what limit them — and a key on Bedrock or Vertex is billed at
 * that provider's own prices. It is here to compare agents by what their usage
 * weighs, cache taken into account, not to forecast a bill.
 *
 * Each row: base input, output, and the cache read price, which is not one
 * multiple of input across models (0.1× on most, 0.05× on Opus 5.5 and Sonnet
 * 5.5, 0.025× on Fable 5.1 and 5.2). Cache writes are 1.25× base input for the
 * 5-minute TTL and 2× for the 1-hour one, on every model. Fast mode, where a
 * model has it, is its own row of prices (`fast`). Haiku 5.5 has a long-prompt
 * tier: a request whose prompt (input, cache reads and writes together) is over
 * 100K tokens is priced at `longPrompt`.
 *
 * Pinned 2026-11-13 from Anthropic's published model table. A model not in it
 * (Codex's, an older Claude) is shown with its tokens and no cost: "unpriced".
 *
 * Pure: no I/O.
 */

/** US dollars per million tokens. */
export interface TokenRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
}

export interface ModelPrice extends TokenRates {
  /** The model id as the API names it, without a date or `[1m]`. */
  readonly model: string;
  readonly label: string;
  /** Fast mode's prices, where the model has it. */
  readonly fast?: TokenRates;
  /** Prices over `longPrompt.overTokens` of prompt. */
  readonly longPrompt?: TokenRates & { readonly overTokens: number };
}

/** When the table was taken from Anthropic's published prices. */
export const PRICES_AS_OF = "2026-11-13";

/** Cache writes, as multiples of base input. */
export const CACHE_WRITE_5M = 1.25;
export const CACHE_WRITE_1H = 2;

const rates = (
  input: number,
  output: number,
  cacheRead: number,
): TokenRates => ({ input, output, cacheRead });

/** Most specific first: `claude-opus-5-5` before `claude-opus-5`. */
export const PRICE_TABLE: readonly ModelPrice[] = [
  {
    model: "claude-fable-5-2",
    label: "Fable 5.2",
    ...rates(8, 40, 0.2),
    fast: rates(16, 80, 0.4),
  },
  { model: "claude-mythos-5-2", label: "Mythos 5.2", ...rates(8, 40, 0.2) },
  { model: "claude-fable-5-1", label: "Fable 5.1", ...rates(10, 50, 0.25) },
  { model: "claude-mythos-5-1", label: "Mythos 5.1", ...rates(10, 50, 0.25) },
  { model: "claude-fable-5", label: "Fable 5", ...rates(10, 50, 1) },
  { model: "claude-mythos-5", label: "Mythos 5", ...rates(10, 50, 1) },
  {
    model: "claude-opus-5-5",
    label: "Opus 5.5",
    ...rates(4, 20, 0.2),
    fast: rates(8, 40, 0.4),
  },
  { model: "claude-opus-5", label: "Opus 5", ...rates(5, 25, 0.5) },
  { model: "claude-opus-4-8", label: "Opus 4.8", ...rates(5, 25, 0.5) },
  { model: "claude-opus-4-7", label: "Opus 4.7", ...rates(5, 25, 0.5) },
  { model: "claude-opus-4-6", label: "Opus 4.6", ...rates(5, 25, 0.5) },
  { model: "claude-sonnet-5-5", label: "Sonnet 5.5", ...rates(2, 10, 0.1) },
  { model: "claude-sonnet-5", label: "Sonnet 5", ...rates(2, 10, 0.2) },
  { model: "claude-sonnet-4-6", label: "Sonnet 4.6", ...rates(3, 15, 0.3) },
  {
    model: "claude-haiku-5-5",
    label: "Haiku 5.5",
    ...rates(0.1, 0.5, 0.01),
    longPrompt: { ...rates(0.5, 2.5, 0.05), overTokens: 100_000 },
  },
  { model: "claude-haiku-4-5", label: "Haiku 4.5", ...rates(1, 5, 0.1) },
];

/**
 * The model id as the price table names it: lower case, without a provider
 * prefix (`anthropic.`, `us.anthropic.`), a context suffix (`[1m]`), a
 * Vertex `@version` or a date (`-20251001`).
 */
export function canonicalModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/u, "")
    .replace(/^(?:[a-z]{2,4}\.)?anthropic\./u, "")
    .replace(/@.*$/u, "")
    .replace(/-\d{8}$/u, "")
    .replace(/-v\d+(?::\d+)?$/u, "");
}

/** The price row of a model, or undefined: unpriced. */
export function priceOf(model: string): ModelPrice | undefined {
  const id = canonicalModel(model);
  return PRICE_TABLE.find(
    (row) => id === row.model || id.startsWith(`${row.model}-`),
  );
}

/** A short name for a model: the table's label, else its id. */
export function modelLabel(model: string): string {
  return priceOf(model)?.label ?? canonicalModel(model);
}

/** What one request read, wrote and generated. */
export interface TokenCounts {
  /** Input not read from the cache nor written to it. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
}

/** The rates one request is priced at, or undefined: unpriced. */
export function ratesFor(
  model: string,
  counts: TokenCounts,
  fast = false,
): TokenRates | undefined {
  const row = priceOf(model);
  if (row === undefined) return undefined;
  if (fast && row.fast !== undefined) return row.fast;
  const prompt =
    counts.input + counts.cacheRead + counts.cacheWrite5m + counts.cacheWrite1h;
  if (row.longPrompt !== undefined && prompt > row.longPrompt.overTokens)
    return row.longPrompt;
  return row;
}

/**
 * The request's input as tokens at base input price: uncached input at 1,
 * cache reads at the model's read price over its input price, cache writes at
 * 1.25 and 2. What "cache-aware" input means in the view.
 */
export function weightedInput(counts: TokenCounts, at: TokenRates): number {
  return (
    counts.input +
    (counts.cacheRead * at.cacheRead) / at.input +
    counts.cacheWrite5m * CACHE_WRITE_5M +
    counts.cacheWrite1h * CACHE_WRITE_1H
  );
}

/** Estimated list-price cost of one request, in US dollars. */
export function costOf(counts: TokenCounts, at: TokenRates): number {
  return (
    (counts.input * at.input +
      counts.cacheRead * at.cacheRead +
      counts.cacheWrite5m * at.input * CACHE_WRITE_5M +
      counts.cacheWrite1h * at.input * CACHE_WRITE_1H +
      counts.output * at.output) /
    1_000_000
  );
}
