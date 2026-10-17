/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../base/browser/window.js';
import { IMarkdownString } from '../../../../base/common/htmlContent.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { StatusBarHoverView } from '../../browser/devhubStatusBarHover.js';
import { IStatusBarHoverDto, StatusBarHoverCheckedState } from '../../common/devhubStatusBarHover.js';

suite('DevHub status bar hover view', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const markdown = {
		render: (value: IMarkdownString) => {
			const element = mainWindow.document.createElement('div');
			element.textContent = value.value;
			return { element, dispose: () => { } };
		},
	} as unknown as IMarkdownRendererService;

	function createView() {
		const runs: [number, StatusBarHoverCheckedState | undefined][] = [];
		let hidden = 0;
		const view = store.add(new StatusBarHoverView((handle, checked) => runs.push([handle, checked]), () => hidden++, markdown));
		mainWindow.document.body.appendChild(view.element);
		store.add({ dispose: () => view.element.remove() });
		return { view, runs, hidden: () => hidden };
	}

	const model: IStatusBarHoverDto = {
		items: [
			{ kind: 'header', label: 'Copilot', description: 'octocat', actions: [{ icon: 'gear', title: 'Settings', handle: 0 }] },
			{ kind: 'progress', label: 'Code completions', value: 42, valueLabel: '42%', description: 'used', detail: 'Resets Nov 1' },
			{ kind: 'progress', label: 'Starting', value: undefined },
			{
				kind: 'section', label: 'Suggestions', description: 'Python', items: [
					{ kind: 'checkbox', id: 'completions', label: 'Code completions', checked: true, triState: false, enabled: true, handle: 1 },
					{ kind: 'checkbox', id: 'language', label: 'for Python', checked: 'mixed', triState: true, enabled: true, handle: 2 },
					{ kind: 'checkbox', id: 'off', label: 'Unavailable', checked: false, triState: false, enabled: false, handle: 3 },
				]
			},
			{ kind: 'buttons', id: 'actions', buttons: [{ label: 'Sign Out', title: 'Sign Out', secondary: true, enabled: true, handle: 4 }] },
			{ kind: 'text', text: { value: '[Output](command:x.output)' }, muted: true },
		],
	};

	const labelOf = (view: StatusBarHoverView, text: string) =>
		[...view.element.querySelectorAll<HTMLElement>('.setting-label')].find(label => label.textContent === text)!;

	test('draws the items with the Copilot dashboard\'s classes', () => {
		const { view } = createView();
		view.render(model);

		assert.ok(view.element.classList.contains('chat-status-bar-entry-tooltip'));
		assert.strictEqual(view.element.querySelector('.header .devhub-hover-header-title')?.textContent, 'Copilot');
		const bars = view.element.querySelectorAll<HTMLElement>('.quota-indicator .quota-bar');
		assert.strictEqual(bars.length, 2);
		assert.strictEqual((bars[0].firstElementChild as HTMLElement).style.width, '42%');
		assert.strictEqual(bars[0].getAttribute('aria-valuenow'), '42');
		assert.strictEqual(view.element.querySelector('.quota-reset')?.textContent, 'Resets Nov 1');
		assert.ok(bars[1].classList.contains('indeterminate'));
		assert.strictEqual(view.element.querySelectorAll('.devhub-hover-section .settings .setting').length, 3);
		assert.strictEqual(view.element.querySelector('.devhub-hover-section .collapsible-status')?.textContent, 'Python');
		assert.strictEqual(view.element.querySelector('.devhub-hover-text.muted')?.textContent, '[Output](command:x.output)');
	});

	test('a checkbox runs its command with the state it moves to', () => {
		const { view, runs } = createView();
		view.render(model);

		labelOf(view, 'Code completions').click();
		labelOf(view, 'for Python').click();
		labelOf(view, 'for Python').click();
		labelOf(view, 'Unavailable').click();
		(labelOf(view, 'for Python').previousElementSibling as HTMLElement).click();
		assert.deepStrictEqual(runs, [[1, false], [2, true], [2, false], [2, 'mixed']]);
	});

	test('a button runs its command and closes the hover', () => {
		const { view, runs, hidden } = createView();
		view.render(model);

		view.element.querySelector<HTMLElement>('.devhub-hover-buttons .monaco-button')!.click();
		assert.deepStrictEqual(runs, [[4, undefined]]);
		assert.strictEqual(hidden(), 1);
	});

	test('a redraw keeps focus on the control that had it', () => {
		const { view } = createView();
		view.render(model);

		const language = () => labelOf(view, 'for Python').previousElementSibling as HTMLElement;
		const before = language();
		before.focus();
		view.render(model);
		assert.notStrictEqual(language(), before);
		assert.strictEqual(mainWindow.document.activeElement, language());
	});
});
