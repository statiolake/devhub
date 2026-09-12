/**
 * What a loop over a machine is allowed to cost, as arithmetic.
 *
 * A constant in the loop is a constant for every machine, and the number that
 * is right for a fork on this Mac is a flood on a host across an ocean. So the
 * loops read `Runtime.cadence` (`runtime.ts`), and a runtime that talks over a
 * network derives its number here.
 *
 * The rule is one line — `clamp(8 × median round trip, 500, 3000)` — and the
 * property it exists for is not any of those three numbers. It is that a
 * reconcile loop spends at most an eighth of the wall clock in flight,
 * whatever the link: a 5 ms LAN host lands on the floor, a 60 ms host lands on
 * the floor, a 300 ms satellite link lands at 2.4 s and stays honest about it.
 * A person on a slow link sees Agent status lag by seconds, and that is
 * reported in `devhub --metrics` rather than hidden by polling harder.
 *
 * The floor is here because a link fast enough to poll faster than half a
 * second is a link whose cost is not the round trip, and the ceiling because a
 * status nobody has looked at for three seconds is stale enough that a person
 * would rather DevHub kept asking than gave up. Past 375 ms the ceiling and
 * the duty cycle disagree and the ceiling wins, so the eighth is a bound up to
 * there and not beyond it — asserted in the tests rather than glossed, because
 * "bounded by construction" would be a claim that stops being true exactly
 * where somebody would need it.
 *
 * This is deliberately *not* what the local runtime uses. A local exec has no
 * round trip to measure — its median is zero, and eight times nothing clamped
 * to the floor would slow the local reconciler from 300 ms to 500 ms for no
 * reason anybody could name. `LOCAL_CADENCE` (`local.ts`) states this machine's
 * numbers directly, which is the honest shape for a machine with no latency.
 */

/** What fraction of the wall clock a reconcile loop may spend in flight. */
export const RECONCILE_DUTY_CYCLE = 8;
/** The fastest a loop over a network will ever run. */
export const REMOTE_RECONCILE_FLOOR_MS = 500;
/** The slowest, past which DevHub would rather be stale than give up. */
export const REMOTE_RECONCILE_CEILING_MS = 3_000;

/**
 * How often to reconcile a machine whose commands cost `medianRoundTripMs`.
 *
 * A median that has not been measured yet is zero, which lands on the floor —
 * the right answer for a first round, because a first round is also how the
 * median gets its first sample.
 */
export function remoteReconcileIntervalMs(medianRoundTripMs: number): number {
	if (!Number.isFinite(medianRoundTripMs) || medianRoundTripMs < 0) {
		// A median that is not a number is a measurement that went wrong, and
		// the loop still has to run. It runs at the ceiling: the cheapest
		// cadence there is, chosen because the one thing known about this link
		// is that DevHub cannot say what it costs.
		return REMOTE_RECONCILE_CEILING_MS;
	}
	return Math.min(
		REMOTE_RECONCILE_CEILING_MS,
		Math.max(
			REMOTE_RECONCILE_FLOOR_MS,
			Math.round(RECONCILE_DUTY_CYCLE * medianRoundTripMs),
		),
	);
}
