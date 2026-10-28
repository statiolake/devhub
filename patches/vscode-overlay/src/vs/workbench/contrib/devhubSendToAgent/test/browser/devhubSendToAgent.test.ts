/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: "Send to Agent…" — where it is offered, and what it hands DevHub.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { withTestCodeEditor } from '../../../../../editor/test/browser/testCodeEditor.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { ServiceIdentifier, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IDevhubAgentSink, SendToAgentAction } from '../../browser/devhubSendToAgent.js';
import { SEND_TO_AGENT_CHANNEL, SEND_TO_AGENT_COMMAND_ID, SendToAgentPayload } from '../../common/sendToAgentPayload.js';

class RecordingSink implements IDevhubAgentSink {
	declare readonly _serviceBrand: undefined;
	readonly sent: SendToAgentPayload[] = [];
	send(payload: SendToAgentPayload): void {
		this.sent.push(payload);
	}
}

/** The three services the command reads, and the editor that has the focus. */
function accessorOf(sink: IDevhubAgentSink, notifications: INotificationService, focused: ICodeEditor | null): ServicesAccessor {
	const codeEditors: Pick<ICodeEditorService, 'getFocusedCodeEditor' | 'getActiveCodeEditor'> = {
		getFocusedCodeEditor: () => focused,
		getActiveCodeEditor: () => null,
	};
	const services = new Map<unknown, unknown>([[IDevhubAgentSink, sink], [INotificationService, notifications], [ICodeEditorService, codeEditors]]);
	return {
		get: <T>(id: ServiceIdentifier<T>): T => {
			if (!services.has(id)) {
				throw new Error(`the command asked for ${id.toString()}`);
			}
			return services.get(id) as T;
		},
	};
}

suite('DevHub: Send to Agent', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('is a command in the editor context menu, the Command Palette and on Cmd+Alt+K, under DevHub', () => {
		const { desc } = new SendToAgentAction();
		assert.strictEqual(desc.id, SEND_TO_AGENT_COMMAND_ID);
		assert.strictEqual(SEND_TO_AGENT_COMMAND_ID, 'devhub.sendSelectionToAgent');
		assert.strictEqual(SEND_TO_AGENT_CHANNEL, 'vscode:devhubSendToAgent');
		assert.strictEqual(desc.f1, true);
		assert.strictEqual(typeof desc.title === 'string' ? desc.title : desc.title.value, 'Send to Agent…');
		const menus = Array.isArray(desc.menu) ? desc.menu : [desc.menu];
		assert.deepStrictEqual(menus.map(menu => menu?.id), [MenuId.EditorContext]);
		// Offered with no selection too: that sends the file and the cursor's line.
		assert.strictEqual(menus[0]?.when, undefined);
		assert.strictEqual(desc.precondition, undefined);
		const keybindings = Array.isArray(desc.keybinding) ? desc.keybinding : [desc.keybinding];
		assert.strictEqual(keybindings.length, 1);
	});

	test('hands DevHub the file, its language and every selection', () => {
		const uri = URI.file('/Users/me/app/src/a.ts');
		const model = disposables.add(createTextModel('one\ntwo\nthree\nfour\n', null, undefined, uri));
		withTestCodeEditor(model, {}, editor => {
			editor.setSelections([new Selection(3, 1, 4, 5), new Selection(1, 2, 1, 2)]);
			const sink = new RecordingSink();
			new SendToAgentAction().run(accessorOf(sink, new TestNotificationService(), editor));
			assert.deepStrictEqual(sink.sent, [{
				version: 1,
				uri: uri.toString(),
				path: '/Users/me/app/src/a.ts',
				languageId: model.getLanguageId(),
				ranges: [
					{ startLine: 1, endLine: 1, text: '' },
					{ startLine: 3, endLine: 4, text: 'three\nfour' },
				],
			}]);
		});
	});

	test('with no text editor, says so and hands DevHub nothing', () => {
		const model = disposables.add(createTextModel('one'));
		withTestCodeEditor(model, {}, () => {
			const sink = new RecordingSink();
			const notifications = new TestNotificationService();
			let told = 0;
			notifications.info = () => {
				told++;
				return undefined!;
			};
			new SendToAgentAction().run(accessorOf(sink, notifications, null));
			assert.deepStrictEqual(sink.sent, []);
			assert.strictEqual(told, 1);
		});
	});
});
