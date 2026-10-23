/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: closes a workbench that has been off screen for
// `general.workbench_hibernate_minutes` (apps/desktop/src/main/shell/
// workbenchHibernation.ts), and asks it first what that would lose. This
// answers: unsaved editors, a process running in one of its terminals, a debug
// session. A DevHub terminal is a tmux session and survives, so it never counts.

import { devhubTerminalLauncher } from '../../../../base/common/platform.js';
import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { IDebugService, State } from '../../debug/common/debug.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';

class DevhubKeepAwake implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.devhubKeepAwake';

	constructor(
		@IWorkingCopyService workingCopyService: IWorkingCopyService,
		@ITerminalService terminalService: ITerminalService,
		@IDebugService debugService: IDebugService,
	) {
		ipcRenderer.on('vscode:devhubKeepAwake', (_event: unknown, ...args: unknown[]) => {
			const reasons = [
				...workingCopyService.modifiedWorkingCopies.map(workingCopy => workingCopy.name),
				...terminalService.instances
					.filter(terminal => !devhubTerminalLauncher || terminal.shellLaunchConfig.executable !== devhubTerminalLauncher)
					.filter(terminal => terminal.shellLaunchConfig.type === 'Task' ? terminal.exitCode === undefined : terminal.hasChildProcesses)
					.map(terminal => `terminal ${terminal.title}`),
				...(debugService.state === State.Inactive ? [] : ['debug session']),
			];
			ipcRenderer.send('vscode:devhubKeepAwakeReply', args[0], { reasons });
		});
	}
}

registerWorkbenchContribution2(DevhubKeepAwake.ID, DevhubKeepAwake, WorkbenchPhase.AfterRestored);
