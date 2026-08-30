/**
 * AgentRuntime implementation over the hidden Herdr session.
 *
 * Ported from `src-tauri/src/agent/runtime.rs`. The Rust version ran every
 * operation on its own thread behind a `Mutex`-based operation gate and
 * returned a hand-rolled future; here each operation is an `async` method and
 * the gate is a promise queue. That is the only structural change: the stage
 * order, the compensation on every failed launch stage, the tombstone journal,
 * the confirmed-agent rule, and every bound are the same.
 */

import { join } from "node:path";

import {
	API_TIMEOUT_MS,
	HerdrTransport,
	Invalidation,
	MAX_TERMINAL_READ_BYTES,
	SubscriptionHandle,
	delay,
	sessionSocketPath,
	transportCheckCapabilities,
	transportOpenControl,
	transportRequestWithTimeout,
	type ProviderTransport,
} from "./api.js";
import {
	HERDR_SESSION_NAME,
	expectedProtocol,
	expectedVersion,
} from "./contract.js";
import {
	AgentRuntimeError,
	AgentRuntimeErrorCode,
	ProviderErrorCategory,
	agentError,
	asAgentError,
} from "./error.js";
import {
	RuntimeLaunchContext,
	type ResolvedExecutable,
} from "./launchContext.js";
import {
	AgentRuntimeHealth,
	AgentRuntimeState,
	MARKER_LABEL_PREFIX,
	MAX_SURFACE_KEY_BYTES,
	MAX_TOMBSTONE_ATTEMPTS,
	TombstoneReason,
	cleanupMappingFromCreated,
	decodeProviderMapping,
	encodeProviderMapping,
	loadCleanupJournal,
	mappingsEqual,
	markerLabel,
	paneFor,
	parseCreatedMapping,
	parseSessionSnapshot,
	projectProviderStatus,
	providerAgentName,
	providerStatusIsExited,
	recoverMapping,
	saveCleanupJournal,
	terminalIdFromStarted,
	validateProfile,
	type ProviderMapping,
	type ProviderProfile,
	type ProviderSnapshot,
} from "./model.js";
import {
	CancellationToken,
	PortError,
	PortErrorCode,
	cancelledPort,
	conflictPort,
	failedPort,
	isUuid,
	unavailablePort,
	type AgentId,
	type AgentLaunchReceipt,
	type AgentObservation,
	type AgentProfile,
	type AgentReconciliation,
	type OpaqueProviderMapping,
	type WorkspaceId,
} from "./ports.js";
import { AgentSurface } from "./surface.js";

const BOOTSTRAP_TIMEOUT_MS = 8_000;
const BOOTSTRAP_POLL_MS = 50;
const CLEANUP_TIMEOUT_MS = 5_000;
const CLEANUP_POLL_MS = 50;
/**
 * Bound Herdr's interactive command readiness explicitly. Keeping this in the
 * adapter avoids depending on a provider-side default that can change between
 * pinned Herdr releases.
 */
const AGENT_START_TIMEOUT_MS = 30_000;
const AGENT_START_TRANSPORT_TIMEOUT_MS = 31_000;
/**
 * Herdr acknowledges `workspace.create` before the new pane's interactive
 * shell has necessarily completed startup. Match the pinned provider's
 * observable readiness window without retrying a mutating request blindly.
 */
const PANE_SHELL_READINESS_TIMEOUT_MS = 2_000;
const PANE_SHELL_READINESS_POLL_MS = 100;
const VERSION_PROBE_TIMEOUT_MS = 2_000;
const MAX_VERSION_OUTPUT_BYTES = 16 * 1024;

/**
 * Serializes mutations and reconciliation. Subscription callbacks never
 * acquire this gate; they only set an invalidation hint.
 */
class OperationGate {
	#tail: Promise<void> = Promise.resolve();

	async acquire(cancel: CancellationToken): Promise<() => void> {
		if (cancel.isCancelled) {
			throw cancelledPort();
		}
		const previous = this.#tail;
		let release: () => void = () => {};
		this.#tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		if (cancel.isCancelled) {
			release();
			throw cancelledPort();
		}
		let released = false;
		return () => {
			if (!released) {
				released = true;
				release();
			}
		};
	}
}

/**
 * Closed, provider-private context for the first failed Agent launch.
 *
 * This is intentionally separate from runtime health: health describes the
 * adapter's ability to serve future operations, while this record describes
 * one launch transaction's first failed stage.
 */
export enum AgentLaunchFailureStage {
	ValidateProfile = "validate_profile",
	EnsureReady = "ensure_ready",
	OperationGate = "operation_gate",
	WorkspaceCreate = "workspace_create",
	MappingParse = "mapping_parse",
	AgentStart = "agent_start",
	TerminalParse = "terminal_parse",
	MappingEncode = "mapping_encode",
	StateCommit = "state_commit",
}

export interface AgentLaunchFailure {
	readonly stage: AgentLaunchFailureStage;
	readonly agentRuntimeErrorCode: AgentRuntimeErrorCode | undefined;
	readonly portErrorCode: PortErrorCode | undefined;
	readonly providerErrorCategory: ProviderErrorCategory | undefined;
}

export enum PaneShellState {
	Initializing = "initializing",
	Ready = "ready",
	BusyOrUnknown = "busyOrUnknown",
}

interface RuntimeOptions {
	readonly context: RuntimeLaunchContext;
	readonly transport: ProviderTransport;
	readonly journalPath: string;
	readonly executable: ResolvedExecutable | undefined;
	readonly verifyExecutable: boolean;
}

/**
 * The sole native AgentRuntime implementation. Every provider identity field
 * is private to this class; the public port returns only DevHub values.
 */
export class HerdrAgentRuntime {
	readonly #context: RuntimeLaunchContext;
	readonly #executable: ResolvedExecutable | undefined;
	readonly #transport: ProviderTransport;
	readonly #invalidation = new Invalidation();
	readonly #operationGate = new OperationGate();
	readonly #bootstrapGate = new OperationGate();
	readonly #state = new AgentRuntimeState();
	readonly #journalPath: string;
	readonly #verifyExecutable: boolean;
	#health: AgentRuntimeHealth;
	#subscription: SubscriptionHandle | undefined;
	#journalLoaded = false;
	#lastLaunchFailure: AgentLaunchFailure | undefined;

