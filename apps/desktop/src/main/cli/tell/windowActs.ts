/**
 * `devhub --tell agent stop` and `agent restart`: the window's Stop Agent and
 * Restart Session, by the same intents.
 *
 * The window asks first when the Agent is busy (`interruptsNothing`): the
 * coordinator answers `confirmation_required` and the window draws the sheet
 * for the person. A command line has already decided, so the confirmation is
 * given at once with the sheet's first choice, and nothing is drawn. What the
 * window does not offer (Stop on an Agent that is stopping, Restart on one
 * that is not running) is refused here, as the row and its menu leave it out;
 * the rest of the refusals are the coordinator's own (`agentRestart` and the
 * like), which reach the caller in its words.
 */

import {
	interruptsNothing,
	type AgentControlState,
	type AgentFailureCode,
	type AgentId,
	type AgentStatus,
} from "../../../model/domain.js";
import type { IntentOutcome, UserIntent } from "../../../model/intents.js";
import type { TellStopped } from "./service.js";

export interface ActedAgent {
	readonly id: AgentId;
	readonly displayName: string;
	readonly status: AgentStatus;
	readonly controlState: AgentControlState;
	readonly failure?: { readonly code: AgentFailureCode } | undefined;
}

export type Dispatch = (intent: UserIntent) => Promise<IntentOutcome>;

/** Stop Agent, or the row's Retry Stop after a Stop that failed. */
export async function stopAsTheRowDoes(
	agent: ActedAgent,
	dispatch: Dispatch,
): Promise<TellStopped> {
	if (agent.controlState.kind === "stopping")
		throw new Error(`${agent.displayName} is already stopping.`);
	const busy = !interruptsNothing(agent);
	if (agent.controlState.kind === "stop-failed") {
		await dispatch({ type: "retry_stop_agent", agentId: agent.id });
		return { busy, movedTerminal: false, retried: true };
	}
	const outcome = await dispatch({ type: "stop_agent", agentId: agent.id });
	if (outcome.kind !== "confirmation_required")
		return { busy, movedTerminal: false, retried: false };
	// The sheet's first choice for an open terminal keeps what runs in it.
	const terminal =
		outcome.purpose.kind === "agent_stop" && outcome.purpose.terminal;
	await dispatch({
		type: "confirm_stop_agent",
		confirmationId: outcome.confirmationId,
		...(terminal ? { moveTerminal: true } : {}),
	});
	return { busy, movedTerminal: terminal, retried: false };
}

/** Restart Session, which the row menu offers a running Agent only. */
export async function restartAsTheMenuDoes(
	agent: ActedAgent,
	dispatch: Dispatch,
): Promise<{ readonly busy: boolean }> {
	if (agent.controlState.kind !== "running")
		throw new Error(
			`${agent.displayName} is ${agent.controlState.kind === "stopping" ? "stopping" : "not running: its Stop failed"}, and only a running agent's session can be restarted.`,
		);
	const busy = !interruptsNothing(agent);
	const outcome = await dispatch({ type: "restart_agent", agentId: agent.id });
	if (outcome.kind === "confirmation_required")
		await dispatch({
			type: "confirm_restart_agent",
			confirmationId: outcome.confirmationId,
		});
	return { busy };
}
