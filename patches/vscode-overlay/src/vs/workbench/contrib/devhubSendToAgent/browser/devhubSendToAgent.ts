/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: "Send to Agent…" — the editor's selection, with its file, to one of
// this Workspace's AI Agents (docs/agent-gui.md, "Send the editor's selection
// to an Agent"). The command only reads the editor and hands what it read to
// DevHub (`IDevhubAgentSink`, which the electron-browser contribution
// implements over IPC); DevHub asks which Agent, shows it beside the editor
// and puts the reference and the text in its input box — never sending it.
//
// In the editor's context menu (always: an empty selection sends the file and
// the cursor's line), the Command Palette, and Cmd+Alt+K (Ctrl+Alt+K). DevHub
// Vim's visual mode reaches it with `devhubVim.run`, which runs a command with
// the visual selection on screen (docs/vim.md).

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { SEND_TO_AGENT_COMMAND_ID, SendToAgentPayload, sendToAgentPayload } from '../common/sendToAgentPayload.js';

export const IDevhubAgentSink = createDecorator<IDevhubAgentSink>('devhubAgentSink');

/** Where a payload goes: DevHub's main process, in the app. */
export interface IDevhubAgentSink {
	readonly _serviceBrand: undefined;
	send(payload: SendToAgentPayload): void;
}

export class SendToAgentAction extends Action2 {
	constructor() {
		super({
			id: SEND_TO_AGENT_COMMAND_ID,
			title: localize2('devhub.sendSelectionToAgent', "Send to Agent…"),
			category: localize2('devhub.category', "DevHub"),
			f1: true,
			// No precondition: from the Command Palette the editor has lost the
			// focus to the palette, and the command reads the active editor.
			menu: {
				id: MenuId.EditorContext,
				group: '0_devhub',
				order: 1,
			},
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				when: ContextKeyExpr.and(EditorContextKeys.editorTextFocus),
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyK,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyK },
			},
		});
	}

	run(accessor: ServicesAccessor): void {
		const codeEditorService = accessor.get(ICodeEditorService);
		const editor = codeEditorService.getFocusedCodeEditor() ?? codeEditorService.getActiveCodeEditor();
		if (!editor?.hasModel()) {
			accessor.get(INotificationService).info(localize('devhub.sendSelectionToAgent.noEditor', "Send to Agent: there is no text editor to send from."));
			return;
		}
		accessor.get(IDevhubAgentSink).send(sendToAgentPayload(editor.getModel(), editor.getSelections()));
	}
}
