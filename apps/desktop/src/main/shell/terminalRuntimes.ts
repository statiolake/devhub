/**
 * One tmux adapter per machine, and one place that says so.
 *
 * There is one tmux server per machine, DevHub owns one socket on each of
 * them, and `TmuxTerminalRuntime` speaks to exactly one server — so there is
 * one adapter per machine and it is built the same way for every machine: the
 * tmux and shell names the config gives, resolved *on that machine* by
 * `Runtime.resolveProgram`, its `$HOME` read from it, and every command sent
 * through its `exec`.
 *
 * The cache is not an optimisation, for the same reason `runtimeFor`'s is not:
 * an adapter *owns* things — the in-flight bring-up per socket, the accepted
 * tmux version, the operation gate a socket transition holds — and two of them
 * for one machine would be two gates, so a transition on one would not exclude
 * an attach through the other. It is keyed by `RuntimeId` and disposed with the
 * machine, beside `runtimeFor`, so "which adapters exist" has one answer.
 *
 * Building one costs round trips (a `$HOME`, two `command -v`), so it is done
 * once per machine and shared by everything that asks — which is why `for`
 * returns a promise and caches the promise rather than the value: two attaches
 * that arrive together on a machine DevHub has not spoken to yet must produce
 * one adapter, not two that raced.
 */

import {
	TmuxTerminalRuntime,
	type RuntimeExecutable,
} from "../terminal/tmux.js";
import { runtimeUnavailableMessage } from "../../ipc/settings.js";
import type { Runtime, RuntimeId } from "../runtime/runtime.js";
import type { Config } from "../../model/config.js";
import type { SocketName } from "../terminal/ports.js";

export interface TerminalRuntimesOptions {
	readonly config: Config | undefined;
	/**
	 * The one environment every DevHub child is launched with, resolved once at
	 * startup (see `loginEnvironment.ts`). The terminal must not observe an
	 * environment that changed under it, and the shell inside tmux inherits
	 * exactly this.
	 */
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly effectiveSocketName: string;
}

export class TerminalRuntimes {
	readonly #options: TerminalRuntimesOptions;
	readonly #adapters = new Map<RuntimeId, Promise<TmuxTerminalRuntime>>();
	#socketName: string;

	constructor(options: TerminalRuntimesOptions) {
		this.#options = options;
		this.#socketName = options.effectiveSocketName;
	}

	/**
	 * The adapter for one machine, built if this is the first time it is asked
	 * for.
	 */
	async for(host: Runtime): Promise<TmuxTerminalRuntime> {
		const existing = this.#adapters.get(host.id);
		if (existing) return existing;
		const built = this.#build(host);
		this.#adapters.set(host.id, built);
		// A machine that could not be reached must not leave a rejected promise
		// in the cache: every later attach would be answered with the failure of
		// the first one, and a host that came back would never be tried again.
		built.catch(() => {
			if (this.#adapters.get(host.id) === built) this.#adapters.delete(host.id);
		});
		return built;
	}

	/** Every adapter that has been built, for shutdown and for a reading. */
	async live(): Promise<readonly TmuxTerminalRuntime[]> {
		const built: TmuxTerminalRuntime[] = [];
		for (const pending of this.#adapters.values()) {
			// A machine that failed to answer has no adapter to shut down, and
			// that is the whole of what its rejection means here.
			const adapter = await pending.catch(() => undefined);
			if (adapter) built.push(adapter);
		}
		return built;
	}

	/**
	 * Let go of a machine no Workspace is on any more.
	 *
	 * The tmux sessions on it stay: that is the point of the runtime, and the
	 * adapter is only the thing that talks to them.
	 */
	forget(machine: RuntimeId): void {
		this.#adapters.delete(machine);
	}

	/**
	 * The socket every adapter is on, changed for all of them at once.
	 *
	 * A socket name is a config value and the config is one file, so a machine
	 * whose adapter was built before the change and one built after must not
	 * end up on two different sockets — which is a set of sessions DevHub can
	 * no longer see rather than a slower answer.
	 */
	async setEffectiveSocket(name: SocketName): Promise<void> {
		this.#socketName = name;
		for (const adapter of await this.live()) adapter.setEffectiveSocket(name);
	}

	async #build(host: Runtime): Promise<TmuxTerminalRuntime> {
		const config = this.#options.config;
		const searchPath = this.#options.environment["PATH"] ?? "";
		const configuredTmux = config?.runtimes.tmux ?? "tmux";
		const configuredShell = config?.runtimes.shell ?? "/bin/zsh";
		const [home, scratch, tmux, shell] = await Promise.all([
			host.home(),
			host.scratchDirectory(),
			host.resolveProgram(configuredTmux, searchPath),
			host.resolveProgram(configuredShell, searchPath),
		]);
		return new TmuxTerminalRuntime({
			context: { home, environment: this.#options.environment },
			tmux: executable(tmux, configuredTmux, host.where),
			shell:
				shell.kind === "unavailable"
					? undefined
					: {
							path: shell.value,
							basename: basenameOf(configuredShell),
						},
			tmuxArgs: config?.runtimes.tmux_args ?? [],
			effectiveSocketName: this.#socketName,
			bootstrapDirectory: scratch,
			host,
		});
	}
}

function basenameOf(configured: string): string {
	return configured.split("/").at(-1) ?? configured;
}

/**
 * An executable the runtime can launch, or the sentence saying why not.
 *
 * The reason is kept rather than reduced to `undefined`: a pane that refuses
 * to attach an hour later has no other way to say which executable was missing
 * and where DevHub looked for it — and, now that "where" can be another
 * computer, which machine it looked on. That is the whole of the "hosts
 * without tmux" answer: not a new predicate, the sentence this already had
 * with a host in it.
 */
function executable(
	resolved: Awaited<ReturnType<Runtime["resolveProgram"]>>,
	configured: string,
	where: string,
): RuntimeExecutable {
	if (resolved.kind === "unavailable") {
		return {
			kind: "unavailable",
			reason: `${runtimeUnavailableMessage(resolved)}${where === "" ? "" : ` (looked${where})`}`,
		};
	}
	return {
		kind: "resolved",
		value: { path: resolved.value, basename: basenameOf(configured) },
	};
}
