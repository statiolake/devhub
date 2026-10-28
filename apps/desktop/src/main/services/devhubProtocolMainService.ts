/**
 * VS Code's protocol service, with the start theme in every window
 * configuration it hands a renderer.
 *
 * A workbench window's configuration reaches its renderer through one IPC
 * object URL per window, which `CodeWindow` updates on every load — the first,
 * a reload, a window reopened — just before the page asks for it. DevHub adds
 * the colour theme the workbench is to start in at that point
 * (`withWorkbenchStart`), so whichever way a window was loaded its theme is in
 * the configuration, and it is the theme being worn at that load rather than
 * the one the window was first opened in. See
 * `../shell/workbenchStartTheme.ts`.
 *
 * `CodeWindow`'s configuration is the only object URL upstream makes;
 * anything else would pass through unchanged (`withWorkbenchStart` only
 * touches an object with a `windowId`). Constructed in `codeMain.ts` in place
 * of upstream's; a VS Code bump re-checks `createIPCObjectUrl`.
 */

import { ProtocolMainService } from "code-oss-dev/out/vs/platform/protocol/electron-main/protocolMainService.js";
import type { IIPCObjectUrl } from "code-oss-dev/out/vs/platform/protocol/electron-main/protocol.js";
import {
	currentWorkbenchStart,
	withWorkbenchStart,
} from "../shell/workbenchStartTheme.js";

export class DevHubProtocolMainService extends ProtocolMainService {
	override createIPCObjectUrl<T>(): IIPCObjectUrl<T> {
		const url = super.createIPCObjectUrl<T>();
		return {
			resource: url.resource,
			update: (obj: T) => {
				const start = currentWorkbenchStart();
				url.update(start ? withWorkbenchStart(obj, start) : obj);
			},
			dispose: () => {
				url.dispose();
			},
		};
	}
}
