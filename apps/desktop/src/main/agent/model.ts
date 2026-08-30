/**
 * Provider-private mappings and bounded projection helpers.
 *
 * Ported from `src-tauri/src/agent/model.rs`. The Rust `BTreeMap`/`BTreeSet`
 * become `Map`/`Set` kept in insertion order plus explicit sorting wherever the
 * order was load-bearing (the journal's records, the profile wire budget).
 * `u128` arithmetic in the provider name encoder becomes `bigint`.
 */

import {
	closeSync,
	constants as fsConstants,
	fsyncSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	fstatSync,
	lstatSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";

import {
	AgentRuntimeError,
	AgentRuntimeErrorCode,
	agentError,
} from "./error.js";
import {
	AgentProfileKind,
	AgentStatus,
	MAX_OPAQUE_MAPPING_BYTES,
	RuntimeHealth,
	isUuid,
	opaqueProviderMapping,
	type AgentId,
	type AgentProfile,
	type OpaqueProviderMapping,
	type WorkspaceId,
} from "./ports.js";

export const MAX_PROFILE_ARGS = 64;
export const MAX_PROFILE_ARG_BYTES = 16 * 1024;
export const MAX_PROFILE_ENV = 128;
export const MAX_PROFILE_ENV_KEY_BYTES = 256;
export const MAX_PROFILE_ENV_VALUE_BYTES = 16 * 1024;
/**
 * Conservative combined JSON budget for profile args/env. Herdr accepts
 * initial API lines below 1 MiB; this leaves headroom for request IDs,
 * workspace metadata, escaping, and the terminating newline.
 */
export const MAX_PROFILE_WIRE_BYTES = 900 * 1024;
export const MAX_PROVIDER_ID_BYTES = 512;
export const MAX_SURFACE_KEY_BYTES = 256;
export const MAX_TOMBSTONES = 1_024;
export const MAX_TOMBSTONE_ATTEMPTS = 8;
export const CLEANUP_RETRY_BASE_MS = 100;
export const RUNTIME_JOURNAL_SCHEMA_VERSION = 1;
const MAX_RUNTIME_JOURNAL_BYTES = 512 * 1024;
const RUNTIME_JOURNAL_BACKUP_SUFFIX = ".bak";
let runtimeJournalTempCounter = 0;

export enum AgentRuntimeHealthState {
	Starting = "starting",
	Healthy = "healthy",
	Degraded = "degraded",
	Unavailable = "unavailable",
	Failed = "failed",
}

export class AgentRuntimeHealth {
	readonly state: AgentRuntimeHealthState;
	readonly diagnostic: AgentRuntimeErrorCode | undefined;

	private constructor(
		state: AgentRuntimeHealthState,
		diagnostic?: AgentRuntimeErrorCode,
	) {
		this.state = state;
		this.diagnostic = diagnostic;
	}

	static starting(): AgentRuntimeHealth {
		return new AgentRuntimeHealth(AgentRuntimeHealthState.Starting);
	}

	static healthy(): AgentRuntimeHealth {
		return new AgentRuntimeHealth(AgentRuntimeHealthState.Healthy);
	}

	static degraded(code: AgentRuntimeErrorCode): AgentRuntimeHealth {
		return new AgentRuntimeHealth(AgentRuntimeHealthState.Degraded, code);
	}

	static unavailable(code: AgentRuntimeErrorCode): AgentRuntimeHealth {
		return new AgentRuntimeHealth(AgentRuntimeHealthState.Unavailable, code);
	}

	static failed(code: AgentRuntimeErrorCode): AgentRuntimeHealth {
		return new AgentRuntimeHealth(AgentRuntimeHealthState.Failed, code);
	}

	get isReady(): boolean {
		return this.state === AgentRuntimeHealthState.Healthy;
	}

	get runtimeHealth(): RuntimeHealth {
		switch (this.state) {
			case AgentRuntimeHealthState.Starting:
				return RuntimeHealth.Starting;
			case AgentRuntimeHealthState.Healthy:
				return RuntimeHealth.Healthy;
			case AgentRuntimeHealthState.Degraded:
				return RuntimeHealth.Degraded;
			case AgentRuntimeHealthState.Unavailable:
				return RuntimeHealth.Unavailable;
			case AgentRuntimeHealthState.Failed:
				return RuntimeHealth.Failed;
		}
	}
}

export interface ProviderProfile {
	readonly kind: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
}

const CONTROL_CHARACTER = /[\p{Cc}]/u;

export function validateProfile(profile: AgentProfile): ProviderProfile {
	const kind =
		profile.kind === AgentProfileKind.Codex
			? "codex"
			: profile.kind === AgentProfileKind.Claude
				? "claude"
				: undefined;
	if (kind === undefined) {
		throw agentError(AgentRuntimeErrorCode.InvalidProfile);
	}
	const envEntries = Object.entries(profile.env);
	if (
		profile.args.length > MAX_PROFILE_ARGS ||
		profile.args.some(
			(arg) =>
				CONTROL_CHARACTER.test(arg) ||
				Buffer.byteLength(arg) > MAX_PROFILE_ARG_BYTES,
		) ||
		envEntries.length > MAX_PROFILE_ENV ||
		envEntries.some(
			([key, value]) =>
				key.length === 0 ||
				Buffer.byteLength(key) > MAX_PROFILE_ENV_KEY_BYTES ||
				Buffer.byteLength(value) > MAX_PROFILE_ENV_VALUE_BYTES ||
				CONTROL_CHARACTER.test(key) ||
				CONTROL_CHARACTER.test(value) ||
				!validEnvironmentKey(key),
		)
	) {
		throw agentError(AgentRuntimeErrorCode.InvalidProfile);
	}
	const aggregateRequest = {
		id: "devhub-agent-workspace.create",
		method: "workspace.create",
		params: {
			cwd: "/",
			focus: false,
			label: "devhub-agent-profile-budget",
			env: sortedEnv(profile.env),
			args: profile.args,
		},
	};
	const aggregateSize = Buffer.byteLength(JSON.stringify(aggregateRequest)) + 1;
	if (aggregateSize >= MAX_PROFILE_WIRE_BYTES) {
		throw agentError(AgentRuntimeErrorCode.InvalidProfile);
	}
	return { kind, args: [...profile.args], env: sortedEnv(profile.env) };
}

/** The Rust side carried a `BTreeMap`; key order is part of the wire budget. */
export function sortedEnv(
	env: Readonly<Record<string, string>>,
): Record<string, string> {
	const sorted: Record<string, string> = {};
	for (const key of Object.keys(env).sort()) {
		sorted[key] = env[key];
	}
	return sorted;
}

function validEnvironmentKey(key: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

export interface ProviderMapping {
	workspaceId: string;
	tabId: string;
	paneId: string;
	terminalId: string;
	workspaceRoot: string;
	workspaceDomainId: WorkspaceId | undefined;
	generation: number;
}

export function mappingsEqual(
	left: ProviderMapping,
	right: ProviderMapping,
): boolean {
	return (
		left.workspaceId === right.workspaceId &&
		left.tabId === right.tabId &&
		left.paneId === right.paneId &&
		left.terminalId === right.terminalId &&
		left.workspaceRoot === right.workspaceRoot &&
		left.workspaceDomainId === right.workspaceDomainId &&
		left.generation === right.generation
	);
}

/**
 * The only value that crosses the core StateStore seam. Its serialized
 * contents are deliberately private to this adapter; the core can persist and
 * return the value without learning provider identifiers or semantics.
 */
interface OpaqueMappingRecord {
	version: number;
	workspace_id: string;
	tab_id: string;
	pane_id: string;
	terminal_id: string;
	workspace_root: string;
	workspace_domain_id: string | null;
	generation: number;
}

export function encodeProviderMapping(
	mapping: ProviderMapping,
): OpaqueProviderMapping {
	const record: OpaqueMappingRecord = {
		version: 1,
		workspace_id: mapping.workspaceId,
		tab_id: mapping.tabId,
		pane_id: mapping.paneId,
		terminal_id: mapping.terminalId,
		workspace_root: mapping.workspaceRoot,
		workspace_domain_id: mapping.workspaceDomainId ?? null,
		generation: mapping.generation,
	};
	const value = JSON.stringify(record);
	if (Buffer.byteLength(value) > MAX_OPAQUE_MAPPING_BYTES) {
		throw agentError(AgentRuntimeErrorCode.BoundedInput);
	}
	try {
		return opaqueProviderMapping(value);
	} catch {
		throw agentError(AgentRuntimeErrorCode.BoundedInput);
	}
}

export function decodeProviderMapping(
	value: OpaqueProviderMapping,
): ProviderMapping {
	let record: OpaqueMappingRecord;
	try {
		record = JSON.parse(value.value) as OpaqueMappingRecord;
	} catch {
		throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
	}
	if (record === null || typeof record !== "object" || record.version !== 1) {
		throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
	}
	const domainId = record.workspace_domain_id;
	if (domainId !== null && !isUuid(domainId ?? "")) {
		throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
	}
	if (
		typeof record.workspace_root !== "string" ||
		!record.workspace_root.startsWith("/")
	) {
		throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
	}
	return {
		workspaceId: boundedProviderId(record.workspace_id),
		tabId: boundedProviderId(record.tab_id),
		paneId: boundedProviderId(record.pane_id),
		terminalId: boundedProviderId(record.terminal_id),
		workspaceRoot: record.workspace_root,
		workspaceDomainId: domainId ?? undefined,
		generation: record.generation,
	};
}

/**
 * Herdr names are provider-only. Encode the complete UUID into base-36 so the
 * name is deterministic and remains within Herdr's 32-byte grammar.
 */
export function providerAgentName(agentId: AgentId): string {
	let value = 0n;
	let validUuid = true;
	let digits = 0;
	for (const byte of Buffer.from(agentId, "utf8")) {
		if (byte === 0x2d) {
			continue;
		}
		const digit = parseInt(String.fromCharCode(byte), 16);
		if (Number.isNaN(digit)) {
			validUuid = false;
			break;
		}
		value = value * 16n + BigInt(digit);
		digits += 1;
	}
	if (!validUuid || digits !== 32) {
		const mask = (1n << 128n) - 1n;
		value = 0n;
		for (const byte of Buffer.from(agentId, "utf8")) {
			value = ((value * 0x100000001b3n + BigInt(byte)) & mask) as bigint;
		}
	}
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
	let suffix = "";
	while (value > 0n && suffix.length < 25) {
		suffix = alphabet[Number(value % 36n)] + suffix;
		value /= 36n;
	}
	return `a${suffix === "" ? "0" : suffix}`;
}

export enum TombstoneReason {
	NaturalExit = "natural_exit",
	ExplicitStop = "explicit_stop",
}

export interface CleanupTombstone {
	mapping: ProviderMapping;
	reason: TombstoneReason;
	attempts: number;
	/** `Date.now()` milliseconds; the Rust `Instant` had the same meaning. */
	nextRetry: number;
}

interface RuntimeJournalTombstone {
	agent_id: string;
	mapping: string;
	reason: string;
	attempts: number;
}

interface RuntimeJournal {
	schema_version: number;
	tombstones: RuntimeJournalTombstone[];
}

export function loadCleanupJournal(
	path: string,
): Map<AgentId, CleanupTombstone> {
	const primary = readPrivateFile(path);
	const backupPath = siblingWithSuffix(path, RUNTIME_JOURNAL_BACKUP_SUFFIX);
	const backup =
		primary === undefined ? readPrivateFile(backupPath) : undefined;
	const bytes = primary ?? backup;
	if (bytes === undefined) {
		return new Map();
	}
	try {
		return decodeCleanupJournal(bytes);
	} catch (error) {
		if (primary === undefined) {
			// A corrupt backup cannot be used, but quarantine it before
			// starting fresh so the failure is recoverable/auditable.
			quarantineAndSync(backupPath);
			return new Map();
		}
		void error;
	}

	// The primary is corrupt. Quarantine it before consulting the backup; a
	// valid previous commit remains available without silently deleting
	// evidence of the failed write.
	quarantineAndSync(path);
	const backupBytes = readPrivateFile(backupPath);
	if (backupBytes === undefined) {
		return new Map();
	}
	try {
		return decodeCleanupJournal(backupBytes);
	} catch {
		quarantineAndSync(backupPath);
		return new Map();
	}
}

function decodeCleanupJournal(bytes: Buffer): Map<AgentId, CleanupTombstone> {
	if (bytes.length > MAX_RUNTIME_JOURNAL_BYTES) {
		throw agentError(AgentRuntimeErrorCode.BoundedInput);
	}
	let journal: RuntimeJournal;
	try {
		journal = JSON.parse(bytes.toString("utf8")) as RuntimeJournal;
	} catch {
		throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
	}
	if (
		journal === null ||
		typeof journal !== "object" ||
		journal.schema_version !== RUNTIME_JOURNAL_SCHEMA_VERSION ||
		!Array.isArray(journal.tombstones) ||
		journal.tombstones.length > MAX_TOMBSTONES
	) {
		throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
	}
	const tombstones = new Map<AgentId, CleanupTombstone>();
	for (const record of journal.tombstones) {
		if (!isUuid(record.agent_id ?? "")) {
			throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
		}
		const mapping = decodeProviderMapping(
			opaqueProviderMapping(record.mapping),
		);
		const reason =
			record.reason === TombstoneReason.NaturalExit
				? TombstoneReason.NaturalExit
				: record.reason === TombstoneReason.ExplicitStop
					? TombstoneReason.ExplicitStop
					: undefined;
		if (reason === undefined || tombstones.has(record.agent_id)) {
			throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
		}
		tombstones.set(record.agent_id, {
			mapping,
			reason,
			attempts: record.attempts,
			nextRetry: Date.now(),
		});
	}
	return tombstones;
}

export function saveCleanupJournal(
	path: string,
	tombstones: ReadonlyMap<AgentId, CleanupTombstone>,
): void {
	if (tombstones.size > MAX_TOMBSTONES) {
		throw agentError(AgentRuntimeErrorCode.CleanupPending);
	}
	const records: RuntimeJournalTombstone[] = [];
	for (const agentId of [...tombstones.keys()].sort()) {
		const tombstone = tombstones.get(agentId)!;
		records.push({
			agent_id: agentId,
			mapping: encodeProviderMapping(tombstone.mapping).value,
			reason: tombstone.reason,
			attempts: tombstone.attempts,
		});
	}
	const bytes = Buffer.from(
		JSON.stringify({
			schema_version: RUNTIME_JOURNAL_SCHEMA_VERSION,
			tombstones: records,
		}),
		"utf8",
	);
	if (bytes.length > MAX_RUNTIME_JOURNAL_BYTES) {
		throw agentError(AgentRuntimeErrorCode.BoundedInput);
	}
	const parent = dirname(path);
	if (parent === "" || parent === path) {
		throw agentError(AgentRuntimeErrorCode.Unavailable);
	}
	ensureDirectoryChain(parent);
	ensurePrivateTarget(path);
	const backupPath = siblingWithSuffix(path, RUNTIME_JOURNAL_BACKUP_SUFFIX);
	ensurePrivateTarget(backupPath);

	// Keep the last known-good primary as recovery evidence. A corrupt primary
	// is quarantined and deliberately does not poison the backup.
	const primaryBytes = readPrivateFile(path);
	if (primaryBytes !== undefined) {
		let primaryIsValid = true;
		try {
			decodeCleanupJournal(primaryBytes);
		} catch {
			primaryIsValid = false;
		}
		if (primaryIsValid) {
			copyPrivate(path, backupPath, parent);
		} else {
			quarantineAndSync(path);
		}
	}

	const temporary = temporaryPath(path);
	try {
		writePrivateNew(temporary, bytes);
		renameSync(temporary, path);
		syncDirectory(parent);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			// The temporary either never existed or is already gone; the
			// original failure below is the one that matters.
		}
		throw error instanceof AgentRuntimeError
			? error
			: agentError(AgentRuntimeErrorCode.Unavailable);
	}
}

function readPrivateFile(path: string): Buffer | undefined {
	let stats;
	try {
		stats = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw agentError(AgentRuntimeErrorCode.Unavailable);
	}
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw agentError(AgentRuntimeErrorCode.Unavailable);
	}
	ensurePrivatePermissions(stats.mode);
	let descriptor: number;
	try {
		descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	} catch {
		throw agentError(AgentRuntimeErrorCode.Unavailable);
	}
	try {
		const buffer = Buffer.alloc(MAX_RUNTIME_JOURNAL_BYTES + 1);
		let filled = 0;
		for (;;) {
			const read = readSync(
				descriptor,
				buffer,
				filled,
				buffer.length - filled,
				null,
			);
			if (read === 0 || filled === buffer.length) {
				break;
			}
			filled += read;
		}
		return buffer.subarray(0, filled);
	} catch {
		throw agentError(AgentRuntimeErrorCode.Unavailable);
	} finally {
		closeSync(descriptor);
	}
}

