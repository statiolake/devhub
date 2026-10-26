/**
 * Terminal mode's managed Neovims, one set per machine.
 *
 * On this Mac a managed Neovim is the person's `nvim`, reached over a unix
 * socket here (phase 1). On an SSH host it is the Neovim DevHub terraformed
 * there (`editor/neovimTerraform.ts`), reached through a relay over the
 * host's ssh connection (`editor/neovimRelay.ts`). The lifecycle above both
 * is the same `ManagedNeovims`; what differs is its ports, so there is one
 * per machine and this is where each is assembled. See
 * `docs/terminal-mode.md`.
 */

import {
	ManagedNeovims,
	type EditorPanes,
	type NeovimFiles,
} from "../editor/managedNeovim.js";
import {
	neovimConfigDirectory,
	readNeovimConfig,
	type LocalNeovimConfig,
} from "../editor/neovimConfig.js";
import type { NeovimDelivery } from "../editor/neovimDelivery.js";
import {
	connectThroughRelay,
	relayArgv,
	spawnRelayProcess,
} from "../editor/neovimRelay.js";
import type { NeovimRpc } from "../editor/neovimRpc.js";
import {
	NeovimTerraform,
	type TerraformedNeovim,
	type TerraformShell,
} from "../editor/neovimTerraform.js";
import { shellQuote } from "../runtime/quote.js";
import type { Runtime, RuntimeId } from "../runtime/runtime.js";
import { OperationDeadline } from "../terminal/command.js";
import { CancellationToken } from "../terminal/ports.js";
import { remoteCliBinDirectory } from "../terminal/launcher.js";
import type { TmuxTerminalRuntime } from "../terminal/tmux.js";
import { failureText } from "../../model/wire.js";

export interface NeovimMachinesOptions {
	/** The managed Neovims of this Mac, built as phase 1 built them. */
	readonly local: ManagedNeovims;
	/** A machine's runtime, by id. */
	readonly runtime: (machine: RuntimeId) => Runtime;
	/** A machine's tmux adapter, with tmux on it, or the sentence why not. */
	readonly adapter: (machine: RuntimeId) => Promise<TmuxTerminalRuntime>;
	readonly delivery: NeovimDelivery;
	/** `product.json`'s `serverDataFolderName`. */
	readonly serverDataFolderName: string;
	/** DevHub's control socket here: it tags the pane bin directory there. */
	readonly controlSocketPath: string;
	/** This Mac's login environment and home: where the config is. */
	readonly localEnvironment: () => Readonly<Record<string, string | undefined>>;
	readonly localHome: string;
	/**
	 * What terminal mode has to say about a machine's Neovim, as one standing
	 * condition per machine: the notices of its terraform, or why it failed.
	 * `undefined` takes it down.
	 */
	readonly condition: (machine: RuntimeId, summary: string | undefined) => void;
	/**
	 * Install the remote extension host's files on the machine, for the Node
	 * the `devhub` command there runs on. Rejects with the sentence.
	 */
	readonly installServerFiles: (machine: RuntimeId) => Promise<void>;
	readonly log?: (line: string) => void;
}

/** A runtime's shell, as terraforming asks it: DevHub's own scripts. */
export function terraformShell(runtime: Runtime, name: string): TerraformShell {
	return {
		name,
		sh: (script, options = {}) =>
			runtime.exec({
				argv: ["/bin/sh", "-c", script],
				deadline: OperationDeadline.in(options.timeoutMs ?? 30_000),
				cancel: new CancellationToken(),
				limits: {
					stdoutBytes: 1024 * 1024,
					stderrBytes: 64 * 1024,
					overflow: { kind: "truncate" },
				},
				...(options.stdin === undefined ? {} : { stdin: options.stdin }),
			}),
	};
}

/** The disk half of a managed Neovim, on a machine reached by `exec`. */
export function remoteNeovimFiles(shell: TerraformShell): NeovimFiles {
	return {
		async exists(path) {
			const result = await shell.sh(`[ -e ${shellQuote(path)} ]`);
			return result.code === 0;
		},
		async remove(path) {
			await shell.sh(`rm -f -- ${shellQuote(path)}`);
		},
		async ensurePrivateDirectory(path) {
			const result = await shell.sh(
				`mkdir -p -- ${shellQuote(path)} && chmod 700 ${shellQuote(path)}`,
			);
			if (result.code !== 0) {
				throw new Error(
					`DevHub could not make ${path} on ${shell.name}: ${Buffer.from(result.stderr).toString("utf8").trim()}`,
				);
			}
		},
	};
}

/** The tmux half, on a machine's own adapter. */
export function adapterPanes(
	adapter: () => Promise<TmuxTerminalRuntime>,
): EditorPanes {
	return {
		open: async (target, argv) =>
			(await adapter()).openEditorWindow(target, argv),
		state: async (target, paneId) =>
			(await adapter()).editorPaneState(target, paneId),
		activate: async (target, paneId) => {
			await (await adapter()).activateEditorPane(target, paneId);
		},
		kill: async (target, paneId) => {
			await (await adapter()).killEditorPane(target, paneId);
		},
	};
}

/** The machine's name in a sentence: `build-box` for `ssh:build-box`. */
function machineName(machine: RuntimeId): string {
	return machine.startsWith("ssh:") ? machine.slice("ssh:".length) : machine;
}

