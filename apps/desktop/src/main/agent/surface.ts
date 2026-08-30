/**
 * Provider-free Agent Surface control seam.
 *
 * Ported 1:1 from `src-tauri/src/agent/surface.rs`, minus the Rust `Drop`
 * implementation: JavaScript has no destructor, so a surface is released only
 * by an explicit `detach()`. Every owner of a surface in this port
 * (`AgentSurfaceManager`, the runtime's cleanup path) detaches it on the way
 * out — dropping a surface on the floor would leak a Herdr control socket, and
 * there is no runtime that will notice for us.
 */

import type { HerdrAgentRuntime } from "./runtime.js";
import type { AgentId } from "./ports.js";

/**
 * A writable Agent Surface owns a logical DevHub surface key, never a Herdr
 * pane or terminal identifier. Herdr IDs stay inside the runtime methods.
 */
export class AgentSurface {
	readonly #runtime: HerdrAgentRuntime;
	readonly agentId: AgentId;
	readonly surfaceKey: string;

	constructor(
		runtime: HerdrAgentRuntime,
		agentId: AgentId,
		surfaceKey: string,
	) {
		this.#runtime = runtime;
		this.agentId = agentId;
		this.surfaceKey = surfaceKey;
	}

	async sendText(text: string): Promise<void> {
		await this.#runtime.surfaceSendText(this.agentId, this.surfaceKey, text);
	}

	async readRecent(): Promise<Buffer> {
		return this.#runtime.surfaceReadRecent(this.agentId, this.surfaceKey);
	}

	detach(): void {
		this.#runtime.surfaceDetach(this.agentId, this.surfaceKey);
	}
}