function ensurePrivateTarget(path: string): void {
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink() || !stats.isFile()) {
			throw agentError(AgentRuntimeErrorCode.Unavailable);
		}
		ensurePrivatePermissions(stats.mode);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw error instanceof AgentRuntimeError
			? error
			: agentError(AgentRuntimeErrorCode.Unavailable);
	}
}

function ensurePrivatePermissions(mode: number): void {
	if ((mode & 0o077) !== 0) {
		throw agentError(AgentRuntimeErrorCode.Unavailable);
	}
}

function ensureDirectoryChain(path: string): void {
	let current = path.startsWith(sep) ? sep : "";
	for (const component of path.split(sep).filter((part) => part.length > 0)) {
		current = current === sep ? sep + component : join(current, component);
		let created = false;
		let stats;
		try {
			stats = lstatSync(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw agentError(AgentRuntimeErrorCode.Unavailable);
			}
			try {
				mkdirSync(current, { mode: 0o700 });
			} catch {
				throw agentError(AgentRuntimeErrorCode.Unavailable);
			}
			created = true;
			stats = lstatSync(current);
		}
		if (stats.isSymbolicLink() || !stats.isDirectory()) {
			throw agentError(AgentRuntimeErrorCode.Unavailable);
		}
		void created;
	}
}

