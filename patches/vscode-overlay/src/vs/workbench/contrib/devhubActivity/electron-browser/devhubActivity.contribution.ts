/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: freezes a workbench that is not on screen (SIGSTOP on its renderer,
// extension hosts and their children) and later discards it (apps/desktop/src/
// main/shell/workbenchPlan.ts). Main asks this first what that would
// interrupt, and whether the workbench has finished starting:
//
// - `busy`: a debug session, a running task, an integrated terminal with a
//   program in front of its shell. A DevHub terminal is tmux and never counts:
//   it runs under the shared pty host, which is never stopped.
// - `unsaved`: unsaved editors, only with hot exit off (else the QUIT unload
//   that discards backs them up and reopening restores them).
// - `ready`: the window has restored (phase Eventually) and the installed
//   extensions are registered.
//
// Asked of a hidden workbench, it is also the moment to give back the
// TextMate worker before the freeze (../browser/hiddenTokenizerWorker.ts).

import { addDisposableListener } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { timeout } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { devhubTerminalLauncher } from '../../../../base/common/platform.js';
import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IFilesConfigurationService } from '../../../services/filesConfiguration/common/filesConfigurationService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ITextMateTokenizationService } from '../../../services/textMate/browser/textMateTokenizationFeature.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { IDebugService, State } from '../../debug/common/debug.js';
import { ITaskService } from '../../tasks/common/taskService.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { HiddenTokenizerWorker, PageVisibility } from '../browser/hiddenTokenizerWorker.js';

/**
 * A worker ended before the reply is given this long to go — its thread
 * frees the heap as it ends — before main may stop the renderer.
 */
const WORKER_END_MS = 100;

/** What a freeze would interrupt; asked only of a restored window. */
async function busyOf(accessor: ServicesAccessor): Promise<string[]> {
	const debugService = accessor.get(IDebugService);
	const terminalService = accessor.get(ITerminalService);
	const tasks = await accessor.get(ITaskService).getActiveTasks().catch(() => []);
	return [
		...(debugService.state === State.Inactive ? [] : ['debug session']),
		...tasks.map(task => `task ${task._label}`),
		...terminalService.instances
			.filter(terminal => !devhubTerminalLauncher || terminal.shellLaunchConfig.executable !== devhubTerminalLauncher)
			.filter(terminal => terminal.shellLaunchConfig.type !== 'Task' && terminal.hasChildProcesses)
			.map(terminal => `terminal ${terminal.title}`),
	];
}

function unsavedOf(accessor: ServicesAccessor): string[] {
	return accessor.get(IFilesConfigurationService).isHotExitEnabled
		? []
		: accessor.get(IWorkingCopyService).modifiedWorkingCopies.map(workingCopy => workingCopy.name);
}

class DevhubActivity extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.devhubActivity';

	private extensionsRegistered = false;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IExtensionService extensionService: IExtensionService,
		@ITextMateTokenizationService textMateService: ITextMateTokenizationService,
	) {
		super();
		const onDidChangeVisibility = this._register(new Emitter<void>());
		this._register(addDisposableListener(mainWindow.document, 'visibilitychange', () => onDidChangeVisibility.fire()));
		const page: PageVisibility = {
			get hidden() { return mainWindow.document.visibilityState === 'hidden'; },
			onDidChange: onDidChangeVisibility.event,
		};
		const tokenizerWorker = this._register(new HiddenTokenizerWorker(textMateService, page));
		extensionService.whenInstalledExtensionsRegistered().then(() => this.extensionsRegistered = true);
		ipcRenderer.on('vscode:devhubActivity', async (_event: unknown, ...args: unknown[]) => {
			// Until its window has restored, a workbench is starting: nothing of
			// it is resolved for the asking, and it is not ready.
			const restored = lifecycleService.phase >= LifecyclePhase.Restored;
			const busy = restored ? await instantiationService.invokeFunction(busyOf) : [];
			const unsaved = restored ? instantiationService.invokeFunction(unsavedOf) : [];
			const ready = lifecycleService.phase >= LifecyclePhase.Eventually && this.extensionsRegistered;
			if (ready && tokenizerWorker.beforeFreeze()) {
				await timeout(WORKER_END_MS);
			}
			ipcRenderer.send('vscode:devhubActivityReply', args[0], { busy, unsaved, ready });
		});
	}
}

// At startup, so that a starting workbench answers (`ready: false`) while it
// settles: main waits on that answer before it starts the next one.
registerWorkbenchContribution2(DevhubActivity.ID, DevhubActivity, WorkbenchPhase.BlockStartup);
