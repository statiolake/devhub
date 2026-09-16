/**
 * The tooltip's bridge — `tooltip.html`.
 *
 * The smallest bridge DevHub has, smaller than the notices': one push in, one
 * measurement out, and the two members every DevHub page has. A tooltip is a
 * list of facts somebody else composed; this page draws them, each behind the
 * mark its name resolves to, and says how big the box came out. See `TooltipBridge`, and `shell/tooltip/TooltipApp.tsx` for the same
 * contract said in the page's own words.
 *
 * `onTooltip` carries the lines and nothing else. The anchor and the preferred
 * side travel from the Sidebar to main and stop there — they are what
 * `windowLayout.ts` turns into a rectangle, and a renderer that was handed
 * them could do nothing with them.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
	CHANNELS,
	type TooltipBridge,
	type TooltipContentWire,
} from "../ipc/contract.js";
import { on, pageBridge } from "./bridge.js";

const api: TooltipBridge = {
	...pageBridge(),

	onTooltip: (listener) =>
		on<TooltipContentWire | undefined>(CHANNELS.tooltipText, listener),
	reportTooltipSize: (size) => {
		ipcRenderer.send(CHANNELS.tooltipSize, size);
	},
};

contextBridge.exposeInMainWorld("devhub", api);
