/**
 * Replace Electron's `BrowserWindow` before VS Code ever sees it.
 *
 * VS Code creates its workbench window with `new Electron.BrowserWindow(...)`
 * and finds windows again through the statics `getAllWindows`,
 * `fromWebContents`, `getFocusedWindow` and `fromId`. Rather than patch those
 * call sites in the submodule, DevHub installs a subclass on the `electron`
 * module object once, at startup, before any VS Code module is loaded:
 *
 *  - constructing one with a workbench window's options returns a
 *    `WorkbenchView` instead of a window (a constructor may return a different
 *    object; the derived constructor simply never calls `super`);
 *  - the statics answer with the views, so every `getWindowById` /
 *    `getWindowByWebContents` / `getFocusedWindow` path in the main process
 *    keeps working unmodified.
 *
 * The App Shell window itself is created through the same class, with options
 * that carry no workbench signature, so it comes out as a real window.
 *
 * The module property is a lazy getter, and ESM named imports of a CommonJS
 * module snapshot its properties the first time it is imported as ESM. Both are
 * checked here and both fail loudly: a silent fallback would leave the workbench
 * quietly creating real windows.
 */

import { electron as electronModule } from '../electron.js';
import { shellWindow, shellWindowIfCreated } from './shellWindow.js';
import { asBrowserWindow, WorkbenchView } from './workbenchView.js';

/**
 * The signature of a workbench window: `CodeWindow` passes the address of its
 * window configuration to the sandbox preload through an additional argument,
 * and nothing else in the main process does.
 */
const WINDOW_CONFIG_ARGUMENT = '--vscode-window-config=';

function isWorkbenchWindow(options: Electron.BrowserWindowConstructorOptions | undefined): boolean {
	return options?.webPreferences?.additionalArguments?.some(argument => argument.startsWith(WINDOW_CONFIG_ARGUMENT)) ?? false;
}

export async function installBrowserWindowShim(): Promise<void> {
	const RealBrowserWindow = electronModule.BrowserWindow;

	class DevHubBrowserWindow extends RealBrowserWindow {
		constructor(options?: Electron.BrowserWindowConstructorOptions) {
			if (isWorkbenchWindow(options)) {
				const shell = shellWindow();
				const view = new WorkbenchView(shell, options!);
				shell.attach(view);
				console.log(`[devhub] workbench view ${view.id} created — ${shell.getViews().length} view(s) in the shell`);
				return asBrowserWindow(view) as unknown as DevHubBrowserWindow;
			}

			super(options);
		}

		/**
		 * The windows VS Code owns are the workbench views. The App Shell
		 * window is DevHub's own chrome: handing it to VS Code would put it in
		 * the lifecycle's kill list and in the diagnostics as a workbench.
		 */
		static override getAllWindows(): Electron.BrowserWindow[] {
			const shell = shellWindowIfCreated();
			if (!shell) {
				return RealBrowserWindow.getAllWindows();
			}
			const real = RealBrowserWindow.getAllWindows().filter(window => window !== shell.window);
			return [...real, ...shell.getViews().map(view => asBrowserWindow(view))];
		}

		static override fromWebContents(webContents: Electron.WebContents): Electron.BrowserWindow | null {
			const shell = shellWindowIfCreated();
			const view = shell?.getViewById(webContents.id);
			if (view) {
				return asBrowserWindow(view);
			}
			const window = RealBrowserWindow.fromWebContents(webContents);
			return window && window === shell?.window ? null : window;
		}

		static override fromId(id: number): Electron.BrowserWindow | null {
			const shell = shellWindowIfCreated();
			const view = shell?.getViewById(id);
			if (view) {
				return asBrowserWindow(view);
			}
			const window = RealBrowserWindow.fromId(id);
			return window && window === shell?.window ? null : window;
		}

		/**
		 * Focus lives on the shell window; which workbench is focused is the
		 * question of which view's contents hold it.
		 */
		static override getFocusedWindow(): Electron.BrowserWindow | null {
			const shell = shellWindowIfCreated();
			const window = RealBrowserWindow.getFocusedWindow();
			if (!shell || window !== shell.window) {
				return window;
			}
			const view = shell.getViews().find(candidate => candidate.webContents.isFocused());
			return view ? asBrowserWindow(view) : null;
		}
	}

	const descriptor = Object.getOwnPropertyDescriptor(electronModule, 'BrowserWindow');
	if (!descriptor?.configurable) {
		throw new Error(`cannot replace Electron.BrowserWindow: property is not configurable (${JSON.stringify(descriptor)})`);
	}
	Object.defineProperty(electronModule, 'BrowserWindow', {
		value: DevHubBrowserWindow,
		configurable: true,
		enumerable: descriptor.enumerable,
		writable: true
	});

	// Mint the ESM namespace now and prove that it — and therefore every
	// `import { BrowserWindow } from 'electron'` in VS Code — sees ours.
	const namespace = await import('electron');
	if (namespace.BrowserWindow !== DevHubBrowserWindow) {
		throw new Error('electron ESM named export BrowserWindow did not observe the DevHub replacement');
	}
	if (namespace.default.BrowserWindow !== DevHubBrowserWindow) {
		throw new Error('electron ESM default export BrowserWindow did not observe the DevHub replacement');
	}

	console.log('[devhub] BrowserWindow shim installed');
}