	private constructor(options: RuntimeOptions) {
		this.#context = options.context;
		this.#executable = options.executable;
		this.#transport = options.transport;
		this.#journalPath = options.journalPath;
		this.#verifyExecutable = options.verifyExecutable;
		this.#health =
			!options.verifyExecutable || options.executable !== undefined
				? AgentRuntimeHealth.starting()
				: AgentRuntimeHealth.unavailable(
						AgentRuntimeErrorCode.MissingExecutable,
					);
	}

	/**
	 * Creates the adapter from a startup-frozen launch context. The returned
	 * runtime is inert until `bootstrap` succeeds; no provider mutation occurs
	 * during construction. `configuredHerdr` is resolved through the context —
	 * an absolute path, a `~` path, or a PATH lookup — never hard-coded.
	 */
	static create(
		context: RuntimeLaunchContext,
		configuredHerdr: string,
		journalPath?: string,
	): HerdrAgentRuntime {
		let executable: ResolvedExecutable | undefined;
		try {
			executable = context.resolve(configuredHerdr);
		} catch {
			// A missing Herdr is a visible health state, not a construction
			// failure: Settings must be able to show why agents are off.
			executable = undefined;
		}
		const xdg = context.environmentValue("XDG_CONFIG_HOME");
		const socketPath = sessionSocketPath(context.home, xdg);
		return new HerdrAgentRuntime({
			context,
			executable,
			transport: new HerdrTransport(socketPath),
			journalPath:
				journalPath ??
				context.environmentValue("DEVHUB_AGENT_RUNTIME_JOURNAL") ??
				join(
					context.home,
					"Library/Application Support/DevHub/agent-runtime-journal.json",
				),
			verifyExecutable: true,
		});
	}

	/**
	 * Test and embedded-host seam. The transport stays provider-private while
	 * isolated fakes and the wire harness exercise the whole lifecycle.
	 */
	static withTransport(
		context: RuntimeLaunchContext,
		transport: ProviderTransport,
		journalPath?: string,
	): HerdrAgentRuntime {
		return new HerdrAgentRuntime({
			context,
			executable: undefined,
			transport,
			journalPath:
				journalPath ??
				join(
					context.home,
					"Library/Application Support/DevHub/agent-runtime-journal.json",
				),
			verifyExecutable: false,
		});
	}

	get health(): AgentRuntimeHealth {
		return this.#health;
	}

	takeLastLaunchFailure(): AgentLaunchFailure | undefined {
		const failure = this.#lastLaunchFailure;
		this.#lastLaunchFailure = undefined;
		return failure;
	}