function writePrivateNew(path: string, bytes: Buffer): void {
	let descriptor: number;
	try {
		descriptor = openSync(
			path,
			fsConstants.O_WRONLY |
				fsConstants.O_CREAT |
				fsConstants.O_EXCL |
				fsConstants.O_NOFOLLOW,
			0o600,
		);
	} catch {
		throw agentError(AgentRuntimeErrorCode.Unavailable);
	}
	try {
		writeSync(descriptor, bytes);
		fsyncSync(descriptor);
		// A pre-existing umask cannot loosen O_EXCL|0600, but a file created
		// under a stricter umask still has to read back as 0600 for the
		// private-permission check on the next load to accept it.
		ensurePrivatePermissions(fstatSync(descriptor).mode);
	} catch (error) {
		throw error instanceof AgentRuntimeError
			? error
			: agentError(AgentRuntimeErrorCode.Unavailable);
	} finally {
		closeSync(descriptor);
	}
}

function copyPrivate(from: string, to: string, parent: string): void {
	const bytes = readPrivateFile(from);
	if (bytes === undefined) {
		return;
	}
	const temporary = temporaryPath(to);
	try {
		writePrivateNew(temporary, bytes);
		renameSync(temporary, to);
		syncDirectory(parent);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			// Already gone; the original failure is what the caller needs.
		}
		throw error instanceof AgentRuntimeError
			? error
			: agentError(AgentRuntimeErrorCode.Unavailable);
	}
}

