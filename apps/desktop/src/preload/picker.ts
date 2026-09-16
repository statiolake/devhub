/**
 * The questions' bridge — `picker.html`.
 *
 * The one bridge with `onModals` on it. Main sends `devhub:modals-changed` to
 * this view directly rather than through `send()`, so its absence from every
 * other bridge is not a restriction — it is the truth about which page can
 * ever hear it, said in the one place that can make it unspellable. See
 * `PickerBridge`, and `shell/picker/PickerApp.tsx`.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
	CHANNELS,
	type OpenModal,
	type PickerBridge,
} from "../ipc/contract.js";
import type { AppOutcome } from "../ipc/appShell.js";
import {
	agentActionsBridge,
	agentProfilesBridge,
	on,
	pageBridge,
	projectionBridge,
	workspaceOpeningBridge,
} from "./bridge.js";

const api: PickerBridge = {
	...pageBridge(),
	...projectionBridge(),
	...agentProfilesBridge(),
	...agentActionsBridge(),
	...workspaceOpeningBridge(),

	onModals: (listener) =>
		on<readonly OpenModal[]>(CHANNELS.modalsChanged, listener),
	closeModal: (id: string, response?: number) =>
		ipcRenderer.invoke(CHANNELS.closeModal, id, response) as Promise<void>,
	confirmInjection: (agentId: string, injectionId: string, text: string) =>
		ipcRenderer.invoke(
			CHANNELS.confirmInjection,
			agentId,
			injectionId,
			text,
		) as Promise<AppOutcome>,
	cancelInjection: (agentId: string, injectionId: string) =>
		ipcRenderer.invoke(
			CHANNELS.cancelInjection,
			agentId,
			injectionId,
		) as Promise<AppOutcome>,
	answerWorktreeClose: (workspaceId: string, answer: "close" | "delete") =>
		ipcRenderer.invoke(
			CHANNELS.answerWorktreeClose,
			workspaceId,
			answer,
		) as Promise<AppOutcome>,
	cancelRepositoryLookup: () =>
		ipcRenderer.invoke(CHANNELS.cancelRepositoryLookup) as Promise<void>,
};

contextBridge.exposeInMainWorld("devhub", api);