	#recordLaunchFailure(failure: AgentLaunchFailure): void {
		this.#lastLaunchFailure ??= failure;
	}

	#recordLaunchRuntimeFailure(
		stage: AgentLaunchFailureStage,
		error: AgentRuntimeError,
	): void {
		this.#recordLaunchFailure({
			stage,
			agentRuntimeErrorCode: error.code,
			portErrorCode: error.portCode,
			providerErrorCategory: error.providerCategory,
		});
	}

	#recordLaunchPortFailure(
		stage: AgentLaunchFailureStage,
		error: PortError,
	): void {
		this.#recordLaunchFailure({
			stage,
			agentRuntimeErrorCode: undefined,
			portErrorCode: error.code,
			providerErrorCategory: undefined,
		});
	}

	/**
	 * Stops only DevHub's subscription listener. The provider session, Agents,
	 * and their panes are deliberately left running; a future process can
	 * reconnect from the durable opaque mappings/journal.
	 */
	async shutdown(deadline: number = Date.now() + 5_000): Promise<boolean> {
		const subscription = this.#subscription;
		this.#subscription = undefined;
		return subscription === undefined ? true : subscription.stopUntil(deadline);
	}

	/**
	 * Associates a domain Agent with its Workspace before the coordinator emits
	 * a launch effect. The core AgentRuntime port carries only profile data on
	 * launch, so this narrow registration keeps the required root/workspace
	 * context in the adapter without changing domain contracts.
	 */
	registerAgentWorkspace(
		agentId: AgentId,
		workspaceId: WorkspaceId,
		root: string,
	): void {
		this.#state.workspaceRoots.set(agentId, [workspaceId, root]);
	}

	async bootstrap(cancel: CancellationToken): Promise<AgentRuntimeHealth> {
		const release = await this.#bootstrapGate.acquire(cancel);
		try {
			if (cancel.isCancelled) {
				throw cancelledPort();
			}
			this.#loadJournal();
			if (this.#health.isReady && !this.#invalidation.isDisconnected) {
				return this.#health;
			}

			if (this.#verifyExecutable) {
				if (this.#executable === undefined) {
					this.#health = AgentRuntimeHealth.unavailable(
						AgentRuntimeErrorCode.MissingExecutable,
					);
					throw unavailablePort();
				}
				try {
					await this.#verifyCliVersion(this.#executable, cancel);
				} catch (error) {
					const runtimeError = asAgentError(error);
					this.#health = AgentRuntimeHealth.failed(runtimeError.code);
					throw runtimeError.toPortError();
				}
			}

			let ping: unknown;
			try {
				ping = await this.#ensureServerAndProbe(cancel);
			} catch (error) {
				const runtimeError = asAgentError(error);
				this.#health = AgentRuntimeHealth.unavailable(runtimeError.code);
				throw runtimeError.toPortError();
			}
			try {
				verifyPing(ping);
			} catch (error) {
				const runtimeError = asAgentError(error);
				this.#health = AgentRuntimeHealth.failed(runtimeError.code);
				throw runtimeError.toPortError();
			}

			try {
				await transportCheckCapabilities(this.#transport);
			} catch (error) {
				const runtimeError = asAgentError(error);
				this.#health = AgentRuntimeHealth.failed(runtimeError.code);
				throw runtimeError.toPortError();
			}

			let subscription: SubscriptionHandle;
			try {
				subscription = await this.#transport.subscribe(this.#invalidation);
			} catch (error) {
				const runtimeError = asAgentError(error);
				this.#health = AgentRuntimeHealth.failed(runtimeError.code);
				throw runtimeError.toPortError();
			}
			if (!(await subscription.waitReady(Date.now() + BOOTSTRAP_TIMEOUT_MS))) {
				await subscription.stop();
				this.#health = AgentRuntimeHealth.failed(
					AgentRuntimeErrorCode.Disconnected,
				);
				throw agentError(AgentRuntimeErrorCode.Disconnected).toPortError();
			}
			const previous = this.#subscription;
			this.#subscription = subscription;
			if (previous !== undefined) {
				await previous.stop();
			}
			this.#health = AgentRuntimeHealth.healthy();
			return this.#health;
		} finally {
			release();
		}
	}

	async #ensureServerAndProbe(cancel: CancellationToken): Promise<unknown> {
		try {
			return await this.#transport.request("ping", {});
		} catch (error) {
			const runtimeError = asAgentError(error);
			if (!this.#verifyExecutable) {
				throw runtimeError;
			}
			if (
				runtimeError.code !== AgentRuntimeErrorCode.Disconnected &&
				runtimeError.code !== AgentRuntimeErrorCode.Unavailable &&
				runtimeError.code !== AgentRuntimeErrorCode.Timeout
			) {
				throw runtimeError;
			}
			this.#spawnServer();
			const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS;
			for (;;) {
				if (cancel.isCancelled) {
					throw agentError(AgentRuntimeErrorCode.Cancelled);
				}
				try {
					return await this.#transport.request("ping", {});
				} catch {
					if (Date.now() >= deadline) {
						throw agentError(AgentRuntimeErrorCode.BootstrapFailed);
					}
					await delay(BOOTSTRAP_POLL_MS);
				}
			}
		}
	}

	#spawnServer(): void {
		if (this.#executable === undefined) {
			throw agentError(AgentRuntimeErrorCode.MissingExecutable);
		}
		try {
			const child = this.#context.spawn(
				this.#executable,
				["--session", HERDR_SESSION_NAME, "server"],
				{ stdio: "ignore" },
			);
			child.unref();
		} catch {
			throw agentError(AgentRuntimeErrorCode.BootstrapFailed);
		}
	}

	async #verifyCliVersion(
		executable: ResolvedExecutable,
		cancel: CancellationToken,
	): Promise<void> {
		const child = this.#context.spawn(executable, ["--version"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let overflowed = false;
		child.stdout?.on("data", (chunk: Buffer) => {
			if (
				chunks.reduce((sum, part) => sum + part.length, 0) + chunk.length >
				MAX_VERSION_OUTPUT_BYTES
			) {
				overflowed = true;
				return;
			}
			chunks.push(chunk);
		});
		child.stderr?.resume();
		const exited = new Promise<number | null>((resolve, reject) => {
			child.once("error", () =>
				reject(agentError(AgentRuntimeErrorCode.MissingExecutable)),
			);
			child.once("close", (code) => resolve(code));
		});
		const deadline = Date.now() + VERSION_PROBE_TIMEOUT_MS;
		let status: number | null | undefined;
		while (status === undefined) {
			if (cancel.isCancelled) {
				child.kill("SIGKILL");
				throw agentError(AgentRuntimeErrorCode.Cancelled);
			}
			if (Date.now() >= deadline) {
				child.kill("SIGKILL");
				throw agentError(AgentRuntimeErrorCode.Timeout);
			}
			status = await Promise.race([exited, delay(10).then(() => undefined)]);
		}
		if (overflowed) {
			throw agentError(AgentRuntimeErrorCode.BoundedInput);
		}
		if (status !== 0) {
			throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
		}
		const words = Buffer.concat(chunks)
			.toString("utf8")
			.split(/\s+/)
			.filter((word) => word.length > 0);
		if (
			words.length !== 2 ||
			words[0] !== "herdr" ||
			words[1] !== expectedVersion()
		) {
			throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
		}
	}

	async launchForWorkspace(
		workspaceId: WorkspaceId,
		root: string,
		agentId: AgentId,
		profile: AgentProfile,
		cancel: CancellationToken,
	): Promise<AgentLaunchReceipt> {
		this.#lastLaunchFailure = undefined;
		try {
			return await this.#launch(workspaceId, root, agentId, profile, cancel);
		} catch (error) {
			// Every bounded launch stage records a more specific fact. The
			// fallback keeps the diagnostic closed even if a future early
			// return is added without a stage wrapper.
			const portError =
				error instanceof PortError ? error : asAgentError(error).toPortError();
			this.#recordLaunchPortFailure(
				AgentLaunchFailureStage.StateCommit,
				portError,
			);
			throw portError;
		}
	}

	/** The core port's `launch`: the workspace must be registered first. */
	async launch(
		agentId: AgentId,
		profile: AgentProfile,
		cancel: CancellationToken,
	): Promise<AgentLaunchReceipt> {
		this.#lastLaunchFailure = undefined;
		const registration = this.#state.workspaceRoots.get(agentId);
		if (registration === undefined) {
			const error = unavailablePort();
			this.#recordLaunchPortFailure(AgentLaunchFailureStage.StateCommit, error);
			throw error;
		}
		return this.launchForWorkspace(
			registration[0],
			registration[1],
			agentId,
			profile,
			cancel,
		);
	}

	async #launch(
		workspaceId: WorkspaceId,
		root: string,
		agentId: AgentId,
		profile: AgentProfile,
		cancel: CancellationToken,
	): Promise<AgentLaunchReceipt> {
		// Reject malformed or oversized profiles before health checks or any
		// provider request. This keeps validation a pure local seam and
		// guarantees workspace.create cannot be the first failure point.
		let providerProfile: ProviderProfile;
		try {
			providerProfile = validateProfile(profile);
		} catch (error) {
			const runtimeError = asAgentError(error);
			this.#recordLaunchRuntimeFailure(
				AgentLaunchFailureStage.ValidateProfile,
				runtimeError,
			);
			throw runtimeError.toPortError();
		}
		try {
			await this.#ensureReady(cancel);
		} catch (error) {
			const portError = toPortError(error);
			this.#recordLaunchPortFailure(
				AgentLaunchFailureStage.EnsureReady,
				portError,
			);
			throw portError;
		}
		let release: () => void;
		try {
			release = await this.#operationGate.acquire(cancel);
		} catch (error) {
			const portError = toPortError(error);
			this.#recordLaunchPortFailure(
				AgentLaunchFailureStage.OperationGate,
				portError,
			);
			throw portError;
		}
		try {
			if (
				this.#state.mappings.has(agentId) ||
				this.#state.tombstones.has(agentId)
			) {
				const error = conflictPort();
				this.#recordLaunchPortFailure(
					AgentLaunchFailureStage.StateCommit,
					error,
				);
				throw error;
			}
			const generation = this.#state.nextGeneration();

			let created: unknown;
			try {
				created = await this.#createWorkspace(root, agentId, providerProfile);
			} catch (error) {
				const runtimeError = asAgentError(error);
				this.#recordLaunchRuntimeFailure(
					AgentLaunchFailureStage.WorkspaceCreate,
					runtimeError,
				);
				throw runtimeError.toPortError();
			}

			let mapping: ProviderMapping;
			try {
				mapping = parseCreatedMapping(created, root, workspaceId, generation);
			} catch (error) {
				const runtimeError = asAgentError(error);
				await this.#compensateMapping(
					agentId,
					created,
					root,
					workspaceId,
					generation,
				);
				this.#recordLaunchRuntimeFailure(
					AgentLaunchFailureStage.MappingParse,
					runtimeError,
				);
				throw runtimeError.toPortError();
			}

			let started: unknown;
			try {
				started = await this.startAgent(
					agentId,
					mapping,
					providerProfile,
					cancel,
				);
			} catch (error) {
				const runtimeError = asAgentError(error);
				await this.#compensateProviderMapping(agentId, mapping);
				this.#recordLaunchRuntimeFailure(
					AgentLaunchFailureStage.AgentStart,
					runtimeError,
				);
				throw runtimeError.toPortError();
			}

			try {
				mapping.terminalId = terminalIdFromStarted(started);
			} catch (error) {
				const runtimeError = asAgentError(error);
				await this.#compensateProviderMapping(agentId, mapping);
				this.#recordLaunchRuntimeFailure(
					AgentLaunchFailureStage.TerminalParse,
					runtimeError,
				);
				throw runtimeError.toPortError();
			}

			let providerMapping: OpaqueProviderMapping;
			try {
				providerMapping = encodeProviderMapping(mapping);
			} catch (error) {
				const runtimeError = asAgentError(error);
				await this.#compensateProviderMapping(agentId, mapping);
				this.#recordLaunchRuntimeFailure(
					AgentLaunchFailureStage.MappingEncode,
					runtimeError,
				);
				throw runtimeError.toPortError();
			}

			this.#state.confirmedAgents.delete(agentId);
			this.#state.mappings.set(agentId, mapping);
			this.#state.workspaceRoots.set(agentId, [workspaceId, root]);
			return { agentId, providerMapping };
		} finally {
			release();
		}
	}

	async #createWorkspace(
		root: string,
		agentId: AgentId,
		profile: ProviderProfile,
	): Promise<unknown> {
		return this.#transport.request("workspace.create", {
			cwd: root,
			focus: false,
			label: markerLabel(agentId),
			env: profile.env,
		});
	}

	/** Exposed for the ported retry test; not part of the port's public seam. */
	async startAgent(
		agentId: AgentId,
		mapping: ProviderMapping,
		providerProfile: ProviderProfile,
		cancel: CancellationToken,
	): Promise<unknown> {
		const start = () =>
			transportRequestWithTimeout(
				this.#transport,
				"agent.start",
				{
					name: providerAgentName(agentId),
					kind: providerProfile.kind,
					pane_id: mapping.paneId,
					args: providerProfile.args,
					timeout_ms: AGENT_START_TIMEOUT_MS,
				},
				AGENT_START_TRANSPORT_TIMEOUT_MS,
			);
		let busy: AgentRuntimeError;
		try {
			return await start();
		} catch (error) {
			const runtimeError = asAgentError(error);
			if (
				runtimeError.providerCategory !== ProviderErrorCategory.AgentPaneBusy
			) {
				throw runtimeError;
			}
			busy = runtimeError;
		}

		// `agent.start` is a mutating request, so it is never placed in a
		// generic retry loop. A single retry is permitted only after the
		// provider proves both that this logical pane still owns the exact
		// terminal returned by `workspace.create` and that its foreground job
		// has transitioned from shell initialization to one idle shell.
		if (!(await this.#waitForOwnedShell(mapping, cancel))) {
			throw busy;
		}
		return start();
	}

	async #waitForOwnedShell(
		mapping: ProviderMapping,
		cancel: CancellationToken,
	): Promise<boolean> {
		const deadline = Date.now() + PANE_SHELL_READINESS_TIMEOUT_MS;
		for (;;) {
			if (cancel.isCancelled) {
				throw agentError(AgentRuntimeErrorCode.Cancelled);
			}
			const pane = (await this.#transport.request("pane.get", {
				pane_id: mapping.paneId,
			})) as { pane?: { terminal_id?: unknown } } | null;
			if (pane?.pane?.terminal_id !== mapping.terminalId) {
				return false;
			}
			const processInfo = (await this.#transport.request("pane.process_info", {
				pane_id: mapping.paneId,
			})) as { process_info?: unknown } | null;
			const state = classifyPaneShellState(processInfo?.process_info);
			if (state === PaneShellState.Ready) {
				return true;
			}
			if (state === PaneShellState.BusyOrUnknown) {
				return false;
			}
			if (Date.now() >= deadline) {
				return false;
			}
			await delay(
				Math.min(
					PANE_SHELL_READINESS_POLL_MS,
					Math.max(deadline - Date.now(), 0),
				),
			);
		}
	}

	async #compensateMapping(
		agentId: AgentId,
		created: unknown,
		workspaceRootPath: string,
		workspaceDomainId: WorkspaceId | undefined,
		generation: number,
	): Promise<void> {
		const record = created as
			| {
					workspace?: { workspace_id?: unknown };
					root_pane?: { pane_id?: unknown };
			  }
			| null
			| undefined;
		const workspace = record?.workspace?.workspace_id;
		const pane = record?.root_pane?.pane_id;
		let firstError: AgentRuntimeError | undefined;
		if (typeof pane === "string") {
			firstError = await this.#closeQuietly("pane.close", { pane_id: pane });
		}
		if (typeof workspace === "string") {
			const error = await this.#closeQuietly("workspace.close", {
				workspace_id: workspace,
			});
			firstError ??= error;
		}
		if (firstError === undefined) {
			return;
		}
		const cleanupError = firstError.toPortError();
		const mapping = cleanupMappingFromCreated(
			created,
			workspaceRootPath,
			workspaceDomainId,
			generation,
		);
		if (mapping !== undefined) {
			try {
				this.#recordCleanupIntent(agentId, mapping);
			} catch (intentError) {
				// A failed durable intent is the more severe fact: it is what
				// the health state reports. The provider cleanup failure that
				// caused it is already implied by the pending tombstone.
				this.#health = AgentRuntimeHealth.degraded(
					cleanupHealthCode(toPortError(intentError)),
				);
				return;
			}
		}
		this.#health = AgentRuntimeHealth.degraded(cleanupHealthCode(cleanupError));
	}

	async #compensateProviderMapping(
		agentId: AgentId,
		mapping: ProviderMapping,
	): Promise<void> {
		const paneError = await this.#closeQuietly("pane.close", {
			pane_id: mapping.paneId,
		});
		const workspaceError = await this.#closeQuietly("workspace.close", {
			workspace_id: mapping.workspaceId,
		});
		const firstError = paneError ?? workspaceError;
		if (firstError === undefined) {
			return;
		}
		const cleanupError = firstError.toPortError();
		try {
			this.#recordCleanupIntent(agentId, { ...mapping });
		} catch (intentError) {
			// A failed journal write is more actionable than the provider
			// error that made cleanup necessary: it is what health reports.
			this.#health = AgentRuntimeHealth.degraded(
				cleanupHealthCode(toPortError(intentError)),
			);
			return;
		}
		this.#health = AgentRuntimeHealth.degraded(cleanupHealthCode(cleanupError));
	}

	async #closeQuietly(
		method: string,
		params: unknown,
	): Promise<AgentRuntimeError | undefined> {
		try {
			await this.#transport.request(method, params);
			return undefined;
		} catch (error) {
			const runtimeError = asAgentError(error);
			// A resource that is already gone is the outcome close wanted.
			return runtimeError.code === AgentRuntimeErrorCode.ProviderNotFound
				? undefined
				: runtimeError;
		}
	}

	async attach(
		agentId: AgentId,
		persistedMapping: OpaqueProviderMapping | undefined,
		cancel: CancellationToken,
	): Promise<AgentObservation> {
		await this.#ensureReady(cancel);
		const release = await this.#operationGate.acquire(cancel);
		try {
			return await this.#attachLocked(agentId, persistedMapping);
		} finally {
			release();
		}
	}

	async #attachLocked(
		agentId: AgentId,
		persistedMapping: OpaqueProviderMapping | undefined,
	): Promise<AgentObservation> {
		if (this.#state.tombstones.has(agentId)) {
			throw unavailablePort();
		}
		const snapshot = await this.#fetchSnapshot();
		const registration = this.#state.workspaceRoots.get(agentId);
		const root = registration?.[1] ?? this.#context.home;
		const workspaceId = registration?.[0];
		const decoded =
			persistedMapping === undefined
				? undefined
				: decodeProviderMapping(persistedMapping);
		const mapping =
			decoded ??
			this.#state.mappings.get(agentId) ??
			recoverMapping(snapshot, agentId, root, workspaceId, 1);
		if (mapping === undefined) {
			throw unavailablePort();
		}
		const pane = paneFor(snapshot, mapping);
		if (pane === undefined) {
			// Keep a restored mapping in the provider-private state even when
			// its pane disappeared before the first attach completed. The next
			// continuous reconciliation must be able to turn that authoritative
			// absence into a natural-exit observation; dropping the mapping
			// here would leave the durable Agent row orphaned forever, because
			// reconciliation only projects owned mappings.
			this.#state.confirmedAgents.delete(agentId);
			this.#state.mappings.set(agentId, mapping);
			throw unavailablePort();
		}
		const [status, runtimeHealth] = projectProviderStatus(pane.status);
		const paneConfirmsActive =
			pane.agent !== undefined && !providerStatusIsExited(pane.status);
		const current = this.#state.mappings.get(agentId);
		if (current !== undefined && !mappingsEqual(current, mapping)) {
			this.#state.confirmedAgents.delete(agentId);
		}
		if (paneConfirmsActive) {
			this.#state.confirmedAgents.add(agentId);
		}
		this.#state.mappings.set(agentId, mapping);
		return { agentId, status, runtimeHealth };
	}

	async reconcile(cancel: CancellationToken): Promise<AgentReconciliation> {
		await this.#ensureReady(cancel);
		const release = await this.#operationGate.acquire(cancel);
		try {
			await this.#waitForCoalescedInvalidation(cancel);
			const generation = this.#invalidation.generation;
			let snapshot = await this.#fetchSnapshot();
			const snapshotGeneration = this.#invalidation.generation;
			if (snapshotGeneration !== generation) {
				snapshot = await this.#fetchSnapshot();
			}
			this.#recoverOwnedMappings(snapshot);
			const { observations, exited } = this.projectSnapshot(snapshot);
			await this.#retryDueTombstones(cancel);
			if (this.#invalidation.generation === snapshotGeneration) {
				this.#invalidation.clearPending();
			}
			return { observations, exited };
		} finally {
			release();
		}
	}

	/**
	 * Reconstructs adapter state from the authoritative hidden-workspace marker
	 * after a DevHub relaunch. Provider IDs remain inside `ProviderMapping` and
	 * are never returned to the core.
	 */
	#recoverOwnedMappings(snapshot: ProviderSnapshot): void {
		const registrations = new Map(this.#state.workspaceRoots);
		for (const workspace of snapshot.workspaces) {
			if (workspace.label?.startsWith(MARKER_LABEL_PREFIX) !== true) {
				continue;
			}
			const agentId = workspace.label.slice(MARKER_LABEL_PREFIX.length);
			if (!isUuid(agentId)) {
				continue;
			}
			if (
				this.#state.mappings.has(agentId) ||
				this.#state.tombstones.has(agentId)
			) {
				continue;
			}
			const registration = registrations.get(agentId);
			const mapping = recoverMapping(
				snapshot,
				agentId,
				registration?.[1] ?? this.#context.home,
				registration?.[0],
				this.#state.nextGeneration(),
			);
			if (mapping === undefined) {
				continue;
			}
			this.#state.confirmedAgents.delete(agentId);
			this.#state.mappings.set(agentId, mapping);
		}
	}

	/** Exposed for the ported natural-exit test; not part of the port seam. */
	projectSnapshot(snapshot: ProviderSnapshot): {
		observations: AgentObservation[];
		exited: AgentId[];
	} {
		const observations: AgentObservation[] = [];
		const exited: AgentId[] = [];
		let journalChanged = false;
		for (const [agentId, mapping] of [...this.#state.mappings]) {
			const pane = paneFor(snapshot, mapping);
			if (pane === undefined) {
				this.#state.addTombstone(agentId, mapping, TombstoneReason.NaturalExit);
				journalChanged = true;
				exited.push(agentId);
				continue;
			}
			// Herdr may temporarily have no detected agent label while a managed
			// launch settles. Treat that startup absence as still observable,
			// but once a pane has reported an agent, a later missing identity is
			// the provider's natural-exit signal.
			const agentWasConfirmed = this.#state.confirmedAgents.has(agentId);
			if (pane.agent !== undefined) {
				this.#state.confirmedAgents.add(agentId);
			}
			if (
				providerStatusIsExited(pane.status) ||
				(pane.agent === undefined && agentWasConfirmed)
			) {
				this.#state.addTombstone(agentId, mapping, TombstoneReason.NaturalExit);
				journalChanged = true;
				exited.push(agentId);
				continue;
			}
			const [status, runtimeHealth] = projectProviderStatus(pane.status);
			observations.push({ agentId, status, runtimeHealth });
		}
		if (journalChanged) {
			try {
				this.#persistJournal();
			} catch (error) {
				const portError = toPortError(error);
				this.#health = AgentRuntimeHealth.degraded(
					cleanupHealthCode(portError),
				);
				throw portError;
			}
		}
		return { observations, exited };
	}

	async #retryDueTombstones(cancel: CancellationToken): Promise<void> {
		const due = [...this.#state.tombstones.entries()].filter(
			([, tombstone]) => tombstone.nextRetry <= Date.now(),
		);
		for (const [agentId, tombstone] of due) {
			if (cancel.isCancelled) {
				throw cancelledPort();
			}
			if (tombstone.attempts >= MAX_TOMBSTONE_ATTEMPTS) {
				continue;
			}
			try {
				await this.#cleanupMapping(tombstone.mapping, cancel);
				this.#finishCleanupSuccess(agentId, tombstone.mapping.generation);
			} catch (error) {
				const portError = toPortError(error);
				this.#state.recordCleanupFailure(agentId);
				this.#persistJournal();
				this.#health = AgentRuntimeHealth.degraded(
					cleanupHealthCode(portError),
				);
			}
		}
	}

	async terminate(agentId: AgentId, cancel: CancellationToken): Promise<void> {
		this.#loadJournal();
		if (
			!this.#state.mappings.has(agentId) &&
			!this.#state.tombstones.has(agentId)
		) {
			return;
		}
		try {
			await this.#ensureReady(cancel);
		} catch (error) {
			const portError = toPortError(error);
			if (
				portError.code === PortErrorCode.Unavailable ||
				portError.code === PortErrorCode.TimedOut
			) {
				const mapping = this.#state.mappings.get(agentId);
				if (mapping !== undefined) {
					this.#state.addTombstone(
						agentId,
						mapping,
						TombstoneReason.ExplicitStop,
					);
					this.#state.stopping.add(agentId);
					this.#persistJournal();
				}
			}
			throw portError;
		}
		const release = await this.#operationGate.acquire(cancel);
		try {
			const existing = this.#state.tombstones.get(agentId);
			if (existing !== undefined) {
				if (existing.attempts >= MAX_TOMBSTONE_ATTEMPTS) {
					throw agentError(AgentRuntimeErrorCode.CleanupPending).toPortError();
				}
				existing.reason = TombstoneReason.ExplicitStop;
				existing.nextRetry = Date.now();
				this.#state.stopping.add(agentId);
			} else {
				const mapping = this.#state.mappings.get(agentId);
				if (mapping === undefined) {
					return;
				}
				this.#state.stopping.add(agentId);
				this.#state.addTombstone(
					agentId,
					mapping,
					TombstoneReason.ExplicitStop,
				);
			}
			const tombstone = this.#state.tombstones.get(agentId);
			if (tombstone === undefined) {
				throw failedPort();
			}
			this.#persistJournal();
			try {
				await this.#cleanupMapping(tombstone.mapping, cancel);
			} catch (error) {
				const portError = toPortError(error);
				this.#state.recordCleanupFailure(agentId);
				this.#persistJournal();
				this.#health = AgentRuntimeHealth.degraded(
					cleanupHealthCode(portError),
				);
				throw portError;
			}
			this.#finishCleanupSuccess(agentId, undefined);
		} finally {
			release();
		}
	}

	async #cleanupMapping(
		mapping: ProviderMapping,
		cancel: CancellationToken,
	): Promise<void> {
		let firstError = (
			await this.#closeQuietly("pane.close", { pane_id: mapping.paneId })
		)?.toPortError();
		if (firstError === undefined) {
			const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
			for (;;) {
				if (cancel.isCancelled) {
					firstError = cancelledPort();
					break;
				}
				let snapshot: ProviderSnapshot;
				try {
					snapshot = await this.#fetchSnapshot();
				} catch (error) {
					firstError = toPortError(error);
					break;
				}
				if (paneFor(snapshot, mapping) === undefined) {
					break;
				}
				if (Date.now() >= deadline) {
					firstError = agentError(AgentRuntimeErrorCode.Timeout).toPortError();
					break;
				}
				await delay(CLEANUP_POLL_MS);
			}
		}
		const workspaceError = (
			await this.#closeQuietly("workspace.close", {
				workspace_id: mapping.workspaceId,
			})
		)?.toPortError();
		firstError ??= workspaceError;
		if (firstError !== undefined) {
			throw firstError;
		}
	}

	async attachSurface(
		agentId: AgentId,
		surfaceKey: string,
		takeover: boolean,
		cancel: CancellationToken,
	): Promise<AgentSurface> {
		const [surface] = await this.attachSurfaceWithObservation(
			agentId,
			surfaceKey,
			takeover,
			cancel,
		);
		return surface;
	}

	/**
	 * Attaches a foreground Agent Surface and returns the provider-free
	 * observation produced by the same attach transaction. Native state must
	 * apply this observation instead of waiting for the next background
	 * reconciliation tick, otherwise an attach can briefly expose stale status
	 * or runtime health.
	 */
	async attachSurfaceWithObservation(
		agentId: AgentId,
		surfaceKey: string,
		takeover: boolean,
		cancel: CancellationToken,
	): Promise<[AgentSurface, AgentObservation]> {
		if (
			surfaceKey.length === 0 ||
			Buffer.byteLength(surfaceKey) > MAX_SURFACE_KEY_BYTES
		) {
			throw agentError(AgentRuntimeErrorCode.InvalidProfile).toPortError();
		}
		const observation = await this.attach(agentId, undefined, cancel);
		const release = await this.#operationGate.acquire(cancel);
		try {
			for (const [key, owner] of this.#state.surfaces) {
				if (owner === agentId && key !== surfaceKey) {
					// A live DevHub surface owns the controller. Conditional
					// takeover is intentionally refused while it is registered.
					throw conflictPort();
				}
			}
			if (this.#state.surfaces.has(surfaceKey)) {
				// A live handle owns this exact surface key. Reusing it would
				// create two controllers with indistinguishable lifecycle state.
				throw conflictPort();
			}
			const mapping = this.#state.mappings.get(agentId);
			if (mapping === undefined) {
				throw unavailablePort();
			}
			let control;
			try {
				control = await transportOpenControl(
					this.#transport,
					mapping.terminalId,
					takeover,
				);
			} catch (error) {
				throw toPortError(error);
			}
			this.#state.surfaces.set(surfaceKey, agentId);
			this.#state.controls.set(surfaceKey, control);
			return [new AgentSurface(this, agentId, surfaceKey), observation];
		} finally {
			release();
		}
	}

	async #waitForCoalescedInvalidation(
		cancel: CancellationToken,
	): Promise<void> {
		for (;;) {
			const wait = this.#invalidation.pendingWait();
			if (wait === undefined || wait === 0) {
				return;
			}
			if (cancel.isCancelled) {
				throw cancelledPort();
			}
			await delay(Math.min(wait, BOOTSTRAP_POLL_MS));
		}
	}

	async #ensureReady(cancel: CancellationToken): Promise<void> {
		if (this.#health.isReady && !this.#invalidation.isDisconnected) {
			return;
		}
		await this.bootstrap(cancel);
	}

	#loadJournal(): void {
		if (this.#journalLoaded) {
			return;
		}
		const persisted = loadCleanupJournal(this.#journalPath);
		for (const [agentId, tombstone] of persisted) {
			if (!this.#state.tombstones.has(agentId)) {
				this.#state.tombstones.set(agentId, tombstone);
			}
		}
		this.#journalLoaded = true;
	}

	#persistJournal(): void {
		saveCleanupJournal(this.#journalPath, this.#state.tombstones);
	}

	#recordCleanupIntent(agentId: AgentId, mapping: ProviderMapping): void {
		this.#state.addTombstone(agentId, mapping, TombstoneReason.ExplicitStop);
		this.#persistJournal();
	}

	/**
	 * Commits cleanup state only after the journal accepts the new tombstone
	 * set. If persistence fails, the in-memory intent is restored so a retry is
	 * still possible and no live surface is silently orphaned.
	 */
	#finishCleanupSuccess(
		agentId: AgentId,
		generation: number | undefined,
	): void {
		this.#state.confirmedAgents.delete(agentId);
		const currentMapping = this.#state.mappings.get(agentId);
		const removedMapping =
			generation === undefined || currentMapping?.generation === generation
				? currentMapping
				: undefined;
		if (removedMapping !== undefined) {
			this.#state.mappings.delete(agentId);
		}
		const removedTombstone = this.#state.tombstones.get(agentId);
		this.#state.tombstones.delete(agentId);
		const wasStopping = this.#state.stopping.delete(agentId);
		try {
			this.#persistJournal();
		} catch (error) {
			const portError = toPortError(error);
			if (removedMapping !== undefined && !this.#state.mappings.has(agentId)) {
				this.#state.mappings.set(agentId, removedMapping);
			}
			if (
				removedTombstone !== undefined &&
				!this.#state.tombstones.has(agentId)
			) {
				this.#state.tombstones.set(agentId, removedTombstone);
			}
			if (wasStopping) {
				this.#state.stopping.add(agentId);
			}
			this.#health = AgentRuntimeHealth.degraded(cleanupHealthCode(portError));
			throw portError;
		}
		for (const control of this.#state.takeSurfaces(agentId)) {
			control.detach();
		}
	}

	async #fetchSnapshot(): Promise<ProviderSnapshot> {
		let value: unknown;
		try {
			value = await this.#transport.request("session.snapshot", {});
		} catch (error) {
			const runtimeError = asAgentError(error);
			this.#health = AgentRuntimeHealth.degraded(runtimeError.code);
			throw runtimeError.toPortError();
		}
		try {
			return parseSessionSnapshot(value);
		} catch (error) {
			throw asAgentError(error).toPortError();
		}
	}

	async surfaceSendText(
		agentId: AgentId,
		surfaceKey: string,
		text: string,
	): Promise<void> {
		if (
			Buffer.byteLength(text) > MAX_TERMINAL_READ_BYTES ||
			text.includes("\0")
		) {
			throw agentError(AgentRuntimeErrorCode.BoundedInput).toPortError();
		}
		const control = this.#ownedControl(agentId, surfaceKey);
		try {
			await control.sendText(text);
		} catch (error) {
			throw asAgentError(error).toPortError();
		}
	}

	async surfaceReadRecent(
		agentId: AgentId,
		surfaceKey: string,
	): Promise<Buffer> {
		const control = this.#ownedControl(agentId, surfaceKey);
		try {
			return await control.readRecent();
		} catch (error) {
			throw asAgentError(error).toPortError();
		}
	}

	surfaceDetach(agentId: AgentId, surfaceKey: string): void {
		if (this.#state.surfaces.get(surfaceKey) !== agentId) {
			return;
		}
		this.#state.surfaces.delete(surfaceKey);
		const control = this.#state.controls.get(surfaceKey);
		this.#state.controls.delete(surfaceKey);
		control?.detach();
	}

	#ownedControl(agentId: AgentId, surfaceKey: string) {
		const control =
			this.#state.surfaces.get(surfaceKey) === agentId
				? this.#state.controls.get(surfaceKey)
				: undefined;
		if (control === undefined) {
			throw unavailablePort();
		}
		return control;
	}

	/** Provider-private state, for the ported tests only. */
	get stateForTests(): AgentRuntimeState {
		return this.#state;
	}
}