function syncDirectory(path: string): void {
	const descriptor = openSync(path, fsConstants.O_RDONLY);
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function siblingWithSuffix(path: string, suffix: string): string {
	return join(dirname(path), `${basename(path)}${suffix}`);
}

function temporaryPath(path: string): string {
	runtimeJournalTempCounter += 1;
	return join(
		dirname(path),
		`${basename(path)}.tmp.${process.pid}.${runtimeJournalTempCounter}`,
	);
}

function quarantineAndSync(path: string): void {
	const parent = dirname(path);
	for (let suffix = 0; suffix < 1_000; suffix += 1) {
		const candidate = join(parent, `${basename(path)}.corrupt.${suffix}`);
		try {
			lstatSync(candidate);
			continue;
		} catch {
			// The slot is free.
		}
		try {
			renameSync(path, candidate);
			syncDirectory(parent);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				continue;
			}
			throw agentError(AgentRuntimeErrorCode.Unavailable);
		}
	}
	throw agentError(AgentRuntimeErrorCode.Unavailable);
}

export interface TerminalControl {
	sendText(text: string): Promise<void>;
	/** Tell the provider the surface's grid, so the agent lays out to it. */
	resize(cols: number, rows: number): void;
	readRecent(): Promise<Buffer>;
	detach(): void;
}

