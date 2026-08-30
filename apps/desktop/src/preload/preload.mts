/**
 * The App Shell page's only way to reach the main process.
 *
 * Nothing here decides anything: each member forwards one request and lets the
 * failure through. A rejected call surfaces in the page's error area rather
 * than being turned into a quiet default here.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type ContentRect, type DevhubApi, type ShellState } from '../ipc/contract.js';

const api: DevhubApi = {
	getState: () => ipcRenderer.invoke(CHANNELS.getState) as Promise<ShellState>,

	onStateChanged: listener => {
		const handler = (_event: Electron.IpcRendererEvent, state: ShellState) => listener(state);
		ipcRenderer.on(CHANNELS.stateChanged, handler);
		return () => ipcRenderer.removeListener(CHANNELS.stateChanged, handler);
	},

	selectWorkspace: id => ipcRenderer.invoke(CHANNELS.selectWorkspace, id) as Promise<void>,
	addWorkspace: () => ipcRenderer.invoke(CHANNELS.addWorkspace) as Promise<void>,
	removeWorkspace: id => ipcRenderer.invoke(CHANNELS.removeWorkspace, id) as Promise<void>,
	setContentRect: (rect: ContentRect) => ipcRenderer.invoke(CHANNELS.setContentRect, rect) as Promise<void>
};

contextBridge.exposeInMainWorld('devhub', api);
