/**
 * The notices' bridge — `toasts.html`.
 *
 * The smallest bridge DevHub has, and deliberately: a notice is about DevHub,
 * and nothing about DevHub's model is needed to draw one. There is no
 * snapshot here, no appearance, no workspaces. See `ToastsBridge`, and
 * `shell/toasts/ToastsApp.tsx`.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
	CHANNELS,
	type AppConditionWire,
	type MenuCommand,
	type ToastsBridge,
} from "../ipc/contract.js";
import type { AppError, NoticeRetiredWire } from "../ipc/appShell.js";
import { on, openSettings, pageBridge } from "./bridge.js";

const api: ToastsBridge = {
	...pageBridge(),

	onNativeError: (listener) => on<AppError>(CHANNELS.nativeError, listener),
	onAppCondition: (listener) =>
		on<AppConditionWire>(CHANNELS.appCondition, listener),
	onActionStarted: (listener) => on<void>(CHANNELS.actionStarted, listener),
	onMenuCommand: (listener) => on<MenuCommand>(CHANNELS.menuCommand, listener),

	reportNoticeRetired: (retired: NoticeRetiredWire) =>
		ipcRenderer.invoke(CHANNELS.noticeRetired, retired) as Promise<void>,
	reportToastsSize: (size) => {
		ipcRenderer.send(CHANNELS.toastsSize, size);
	},
	retryApp: () => {
		ipcRenderer.send(CHANNELS.retryApp);
	},
	openSettings,
};

contextBridge.exposeInMainWorld("devhub", api);