export class AgentRuntimeState {
	readonly mappings = new Map<AgentId, ProviderMapping>();
	/**
	 * Provider-private proof that this mapping has been observed as an active
	 * agent. Herdr can clear the detected label after exit while the pane
	 * remains alive, so absence is only exit evidence after confirmation.
	 */
	readonly confirmedAgents = new Set<AgentId>();
	readonly workspaceRoots = new Map<AgentId, [WorkspaceId, string]>();
	readonly tombstones = new Map<AgentId, CleanupTombstone>();
	readonly stopping = new Set<AgentId>();
	readonly surfaces = new Map<string, AgentId>();
	readonly controls = new Map<string, TerminalControl>();
	nextGenerationCounter = 0;

	nextGeneration(): number {
		this.nextGenerationCounter = Math.max(this.nextGenerationCounter + 1, 1);
		return this.nextGenerationCounter;
	}

	addTombstone(
		agentId: AgentId,
		mapping: ProviderMapping,
		reason: TombstoneReason,
	): void {
		this.confirmedAgents.delete(agentId);
		if (
			this.tombstones.size >= MAX_TOMBSTONES &&
			!this.tombstones.has(agentId)
		) {
			throw agentError(AgentRuntimeErrorCode.CleanupPending);
		}
		if (!this.tombstones.has(agentId)) {
			this.tombstones.set(agentId, {
				mapping,
				reason,
				attempts: 0,
				nextRetry: Date.now(),
			});
		}
	}

