/**
 * The results an adapter hands back.
 *
 * These are the model's own vocabulary re-exported under names the adapters can
 * import without reaching into the coordinator's intent module — so a terminal
 * or Agent adapter depends on this small file and nothing else of the shell's.
 */

export type {
	AgentLaunchResult,
	AgentStopResult,
} from "../../model/intents.js";
export type { AgentReconciliation as AgentReconciliationResult } from "../../model/domain.js";
