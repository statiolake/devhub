/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: closing a comment widget (a Vim floating window, browser/vimWindows.ts)
// leaves the keyboard focus in its editor, on the thread's line, in normal
// mode — with VS Code's own review zone widget, its comment inputs and a real
// editor with a view, so the widget's hide and dispose run as in the workbench.
//
// The test window has no OS focus, as a DevHub workbench that does not have
// the keyboard: an editor's focus tracker gets no blur there, so the editor a
// comment input is in still says it has the text focus once the input has
// it. The keys are the input's all the same (DevhubVim.focused).

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import { Comment, CommentMode, CommentThreadCollapsibleState } from '../../../../../editor/common/languages.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IUserInteractionService } from '../../../../../platform/userInteraction/browser/userInteractionService.js';
import { UserInteractionService } from '../../../../../platform/userInteraction/browser/userInteractionServiceImpl.js';
import { MainThreadCommentThread } from '../../../../api/browser/mainThreadComments.js';
import { IStatusbarEntryAccessor, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { CommentMenus } from '../../../comments/browser/commentMenus.js';
import { ICommentService } from '../../../comments/browser/commentService.js';
import { CommentWidgetFocus, ReviewZoneWidget } from '../../../comments/browser/commentThreadZoneWidget.js';
import { DevhubVim } from '../../browser/devhubVim.contribution.js';
import { VimCmdline } from '../../browser/vimCmdline.js';

/** How the float is closed: an ex command on the prompt, a key's ex command (ZZ ZQ), or a CTRL-W command. */
type Close = { readonly kind: 'ex' | 'key' | 'nav'; readonly arg: string };

const CLOSES: readonly [string, Close][] = [
	[':q', { kind: 'ex', arg: 'q' }], [':close', { kind: 'ex', arg: 'close' }], [':wq', { kind: 'ex', arg: 'wq' }], [':x', { kind: 'ex', arg: 'x' }], [':q!', { kind: 'ex', arg: 'q!' }],
	['ZZ', { kind: 'key', arg: 'x' }], ['ZQ', { kind: 'key', arg: 'q!' }],
	['<C-w>c', { kind: 'nav', arg: 'devhubVim.nav.close' }], ['<C-w>q', { kind: 'nav', arg: 'devhubVim.nav.quit' }],
];

/** The widget states: an empty new thread (dropped), a reply draft (folded), a comment being edited (folded), a new thread with text (stays open, except :q! ZQ). */
type State = 'empty new thread' | 'reply draft' | 'edit' | 'typed new thread';
const STATES: readonly State[] = ['empty new thread', 'reply draft', 'edit', 'typed new thread'];

suite('DevHub Vim: closing a comment widget leaves the focus in its editor', () => {

	// No leak check (ensureNoDisposablesAreLeakedInTestSuite) here: VS Code's
	// CommentThreadHeader leaks its Collapse action (an ActionBar does not dispose
	// the actions pushed into it), and only VS Code can dispose it.
	const store = new DisposableStore();
	teardown(() => store.clear());

	async function withEditor(fn: (env: { editor: ICodeEditor; open: (state: State) => Promise<{ zone: ReviewZoneWidget; thread: MainThreadCommentThread<IRange>; input: ICodeEditor }>; ran: string[]; mode: () => unknown; run: (close: Close) => Promise<void> }) => Promise<void>): Promise<void> {
		const disposables = store.add(new DisposableStore());
		const container = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		disposables.add({ dispose: () => container.remove() });
		const inst = workbenchInstantiationService(undefined, disposables);
		const configuration = inst.get(IConfigurationService) as TestConfigurationService;
		await configuration.setUserConfiguration('devhub.vim.enabled', true);
		inst.stub(IContextKeyService, disposables.add(new ContextKeyService(configuration)));
		inst.stub(IUserInteractionService, new UserInteractionService());
		inst.stub(IStatusbarService, new class extends mock<IStatusbarService>() { override addEntry(): IStatusbarEntryAccessor { return { update() { }, dispose() { } }; } });
		// the comment inputs' models (VS Code's CommentsInputContentProvider)
		const models = inst.get(IModelService);
		disposables.add(inst.get(ITextModelService).registerTextModelContentProvider('comment', { provideTextContent: async uri => models.getModel(uri) ?? models.createModel('', null, uri) }));
		const menus = new CommentMenus(inst.get(IMenuService));
		inst.stub(ICommentService, new class extends mock<ICommentService>() {
			override readonly onDidUpdateCommentThreads = Event.None;
			override getCommentController() { return undefined; }
			override getCommentMenus() { return menus; }
			override async setActiveCommentAndThread() { }
			override setActiveEditingCommentThread() { }
			override setCurrentCommentThread() { }
			override async disposeCommentThread() { }
			override hasReactionHandler() { return false; }
			override async updateCommentThreadTemplate() { }
		});
		// what reaches VS Code: a comment input never saves or closes the file
		const ran: string[] = [];
		inst.stub(ICommandService, new class extends mock<ICommandService>() {
			override async executeCommand<R>(id: string, ...args: unknown[]): Promise<R | undefined> {
				ran.push(id);
				const command = CommandsRegistry.getCommand(id);
				return command ? inst.invokeFunction(a => command.handler(a, ...args)) as R : undefined;
			}
		});
		const vim = disposables.add(inst.createInstance(DevhubVim));
		const editor = disposables.add(inst.createInstance(CodeEditorWidget, container, {}, { contributions: [] }));
		const model = disposables.add(createTextModel(Array.from({ length: 30 }, (_, i) => `    line ${i + 1}`).join('\n')));
		editor.setModel(model);
		editor.layout({ width: 800, height: 600 });
		const settle = () => new Promise<void>(resolve => setTimeout(resolve, 10));
		const open = async (state: State) => {
			const comments: Comment[] | undefined = state === 'reply draft' ? [{ body: 'a', uniqueIdInThread: 1, userName: 'u' }]
				: state === 'edit' ? [{ body: 'a', uniqueIdInThread: 1, userName: 'u', mode: CommentMode.Editing }] : undefined;
			const isNew = !comments;
			const thread = new MainThreadCommentThread<IRange>(1, 1, 'ext', `thread-${state}`, model.uri.toString(), { startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 1 }, comments, true, isNew);
			disposables.add(thread);
			thread.collapsibleState = CommentThreadCollapsibleState.Expanded;
			// the editor had the focus, its cursor elsewhere, in insert mode: Add Comment from there
			editor.focus();
			editor.setPosition({ lineNumber: 20, column: 1 });
			vim.update();
			vim.execute('devhubVim.mode', { to: 'insert' });
			const zone = inst.createInstance(ReviewZoneWidget, editor, 'owner', thread, undefined, undefined);
			disposables.add(zone);
			await zone.display(thread.range, true);
			await settle();
			const inputs = inst.get(ICodeEditorService).listCodeEditors().filter(e => zone.domNode.contains(e.getContainerDomNode()));
			const input = state === 'edit' ? inputs.find(e => e.getContainerDomNode().closest('.review-comment'))! : inputs.find(e => !e.getContainerDomNode().closest('.review-comment'))!;
			if (state === 'reply draft' || state === 'typed new thread') {
				input.setValue('draft');
			}
			if (state === 'edit') {
				input.focus();
			} else {
				zone.reveal(undefined, CommentWidgetFocus.Editor);
			}
			vim.update();
			return { zone, thread, input };
		};
		const run = async (close: Close) => {
			if (close.kind === 'ex') {
				vim.execute('devhubVim.cmdline', { kind: ':' });
				VimCmdline.current!.lineEditor(mainWindow)!.trigger('keyboard', 'type', { text: close.arg });
				await inst.invokeFunction(a => CommandsRegistry.getCommand('devhubVim.cmdline.submit')!.handler(a));
			} else if (close.kind === 'key') {
				vim.execute('devhubVim.ex', { command: close.arg });
			} else {
				vim.enterNav();
				await inst.invokeFunction(a => CommandsRegistry.getCommand(close.arg)!.handler(a));
			}
			await settle();
			vim.update();
		};
		const contextKeys = inst.get(IContextKeyService);
		await fn({ editor, open, ran, mode: () => contextKeys.getContextKeyValue('devhubVim.mode'), run });
		disposables.dispose();
	}

	for (const [name, close] of CLOSES) {
		test(`${name}: in the editor, on the thread's line, in normal mode, whatever the widget holds`, () => withEditor(async ({ editor, open, ran, mode, run }) => {
			for (const state of STATES) {
				const { zone, thread, input } = await open(state);
				assert.ok(input.getContainerDomNode().contains(mainWindow.document.activeElement), `${state}: the input has the focus`);
				ran.length = 0;
				await run(close);
				const active = mainWindow.document.activeElement;
				if (name === ':wq' && state === 'empty new thread') {
					// nothing to submit: the write fails (EMPTY_COMMENT) and its :q does not run, as Vim's :wq that cannot write
					assert.ok(input.getContainerDomNode().contains(active), `${name}, ${state}: the focus stays in the input`);
					assert.strictEqual(thread.collapsibleState, CommentThreadCollapsibleState.Expanded);
					zone.dispose();
					continue;
				}
				assert.ok(active && editor.getContainerDomNode().contains(active) && !zone.domNode.contains(active), `${name}, ${state}: the focus is in the editor (${active?.className})`);
				assert.strictEqual(editor.getPosition()?.lineNumber, 5, `${name}, ${state}: on the thread's line`);
				assert.strictEqual(editor.getPosition()?.column, 5, `${name}, ${state}: on its first non-blank`);
				assert.strictEqual(mode(), 'normal', `${name}, ${state}: normal mode`);
				assert.deepStrictEqual(ran.filter(id => id === 'workbench.action.closeActiveEditor' || id === 'workbench.action.files.save' || id === 'workbench.action.revertAndCloseActiveEditor'), [], `${name}, ${state}: the file is not saved or closed`);
				const discard = name === ':q!' || name === 'ZQ';
				// a typed new thread stays open (VS Code keeps no folded new thread; one written is folded once the extension gives it its comment)
				const stays = state === 'typed new thread' && !discard;
				assert.strictEqual(thread.collapsibleState === CommentThreadCollapsibleState.Expanded, stays, `${name}, ${state}: the widget is ${stays ? 'open' : 'closed'}`);
				zone.dispose();
			}
		}));
	}
});