	recordCleanupFailure(agentId: AgentId): void {
		const tombstone = this.tombstones.get(agentId);
		if (tombstone === undefined) {
			return;
		}
		tombstone.attempts = Math.min(tombstone.attempts + 1, 255);
		const exponent = Math.min(tombstone.attempts, 4);
		tombstone.nextRetry = Date.now() + CLEANUP_RETRY_BASE_MS * 2 ** exponent;
	}

	takeSurfaces(agentId: AgentId): TerminalControl[] {
		const keys = [...this.surfaces.entries()]
			.filter(([, owner]) => owner === agentId)
			.map(([key]) => key);
		const controls: TerminalControl[] = [];
		for (const key of keys) {
			this.surfaces.delete(key);
			const control = this.controls.get(key);
			if (control !== undefined) {
				this.controls.delete(key);
				controls.push(control);
			}
		}
		return controls;
	}
}

/**
 * Provider snapshot data is private and intentionally lossy. Only fields
 * required for reconciliation and mapping recovery are retained.
 */
export interface ProviderSnapshot {
	readonly workspaces: readonly ProviderWorkspace[];
	readonly panes: readonly ProviderPane[];
}

export interface ProviderWorkspace {
	readonly id: string;
	readonly label: string | undefined;
}

export interface ProviderPane {
	readonly id: string;
	readonly terminalId: string;
	readonly workspaceId: string;
	readonly tabId: string;
	readonly agent: string | undefined;
	readonly status: ProviderStatus;
}

export enum ProviderStatus {
	Idle = "idle",
	Working = "working",
	Blocked = "blocked",
	Done = "done",
	Unknown = "unknown",
}

