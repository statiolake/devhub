/**
 * The tooltip's bridge — `tooltip.html`.
 *
 * The smallest bridge DevHub has, smaller than the notices': one push in, one
 * measurement out, and the two members every DevHub page has. A tooltip is a
 * sentence somebody else composed; this page draws it and says how big it came
 * out. See `TooltipBridge`, and `shell/tooltip/TooltipApp.tsx` for the same
 * contract said in the page's own words.
 *
 * `onTooltip` carries the text and nothing else. The anchor and the preferred
 * side travel from the Sidebar to main and stop there — they are what
 * `windowLayout.ts` turns into a rectangle, and a renderer that was handed
 * them could do nothing with them.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
	CHANNELS,
	type TooltipBridge,
	type TooltipTextWire,
} from "../ipc/contract.js";
import { on, pageBridge } from "./bridge.js";

const api: TooltipBridge = {
	...pageBridge(),

	onTooltip: (listener) =>
		on<TooltipTextWire | undefined>(CHANNELS.tooltipText, listener),
	reportTooltipSize: (size) => {
		ipcRenderer.send(CHANNELS.tooltipSize, size);
	},
};

contextBridge.exposeInMainWorld("devhub", api);
