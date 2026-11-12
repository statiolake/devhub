/**
 * Voice input, turned on and off: the setting, the model, and the download
 * between them.
 *
 * Off by default (`[voice] enabled = false`), and the model it reads is not
 * in the app. Turning it on — the switch in Settings, or the first press of
 * the microphone (or ⌘⇧M) — first says what would be downloaded: which
 * model, how big, from which host, where it is kept, and that it runs on the
 * Mac afterwards with no audio leaving it. Only on ダウンロード is the setting
 * written and the download started; キャンセル leaves voice input off and
 * downloads nothing. A model that is already here (downloaded before, or the
 * development override) is not asked about: nothing is downloaded.
 *
 * Each model is `absent`, `downloading`, `verifying`, `ready` or `failed`
 * (`ipc/voice.ts`, `VoiceModelState`). A failed download keeps what arrived
 * and is retried from there; a cancelled one is deleted. Turning voice input
 * off stops a download and, when the person says so, deletes the models.
 *
 * The confirmation is asked by whoever turns it on: Settings draws its own
 * sheet and then calls `enable`; the microphone's press calls `setUp`, which
 * asks through `ask` (the modal layer of the main window).
 */

import { join } from "node:path";

import {
	consentFor,
	NO_RECOGNISER,
	voiceStatusOf,
	type VoiceConsentWire,
	type VoiceModelId,
	type VoiceModelState,
	type VoiceResult,
	type VoiceSetupWire,
	type VoiceStatus,
} from "../../ipc/voice.js";
import {
	downloadModel as realDownload,
	isAbort,
	removeModel as realRemove,
	type DownloadOptions,
	type ModelFetcher,
} from "./modelDownload.js";
import { hostOf, modelIsReady, type VoiceModelPin } from "./voiceModels.js";

/** `[voice]` as main reads and writes it. */
export interface VoiceSettings {
	readonly enabled: boolean;
	readonly model: VoiceModelId;
}

export interface VoiceSetupDeps {
	readonly pins: readonly VoiceModelPin[];
	/** `<userData>/devhub/whisper`. */
	readonly directory: string;
	/** The same, as it is shown (`~` for the home directory). */
	readonly displayDirectory: string;
	/** Whether the recogniser's programs are in this build. */
	readonly recogniser: boolean;
	/** A model file the development override has for `pin`, if any. */
	readonly override: (pin: VoiceModelPin) => string | undefined;
	readonly settings: {
		read(): VoiceSettings;
		write(next: VoiceSettings): Promise<void>;
	};
	/** The confirmation, for `setUp`: `true` on ダウンロード. */
	readonly ask: (consent: VoiceConsentWire) => Promise<boolean>;
	readonly fetch: ModelFetcher;
	/** For tests. */
	readonly download?: (options: DownloadOptions) => Promise<string>;
	readonly remove?: (directory: string, pin: VoiceModelPin) => Promise<void>;
	readonly isReady?: (directory: string, pin: VoiceModelPin) => boolean;
}

/** What `setUp` and Settings' calls answer when there is nothing to do it with. */
const NO_SUCH_MODEL = "その音声認識モデルはこの DevHub では選べません。";

export class VoiceSetup {
	readonly #deps: VoiceSetupDeps;
	readonly #states = new Map<VoiceModelId, VoiceModelState>();
	readonly #listeners = new Set<() => void>();
	#running:
		| {
				readonly model: VoiceModelId;
				readonly controller: AbortController;
				readonly done: Promise<void>;
		  }
		| undefined;
	/** The last percent said, so progress is said a hundred times, not a thousand. */
	#lastPercent = -1;