export function classifyPaneShellState(processInfo: unknown): PaneShellState {
	const info = processInfo as Record<string, unknown> | null | undefined;
	const shellPid = info?.shell_pid;
	if (typeof shellPid !== "number") {
		return PaneShellState.BusyOrUnknown;
	}
	if (info?.foreground_process_group_id !== shellPid) {
		return PaneShellState.BusyOrUnknown;
	}
	const processes = info?.foreground_processes;
	if (!Array.isArray(processes)) {
		return PaneShellState.BusyOrUnknown;
	}
	const shellIsForeground = processes.some((process) => {
		const entry = process as Record<string, unknown> | null;
		const name = providerProcessName(entry);
		return (
			entry?.pid === shellPid &&
			name !== undefined &&
			isPaneShellProcessName(name)
		);
	});
	if (!shellIsForeground) {
		return PaneShellState.BusyOrUnknown;
	}
	return processes.every(
		(process) => (process as Record<string, unknown> | null)?.pid === shellPid,
	)
		? PaneShellState.Ready
		: PaneShellState.Initializing;
}

function providerProcessName(
	process: Record<string, unknown> | null,
): string | undefined {
	const name = process?.name;
	if (typeof name === "string") {
		return name;
	}
	const argv0 = process?.argv0;
	if (typeof argv0 === "string") {
		return argv0;
	}
	const argv = process?.argv;
	const first = Array.isArray(argv) ? argv[0] : undefined;
	return typeof first === "string" ? first : undefined;
}

