/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: `:js {code}`, `:js ={expr}`, `:[range]jsdo {body}`
// (vimEngine.ts exJs), as Neovim's `:lua`, `:lua =`, `:luado`. The engine runs
// the internal command here:
//
//   _devhubVim.js { kind: exec | eval | do, code, from, mode, registers, lines?, firstLine? }
//       -> { value?, output?, lines?, registers, error? }
//
// which hands it to the built-in extension devhub-vim-js
// (extensions/devhub-vim-js, extensionKind "ui": the local extension host, in
// a remote window too) with the full `vscode` API and the helpers `editor`,
// `doc`, `sel`, `vim` (see its run.js). JavaScript is code: in a workspace
// that is not trusted (Workspace Trust) it does not run at all, here (E12) and
// in the extension (untrustedWorkspaces: false). `:` lines can come from the
// user only: devhub.vim.exCommands is never read from a workspace.

import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';

export const VIM_JS_COMMANDS = ['_devhubVim.js'] as const;

/** What `:js` / `:jsdo` answer. */
export interface VimJsResult {
	readonly value?: string;
	/** The value was written to the "Vim :js" output channel (it has several lines). */
	readonly output?: boolean;
	readonly lines?: readonly (string | null)[];
	readonly registers: Readonly<Record<string, { readonly text: string; readonly type: 'char' | 'line' | 'block' }>>;
	readonly error?: string;
}

export const UNTRUSTED_MESSAGE = 'E12: Command not allowed in an untrusted workspace (Workspace Trust): :js, :jsdo';

export class VimJsCommands {

	constructor(
		@IWorkspaceTrustManagementService private readonly trustService: IWorkspaceTrustManagementService,
		@ICommandService private readonly commandService: ICommandService,
	) { }

	async run(args: unknown): Promise<VimJsResult> {
		if (!this.trustService.isWorkspaceTrusted()) {
			throw new Error(UNTRUSTED_MESSAGE);
		}
		const a = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {};
		const result = await this.commandService.executeCommand<VimJsResult>('_devhubVim.js.run', {
			kind: a.kind, code: a.code, uri: typeof a.from === 'string' ? a.from : undefined,
			mode: a.mode, registers: a.registers, lines: a.lines, firstLine: a.firstLine,
		});
		if (!result || typeof result !== 'object') {
			throw new Error(localize('devhubVim.js.noExtension', "The :js extension (devhub-vim-js) does not run here"));
		}
		return result;
	}
}

CommandsRegistry.registerCommand('_devhubVim.js', (accessor, args: unknown) => accessor.get(IInstantiationService).createInstance(VimJsCommands).run(args));