	constructor(deps: VoiceSetupDeps) {
		this.#deps = deps;
		const ready = deps.isReady ?? modelIsReady;
		for (const pin of deps.pins) {
			this.#states.set(
				pin.id,
				ready(deps.directory, pin) ? { kind: "ready" } : { kind: "absent" },
			);
		}
	}

	/** Be told whenever anything `wire` says changes. */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#changed(): void {
		for (const listener of [...this.#listeners]) listener();
	}

	#pin(model: VoiceModelId): VoiceModelPin | undefined {
		return this.#deps.pins.find((pin) => pin.id === model);
	}

	#set(model: VoiceModelId, state: VoiceModelState): void {
		this.#states.set(model, state);
		this.#changed();
	}

	wire(): VoiceSetupWire {
		const settings = this.#deps.settings.read();
		const chosen = this.#pin(settings.model);
		const override =
			chosen === undefined ? undefined : this.#deps.override(chosen);
		return {
			recogniser: this.#deps.recogniser,
			enabled: settings.enabled,
			model: settings.model,
			directory: this.#deps.displayDirectory,
			models: this.#deps.pins.map((pin) => ({
				id: pin.id,
				label: pin.label,
				file: pin.file,
				size: pin.size,
				host: hostOf(pin),
				state: this.#states.get(pin.id) ?? { kind: "absent" },
			})),
			...(override === undefined ? {} : { override }),
		};
	}

	status(): VoiceStatus {
		return voiceStatusOf(this.wire());
	}

	/**
	 * The model dictation reads now: the chosen one, when voice input is on
	 * and it is here. `undefined` is "refuse": `status` says why.
	 */
	modelPath(): string | undefined {
		const settings = this.#deps.settings.read();
		if (!this.#deps.recogniser || !settings.enabled) return undefined;
		const pin = this.#pin(settings.model);
		if (pin === undefined) return undefined;
		const override = this.#deps.override(pin);
		if (override !== undefined) return override;
		return this.#states.get(pin.id)?.kind === "ready"
			? join(this.#deps.directory, pin.file)
			: undefined;
	}

	/** Whether `model` needs downloading before it can be used. */
	#needsDownload(pin: VoiceModelPin): boolean {
		return (
			this.#deps.override(pin) === undefined &&
			this.#states.get(pin.id)?.kind !== "ready"
		);
	}

	/**
	 * A press of the microphone while dictation cannot run: turn voice input
	 * on (asking first when that downloads), or retry a failed download.
	 * `ok` with `true` once it is on or downloading, `false` on キャンセル.
	 */
	async setUp(): Promise<VoiceResult<boolean>> {
		if (!this.#deps.recogniser) return { ok: false, reason: NO_RECOGNISER };
		const settings = this.#deps.settings.read();
		const pin = this.#pin(settings.model);
		if (pin === undefined) return { ok: false, reason: NO_SUCH_MODEL };
		const state = this.#states.get(pin.id);
		if (state?.kind === "downloading" || state?.kind === "verifying")
			return { ok: true, value: true };
		if (settings.enabled && state?.kind === "failed")
			return this.retry().then(ok);
		if (this.#needsDownload(pin)) {
			const consent = consentFor(this.wire(), pin.id);
			if (consent === undefined || !(await this.#deps.ask(consent)))
				return { ok: true, value: false };
		}
		return (await this.enable(pin.id)).ok
			? { ok: true, value: true }
			: { ok: false, reason: "音声入力をオンにできませんでした。" };
	}

	/**
	 * Turn voice input on with `model`, the person having agreed: the setting
	 * is written, and the model downloaded if it is not here.
	 */
	async enable(model: VoiceModelId): Promise<VoiceResult<VoiceSetupWire>> {
		const pin = this.#pin(model);
		if (pin === undefined) return { ok: false, reason: NO_SUCH_MODEL };
		if (!this.#deps.recogniser) return { ok: false, reason: NO_RECOGNISER };
		const before = this.#deps.settings.read();
		try {
			await this.#deps.settings.write({ enabled: true, model });
		} catch (error: unknown) {
			return { ok: false, reason: settingsFailure(error) };
		}
		// Another model's download is not wanted any more.
		if (this.#running !== undefined && this.#running.model !== model)
			await this.#stop(true);
		if (this.#needsDownload(pin)) this.#start(pin);
		else if (before.enabled !== true || before.model !== model) this.#changed();
		return { ok: true, value: this.wire() };
	}

	/** Turn voice input off: any download stops, and the models go when asked. */
	async disable(deleteModels: boolean): Promise<VoiceResult<VoiceSetupWire>> {
		const settings = this.#deps.settings.read();
		await this.#stop(true);
		try {
			if (settings.enabled)
				await this.#deps.settings.write({ ...settings, enabled: false });
		} catch (error: unknown) {
			return { ok: false, reason: settingsFailure(error) };
		}
		if (deleteModels) {
			for (const pin of this.#deps.pins) {
				const deleted = await this.#delete(pin);
				if (!deleted.ok) return deleted;
			}
		}
		this.#changed();
		return { ok: true, value: this.wire() };
	}

	/** Delete one model (Settings asks first). */
	async deleteModel(model: VoiceModelId): Promise<VoiceResult<VoiceSetupWire>> {
		const pin = this.#pin(model);
		if (pin === undefined) return { ok: false, reason: NO_SUCH_MODEL };
		if (this.#running?.model === model) await this.#stop(true);
		const deleted = await this.#delete(pin);
		return deleted.ok ? { ok: true, value: this.wire() } : deleted;
	}

	async #delete(
		pin: VoiceModelPin,
	): Promise<VoiceResult<never> | { ok: true }> {
		try {
			await (this.#deps.remove ?? realRemove)(this.#deps.directory, pin);
		} catch (error: unknown) {
			return {
				ok: false,
				reason: `${pin.file} を削除できませんでした: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		this.#set(pin.id, { kind: "absent" });
		return { ok: true };
	}

	/** Download again what failed, from where it stopped. */
	async retry(): Promise<VoiceResult<VoiceSetupWire>> {
		const settings = this.#deps.settings.read();
		const pin = this.#pin(settings.model);
		if (pin === undefined) return { ok: false, reason: NO_SUCH_MODEL };
		if (!settings.enabled)
			return {
				ok: false,
				reason: "音声入力がオフです。先にオンにしてください。",
			};
		if (this.#running === undefined && this.#needsDownload(pin))
			this.#start(pin);
		return { ok: true, value: this.wire() };
	}

	/** Stop the download and leave voice input off: the person changed their mind. */
	async cancelDownload(): Promise<VoiceResult<VoiceSetupWire>> {
		return this.disable(false);
	}

	/**
	 * The settings changed (a save, or the file edited by hand). Turned off,
	 * or onto another model, the download running stops: nothing is
	 * downloaded that the settings no longer ask for.
	 */
	settingsChanged(): void {
		const settings = this.#deps.settings.read();
		const running = this.#running;
		if (
			running !== undefined &&
			(!settings.enabled || running.model !== settings.model)
		) {
			void this.#stop(true);
		}
		this.#changed();
	}

	/** Wait for the download running now, if any. For tests and for quitting. */
	async settled(): Promise<void> {
		await this.#running?.done;
	}

	/** Stop the download; `discard` deletes what had arrived. */
	async #stop(discard: boolean): Promise<void> {
		const running = this.#running;
		if (running === undefined) return;
		running.controller.abort();
		await running.done;
		const pin = this.#pin(running.model);
		if (discard && pin !== undefined) {
			await (this.#deps.remove ?? realRemove)(this.#deps.directory, pin).catch(
				() => undefined,
			);
			this.#set(running.model, { kind: "absent" });
		}
	}

	#start(pin: VoiceModelPin): void {
		const controller = new AbortController();
		this.#lastPercent = -1;
		this.#set(pin.id, { kind: "downloading", received: 0, total: undefined });
		const download = this.#deps.download ?? realDownload;
		const done = download({
			pin,
			directory: this.#deps.directory,
			fetch: this.#deps.fetch,
			signal: controller.signal,
			onProgress: ({ received, total }) => {
				const percent =
					total === undefined || total === 0
						? Math.floor(received / 4_000_000)
						: Math.floor((received / total) * 100);
				if (percent === this.#lastPercent) return;
				this.#lastPercent = percent;
				this.#set(pin.id, { kind: "downloading", received, total });
			},
			onVerifying: () => {
				this.#set(pin.id, { kind: "verifying" });
			},
		}).then(
			() => {
				if (this.#running?.controller === controller) this.#running = undefined;
				this.#set(pin.id, { kind: "ready" });
			},
			(error: unknown) => {
				if (this.#running?.controller === controller) this.#running = undefined;
				if (controller.signal.aborted || isAbort(error)) {
					this.#set(pin.id, { kind: "absent" });
					return;
				}
				this.#set(pin.id, {
					kind: "failed",
					reason: error instanceof Error ? error.message : String(error),
				});
			},
		);
		this.#running = { model: pin.id, controller, done };
	}
}

function ok(result: VoiceResult<VoiceSetupWire>): VoiceResult<boolean> {
	return result.ok ? { ok: true, value: true } : result;
}

function settingsFailure(error: unknown): string {
	return `settings.toml に書けませんでした: ${error instanceof Error ? error.message : String(error)}`;
}