const PANE_SHELL_NAMES = new Set([
	"sh",
	"bash",
	"dash",
	"zsh",
	"fish",
	"ksh",
	"mksh",
	"csh",
	"tcsh",
	"elvish",
	"xonsh",
	"nu",
	"pwsh",
	"powershell",
	"cmd",
]);

function isPaneShellProcessName(name: string): boolean {
	const base = name.split(/[/\\]/).pop() ?? name;
	const normalized = base
		.replace(/^-+/, "")
		.replace(/\.exe$/, "")
		.toLowerCase();
	return PANE_SHELL_NAMES.has(normalized);
}

export function verifyPing(value: unknown): void {
	const ping = value as Record<string, unknown> | null;
	if (ping === null || typeof ping !== "object" || ping.type !== "pong") {
		throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
	}
	if (ping.version !== expectedVersion()) {
		throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
	}
	if (ping.protocol !== expectedProtocol()) {
		throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
	}
	const capabilities = ping.capabilities;
	if (
		typeof capabilities !== "object" ||
		capabilities === null ||
		Array.isArray(capabilities)
	) {
		throw agentError(AgentRuntimeErrorCode.CapabilityMismatch);
	}
}

export function cleanupHealthCode(error: PortError): AgentRuntimeErrorCode {
	switch (error.code) {
		case PortErrorCode.Unavailable:
			return AgentRuntimeErrorCode.Disconnected;
		case PortErrorCode.Incompatible:
			return AgentRuntimeErrorCode.CapabilityMismatch;
		case PortErrorCode.TimedOut:
			return AgentRuntimeErrorCode.Timeout;
		case PortErrorCode.Cancelled:
			return AgentRuntimeErrorCode.Cancelled;
		case PortErrorCode.Conflict:
			return AgentRuntimeErrorCode.Conflict;
		case PortErrorCode.Failed:
			return AgentRuntimeErrorCode.CleanupPending;
	}
}

/**
 * The single conversion at the adapter's outer edge. A `PortError` passes
 * through, an adapter error is mapped by its own rule, and anything else is a
 * broken invariant rather than something to be rendered.
 */
export function toPortError(value: unknown): PortError {
	if (value instanceof PortError) {
		return value;
	}
	if (value instanceof AgentRuntimeError) {
		return value.toPortError();
	}
	return failedPort();
}

export const AGENT_START_TIMEOUT_MS_FOR_TESTS = AGENT_START_TIMEOUT_MS;
export const API_TIMEOUT_MS_FOR_TESTS = API_TIMEOUT_MS;