export function providerStatusFromWire(
	value: string | undefined | null,
): ProviderStatus {
	switch (value) {
		case "idle":
			return ProviderStatus.Idle;
		case "working":
			return ProviderStatus.Working;
		case "blocked":
			return ProviderStatus.Blocked;
		case "done":
			return ProviderStatus.Done;
		default:
			return ProviderStatus.Unknown;
	}
}

export function providerStatusIsExited(status: ProviderStatus): boolean {
	return status === ProviderStatus.Done;
}

export function projectProviderStatus(
	status: ProviderStatus,
): [AgentStatus, RuntimeHealth] {
	switch (status) {
		case ProviderStatus.Working:
			return [AgentStatus.Working, RuntimeHealth.Healthy];
		case ProviderStatus.Blocked:
			return [AgentStatus.Waiting, RuntimeHealth.Healthy];
		case ProviderStatus.Idle:
			return [AgentStatus.Idle, RuntimeHealth.Healthy];
		case ProviderStatus.Done:
			return [AgentStatus.Idle, RuntimeHealth.Healthy];
		case ProviderStatus.Unknown:
			return [AgentStatus.Error, RuntimeHealth.Degraded];
	}
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Json)
		: undefined;
}

export function parseSessionSnapshot(value: unknown): ProviderSnapshot {
	const raw = asObject(asObject(value)?.snapshot);
	if (raw === undefined) {
		throw agentError(AgentRuntimeErrorCode.ProviderRejected);
	}
	const rawWorkspaces = Array.isArray(raw.workspaces) ? raw.workspaces : [];
	const rawPanes = Array.isArray(raw.panes) ? raw.panes : [];
	const rawAgents = Array.isArray(raw.agents) ? raw.agents : [];
	if (rawWorkspaces.length + rawPanes.length > 16_384) {
		throw agentError(AgentRuntimeErrorCode.BoundedInput);
	}
	// Where the agent identity lives is read two ways. A live 0.8.2 snapshot
	// puts it on the pane — `agent`, `agent_status`, `agent_session` — and has
	// no top-level `agents` at all; a release that keys agents by pane in a
	// list of their own is read as well. The fact the adapter needs is the same
	// one either way — "this pane has a detected agent" — and the confirmed-
	// agent rule that decides natural exit is built on it.
	const agentByPane = new Map<string, string>();
	for (const entry of rawAgents) {
		const agent = asObject(entry);
		const paneId = agent?.pane_id;
		const name = agent?.name;
		if (typeof paneId === "string" && typeof name === "string") {
			agentByPane.set(paneId, name);
		}
	}
	const workspaces = rawWorkspaces.map((entry): ProviderWorkspace => {
		const workspace = asObject(entry);
		if (workspace === undefined) {
			throw agentError(AgentRuntimeErrorCode.ProviderRejected);
		}
		return {
			id: boundedProviderId(requireString(workspace, "workspace_id")),
			label: optionalBoundedLabel(workspace.label),
		};
	});
	const panes = rawPanes.map((entry): ProviderPane => {
		const pane = asObject(entry);
		if (pane === undefined) {
			throw agentError(AgentRuntimeErrorCode.ProviderRejected);
		}
		const id = boundedProviderId(requireString(pane, "pane_id"));
		return {
			id,
			terminalId: boundedProviderId(requireString(pane, "terminal_id")),
			workspaceId: boundedProviderId(requireString(pane, "workspace_id")),
			tabId: boundedProviderId(requireString(pane, "tab_id")),
			agent:
				optionalBoundedLabel(pane.agent) ??
				optionalBoundedLabel(agentByPane.get(id)),
			status: providerStatusFromWire(
				typeof pane.agent_status === "string" ? pane.agent_status : undefined,
			),
		};
	});
	return { workspaces, panes };
}

export function parseCreatedMapping(
	value: unknown,
	workspaceRootPath: string,
	workspaceDomainId: WorkspaceId | undefined,
	generation: number,
): ProviderMapping {
	const created = asObject(value);
	const workspace = asObject(created?.workspace);
	const tab = asObject(created?.tab);
	const pane = asObject(created?.root_pane);
	if (workspace === undefined || tab === undefined || pane === undefined) {
		throw agentError(AgentRuntimeErrorCode.ProviderRejected);
	}
	return {
		workspaceId: boundedProviderId(requireString(workspace, "workspace_id")),
		tabId: boundedProviderId(requireString(tab, "tab_id")),
		paneId: boundedProviderId(requireString(pane, "pane_id")),
		terminalId: boundedProviderId(requireString(pane, "terminal_id")),
		workspaceRoot: workspaceRootPath,
		workspaceDomainId,
		generation,
	};
}