export class NeovimMachines {
	readonly #options: NeovimMachinesOptions;
	readonly #remote = new Map<RuntimeId, ManagedNeovims>();
	readonly #terraforms = new Map<RuntimeId, NeovimTerraform>();
	/** The `devhub` command's server install, once per machine per start. */
	readonly #serverFiles = new Map<RuntimeId, Promise<void>>();
	/** What each machine's condition is made of, said together. */
	readonly #said = new Map<
		RuntimeId,
		{ terraform?: readonly string[]; server?: string }
	>();

	constructor(options: NeovimMachinesOptions) {
		this.#options = options;
	}

	/** The managed Neovims of one machine. */
	on(machine: RuntimeId): ManagedNeovims {
		if (machine === "local") return this.#options.local;
		const existing = this.#remote.get(machine);
		if (existing) return existing;
		const built = this.#build(machine);
		this.#remote.set(machine, built);
		return built;
	}

	/**
	 * Terraform a machine now, ahead of any jump — its editor area was just
	 * shown — so that `nvim` in a pane there is already DevHub's, and what is
	 * missing on it is said before anybody needs it. Never throws: a failure is
	 * the machine's condition.
	 */
	warm(machine: RuntimeId): void {
		if (machine === "local") return;
		void this.#terraformed(machine).catch(() => undefined);
	}

	/** Every connection let go of; nothing killed. See `ManagedNeovims.dispose`. */
	dispose(): void {
		this.#options.local.dispose();
		for (const neovims of this.#remote.values()) neovims.dispose();
	}

	#terraform(machine: RuntimeId): NeovimTerraform {
		const existing = this.#terraforms.get(machine);
		if (existing) return existing;
		const options = this.#options;
		const terraform = new NeovimTerraform({
			shell: terraformShell(options.runtime(machine), machineName(machine)),
			delivery: options.delivery,
			serverDataFolderName: options.serverDataFolderName,
			wrapperDirectory: (home) =>
				remoteCliBinDirectory(home, options.controlSocketPath),
			config: () => this.#localConfig(),
		});
		this.#terraforms.set(machine, terraform);
		return terraform;
	}

	#localConfig(): Promise<LocalNeovimConfig> {
		return readNeovimConfig(
			neovimConfigDirectory(
				this.#options.localEnvironment(),
				this.#options.localHome,
			),
		);
	}

	/** The machine terraformed, its condition said either way. */
	async #terraformed(machine: RuntimeId): Promise<TerraformedNeovim> {
		const options = this.#options;
		// tmux first: the wrapper goes into the directory DevHub's panes there
		// have on their PATH, and an adapter is what says whether there are
		// panes there at all.
		await options.adapter(machine);
		let terraformed: TerraformedNeovim;
		try {
			terraformed = await this.#terraform(machine).prepare();
		} catch (failure: unknown) {
			this.#say(machine, { terraform: [failureText(failure)] });
			throw failure;
		}
		this.#say(machine, { terraform: terraformed.notices });
		this.#serverFilesOn(machine);
		return terraformed;
	}

	#say(
		machine: RuntimeId,
		part: { terraform?: readonly string[]; server?: string | undefined },
	): void {
		const said = { ...this.#said.get(machine), ...part };
		this.#said.set(machine, said);
		const sentences = [
			...(said.terraform ?? []),
			...(said.server === undefined ? [] : [said.server]),
		];
		this.#options.condition(
			machine,
			sentences.length === 0 ? undefined : sentences.join(" "),
		);
	}

	/**
	 * The `devhub` command on the machine needs the server's Node; in VS Code
	 * mode a workbench installs it, in terminal mode this does — in the
	 * background, because it is a hundred megabytes the first time and no jump
	 * waits on it. Its failure is a sentence in the condition, never a reason
	 * to refuse the editor.
	 */
	#serverFilesOn(machine: RuntimeId): void {
		if (this.#serverFiles.has(machine)) return;
		const pending = this.#options.installServerFiles(machine).then(
			() => {
				this.#say(machine, { server: undefined });
			},
			(failure: unknown) => {
				this.#serverFiles.delete(machine);
				this.#say(machine, {
					server: `The devhub command on ${machineName(machine)} cannot run, so a pane or an Agent there cannot open files in DevHub: ${failureText(failure)}`,
				});
			},
		);
		this.#serverFiles.set(machine, pending);
	}

	#build(machine: RuntimeId): ManagedNeovims {
		const options = this.#options;
		const runtime = options.runtime(machine);
		const shell = terraformShell(runtime, machineName(machine));
		return new ManagedNeovims({
			panes: adapterPanes(() => options.adapter(machine)),
			nvim: async () => {
				const terraformed = await this.#terraformed(machine);
				// A new Neovim starts with the configuration as it is now on
				// this Mac, not as it was when DevHub first reached the host.
				await this.#terraform(machine).syncConfig();
				return terraformed.nvim;
			},
			socketDirectory: async () =>
				(await this.#terraformed(machine)).socketDirectory,
			connect: async (socketPath): Promise<NeovimRpc> => {
				const terraformed = await this.#terraformed(machine);
				const launch = await runtime.commandLaunch(
					relayArgv(terraformed.binary.path, terraformed.relayPath, socketPath),
				);
				return connectThroughRelay(spawnRelayProcess(launch), socketPath, {
					log: (line) => {
						options.log?.(
							`[devhub] Neovim relay on ${machineName(machine)}: ${line}`,
						);
					},
				});
			},
			files: remoteNeovimFiles(shell),
			// A round trip per poll over ssh, so a longer budget and a slower
			// poll than this Mac's.
			startTimeoutMs: 15_000,
			pollMs: 250,
			onExit: (workspaceId) => {
				options.log?.(
					`[devhub] the managed Neovim of ${workspaceId} on ${machineName(machine)} ended`,
				);
			},
		});
	}
}
