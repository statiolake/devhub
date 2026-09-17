/**
 * The tooltip's bridge — `tooltip.html`.
 *
 * The smallest bridge DevHub has, smaller than the notices': one push in, one
 * measurement out, and the two members every DevHub page has. A tooltip is a
 * list of facts somebody else composed; this page draws them, each behind the
 * mark its name resolves to, and says how big the box came out. See `TooltipBridge`, and `shell/tooltip/TooltipApp.tsx` for the same
 * contract said in the page's own words.
 *
 * It is no longer *quite* the smallest: a box the pointer may enter says when
 * it has, and a line that names a page may be followed. Both are about the box
 * itself — where the pointer is in it, and what was clicked in it — and neither
 * is a thing the Sidebar could have said instead.
 *
 * `onTooltip` carries the lines and nothing else. The anchor travels from the
 * Sidebar to main and stops there — it is what `windowLayout.ts` turns into a
 * rectangle, and a renderer that was handed it could do nothing with it.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
	CHANNELS,
	type TooltipBridge,
	type TooltipContentWire,
} from "../ipc/contract.js";
import { on, openExternalUrl, pageBridge } from "./bridge.js";

const api: TooltipBridge = {
	...pageBridge(),

	onTooltip: (listener) =>
		on<TooltipContentWire | undefined>(CHANNELS.tooltipText, listener),
	reportTooltipSize: (size) => {
		ipcRenderer.send(CHANNELS.tooltipSize, size);
	},
	// Where the pointer is, one way, for the same reason the size is: it is a
	// fact this page has, and main is the only thing that can join it to the
	// Sidebar's own leave. See `TooltipBridge.reportTooltipPointer`.
	reportTooltipPointer: (inside) => {
		ipcRenderer.send(CHANNELS.tooltipPointer, inside);
	},
	// The box's links. A tooltip draws a row's facts, three of which are pages
	// on GitHub, and it reaches them by the same route the row does.
	openExternalUrl,
};

contextBridge.exposeInMainWorld("devhub", api);
