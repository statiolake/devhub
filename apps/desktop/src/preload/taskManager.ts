/**
 * The Task Manager window's bridge — `task-manager.html`.
 *
 * Two globals, as Settings has: `window.devhubTaskManager` is everything the
 * window is for (`ipc/taskManager.ts`) — a snapshot, and the four things a row
 * can do — and `window.devhub` only the failure contract every DevHub page
 * has. It reaches no projection, no workspaces and no modal layer.
 */

import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type TaskManagerPageBridge } from "../ipc/contract.js";
import type { AppError } from "../ipc/appShell.js";
import {
	TASK_MANAGER_CHANNELS,
	type TaskManagerApi,
	type TaskRevealWire,
	type TaskSnapshotWire,
} from "../ipc/taskManager.js";
import { on, pageBridge } from "./bridge.js";

const devhub: TaskManagerPageBridge = {
	...pageBridge(),
	onNativeError: (listener) => on<AppError>(CHANNELS.nativeError, listener),
};

const devhubTaskManager: TaskManagerApi = {
	snapshot: () =>
		ipcRenderer.invoke(
			TASK_MANAGER_CHANNELS.snapshot,
		) as Promise<TaskSnapshotWire>,
	stopAgent: (agentId: string) =>
		ipcRenderer.invoke(
			TASK_MANAGER_CHANNELS.stopAgent,
			agentId,
		) as Promise<void>,
	reveal: (target: TaskRevealWire) =>
		ipcRenderer.invoke(TASK_MANAGER_CHANNELS.reveal, target) as Promise<void>,
	kill: (pid: number) =>
		ipcRenderer.invoke(TASK_MANAGER_CHANNELS.kill, pid) as Promise<boolean>,
	copy: () => ipcRenderer.invoke(TASK_MANAGER_CHANNELS.copy) as Promise<void>,
	close: () => ipcRenderer.invoke(TASK_MANAGER_CHANNELS.close) as Promise<void>,
};

contextBridge.exposeInMainWorld("devhub", devhub);
contextBridge.exposeInMainWorld("devhubTaskManager", devhubTaskManager);