/**
 * Best-effort mapping used only when workspace creation returned a malformed
 * response after creating provider resources. Cleanup needs only workspace and
 * pane IDs; synthetic values keep the retry record schema complete while never
 * exposing a partial provider response at the domain boundary.
 */
export function cleanupMappingFromCreated(
	value: unknown,
	workspaceRootPath: string,
	workspaceDomainId: WorkspaceId | undefined,
	generation: number,
): ProviderMapping | undefined {
	const created = asObject(value);
	const workspaceId = tryBoundedProviderId(
		asObject(created?.workspace)?.workspace_id,
	);
	const pane = asObject(created?.root_pane);
	if (workspaceId === undefined || pane === undefined) {
		return undefined;
	}
	const paneId = tryBoundedProviderId(pane.pane_id);
	if (paneId === undefined) {
		return undefined;
	}
	return {
		workspaceId,
		tabId:
			tryBoundedProviderId(asObject(created?.tab)?.tab_id) ??
			"cleanup-tab-unavailable",
		paneId,
		terminalId:
			tryBoundedProviderId(pane.terminal_id) ?? "cleanup-terminal-unavailable",
		workspaceRoot: workspaceRootPath,
		workspaceDomainId,
		generation,
	};
}

export function terminalIdFromStarted(value: unknown): string {
	const agent = asObject(asObject(value)?.agent);
	if (agent === undefined) {
		throw agentError(AgentRuntimeErrorCode.ProviderRejected);
	}
	return boundedProviderId(requireString(agent, "terminal_id"));
}

function requireString(value: Json, field: string): string {
	const found = value[field];
	if (typeof found !== "string") {
		throw agentError(AgentRuntimeErrorCode.ProviderRejected);
	}
	return found;
}

function boundedProviderId(value: string): string {
	if (
		value.length === 0 ||
		Buffer.byteLength(value) > MAX_PROVIDER_ID_BYTES ||
		CONTROL_CHARACTER.test(value)
	) {
		throw agentError(AgentRuntimeErrorCode.BoundedInput);
	}
	return value;
}

function tryBoundedProviderId(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	try {
		return boundedProviderId(value);
	} catch {
		return undefined;
	}
}

function optionalBoundedLabel(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	if (
		Buffer.byteLength(value) > MAX_PROVIDER_ID_BYTES ||
		CONTROL_CHARACTER.test(value)
	) {
		return undefined;
	}
	return value;
}

export const MARKER_LABEL_PREFIX = "devhub-agent-";

export function markerLabel(agentId: AgentId): string {
	return `${MARKER_LABEL_PREFIX}${agentId}`;
}

export function recoverMapping(
	snapshot: ProviderSnapshot,
	agentId: AgentId,
	root: string,
	workspaceDomainId: WorkspaceId | undefined,
	generation: number,
): ProviderMapping | undefined {
	const label = markerLabel(agentId);
	const workspace = snapshot.workspaces.find(
		(candidate) => candidate.label === label,
	);
	if (workspace === undefined) {
		return undefined;
	}
	const pane =
		snapshot.panes.find(
			(candidate) =>
				candidate.workspaceId === workspace.id && candidate.agent !== undefined,
		) ??
		snapshot.panes.find((candidate) => candidate.workspaceId === workspace.id);
	if (pane === undefined) {
		return undefined;
	}
	return {
		workspaceId: workspace.id,
		tabId: pane.tabId,
		paneId: pane.id,
		terminalId: pane.terminalId,
		workspaceRoot: root,
		workspaceDomainId,
		generation,
	};
}

export function paneFor(
	snapshot: ProviderSnapshot,
	mapping: ProviderMapping,
): ProviderPane | undefined {
	return snapshot.panes.find((pane) => pane.id === mapping.paneId);
}
