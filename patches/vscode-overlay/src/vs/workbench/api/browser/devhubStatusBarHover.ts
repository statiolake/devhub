/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: draws the `devhubStatusBarHover` proposal
// (patches/vscode/0009-devhub-status-bar-hover.patch).
//
// The Copilot status dashboard (contrib/chat/browser/chatStatus) is made of a
// header with an action bar, quota meters, checkboxes and buttons inside
// `.chat-status-bar-entry-tooltip`. This draws a declarative description of
// the same pieces with the same widgets and the same stylesheet, so an
// extension's hover looks and behaves like that one (pinned on click, focus
// inside, Tab between the controls) without depending on chat or on its
// entitlements. Only what that stylesheet has no rule for is in
// media/devhubStatusBarHover.css.

import '../../contrib/chat/browser/chatStatus/media/chatStatus.css';
import './media/devhubStatusBarHover.css';
import { $, addDisposableListener, append, clearNode, disposableWindowInterval, EventHelper, EventType, getActiveElement, getWindow, isHTMLElement } from '../../../base/browser/dom.js';
import { Gesture, EventType as TouchEventType } from '../../../base/browser/touch.js';
import { ActionBar } from '../../../base/browser/ui/actionbar/actionbar.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { IManagedHoverTooltipHTMLElement } from '../../../base/browser/ui/hover/hover.js';
import { renderLabelWithIcons } from '../../../base/browser/ui/iconLabel/iconLabels.js';
import { Checkbox, TriStateCheckbox } from '../../../base/browser/ui/toggle/toggle.js';
import { toAction } from '../../../base/common/actions.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { IHoverService, nativeHoverDelegate } from '../../../platform/hover/browser/hover.js';
import { IMarkdownRendererService } from '../../../platform/markdown/browser/markdownRenderer.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { defaultButtonStyles, defaultCheckboxStyles } from '../../../platform/theme/browser/defaultStyles.js';
import { IStatusBarHoverButtonsDto, IStatusBarHoverCheckboxDto, IStatusBarHoverDto, IStatusBarHoverHeaderDto, IStatusBarHoverProgressDto, IStatusBarHoverTextDto, nextCheckedState, StatusBarHoverCheckedState, StatusBarHoverItemDto } from '../common/devhubStatusBarHover.js';

export type StatusBarHoverRunner = (handle: number, checked: StatusBarHoverCheckedState | undefined) => Promise<void>;

const KEY_ATTRIBUTE = 'data-devhub-hover-key';

/**
 * One status bar entry's hover: the latest model and the tooltip the entry
 * shows. The tooltip object stays the same across updates, so the status bar
 * keeps an open hover open; each open copy redraws itself on `update`.
 */
export class StatusBarHoverHost extends Disposable {

	private model: IStatusBarHoverDto = { items: [] };
	private readonly onDidUpdate = this._register(new Emitter<void>());
	private readonly openViews = new Set<DisposableStore>();

	readonly tooltip: IManagedHoverTooltipHTMLElement = {
		element: (token: CancellationToken) => this.open(token),
	};

	constructor(
		private readonly run: StatusBarHoverRunner,
		@IHoverService private readonly hoverService: IHoverService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
	}

	update(model: IStatusBarHoverDto): void {
		this.model = model;
		this.onDidUpdate.fire();
	}

	private open(token: CancellationToken): HTMLElement {
		const store = new DisposableStore();
		this.openViews.add(store);
		store.add(toDisposable(() => this.openViews.delete(store)));
		store.add(token.onCancellationRequested(() => store.dispose()));

		const view = store.add(new StatusBarHoverView(
			(handle, checked) => this.runAndReport(handle, checked),
			() => this.hoverService.hideHover(true),
			this.markdownRendererService,
		));
		view.render(this.model);
		store.add(this.onDidUpdate.event(() => view.render(this.model)));

		// As the Copilot dashboard does: the hover is not always disposed when
		// its element is removed (microsoft/vscode#257923).
		store.add(disposableWindowInterval(getWindow(view.element), () => {
			if (!view.element.isConnected) {
				store.dispose();
			}
		}, 2000));

		return view.element;
	}

	override dispose(): void {
		for (const store of [...this.openViews]) {
			store.dispose();
		}
		super.dispose();
	}

	private async runAndReport(handle: number, checked: StatusBarHoverCheckedState | undefined): Promise<void> {
		try {
			await this.run(handle, checked);
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		}
	}
}

/** The hover's DOM, redrawn whole on every update with focus carried over. */
export class StatusBarHoverView extends Disposable {

	readonly element = $('div.chat-status-bar-entry-tooltip.devhub-status-bar-hover');
	private readonly content = this._register(new DisposableStore());

	constructor(
		private readonly run: (handle: number, checked: StatusBarHoverCheckedState | undefined) => void,
		private readonly hide: () => void,
		private readonly markdownRendererService: IMarkdownRendererService,
	) {
		super();
	}

	render(model: IStatusBarHoverDto): void {
		const active = getActiveElement();
		const focusedKey = isHTMLElement(active) && this.element.contains(active)
			? active.closest(`[${KEY_ATTRIBUTE}]`)?.getAttribute(KEY_ATTRIBUTE) ?? undefined
			: undefined;

		this.content.clear();
		clearNode(this.element);
		this.renderItems(this.element, model.items, '');

		if (focusedKey !== undefined) {
			for (const candidate of this.element.querySelectorAll<HTMLElement>(`[${KEY_ATTRIBUTE}]`)) {
				if (candidate.getAttribute(KEY_ATTRIBUTE) === focusedKey) {
					candidate.focus();
					break;
				}
			}
		}
	}

	private renderItems(container: HTMLElement, items: readonly StatusBarHoverItemDto[], keyPrefix: string): void {
		let settings: HTMLElement | undefined; // consecutive checkboxes share one `.settings` column
		items.forEach((item, index) => {
			const key = `${keyPrefix}${item.id ?? `#${index}`}`;
			if (item.kind !== 'checkbox') {
				settings = undefined;
			}
			switch (item.kind) {
				case 'header': this.renderHeader(container, item, key); break;
				case 'text': this.renderText(container, item); break;
				case 'progress': this.renderProgress(container, item); break;
				case 'checkbox':
					settings ??= append(container, $('div.settings'));
					this.renderCheckbox(settings, item, key);
					break;
				case 'buttons': this.renderButtons(container, item, key); break;
				case 'separator': append(container, $('hr')); break;
				case 'section': {
					const section = append(container, $('div.devhub-hover-section'));
					const header = append(section, $('div.collapsible-header.non-collapsible'));
					append(header, $('span.collapsible-label')).append(...renderLabelWithIcons(item.label));
					if (item.description) {
						append(header, $('span.collapsible-status')).append(...renderLabelWithIcons(item.description));
					}
					this.renderItems(append(section, $('div.devhub-hover-section-body')), item.items, `${key}/`);
					break;
				}
			}
		});
	}

	private renderHeader(container: HTMLElement, item: IStatusBarHoverHeaderDto, key: string): void {
		const header = append(container, $('div.header.devhub-hover-header'));
		const labels = append(header, $('div.header-label'));
		append(labels, $('div.devhub-hover-header-title')).append(...renderLabelWithIcons(item.label));
		if (item.description) {
			append(labels, $('div.description.devhub-hover-header-description')).append(...renderLabelWithIcons(item.description));
		}
		if (item.actions.length > 0) {
			const toolbar = this.content.add(new ActionBar(header, { hoverDelegate: nativeHoverDelegate }));
			toolbar.push(item.actions.map((action, index) => toAction({
				id: `devhub.statusBarHover.${key}.${index}`,
				label: action.title,
				tooltip: action.title,
				class: ThemeIcon.asClassName({ id: action.icon }),
				run: () => this.runAndHide(action.handle),
			})), { icon: true, label: false });
		}
	}

	private renderText(container: HTMLElement, item: IStatusBarHoverTextDto): void {
		const text = append(container, $('div.devhub-hover-text'));
		text.classList.toggle('muted', item.muted);
		if (typeof item.text === 'string') {
			text.append(...renderLabelWithIcons(item.text));
		} else {
			text.appendChild(this.content.add(this.markdownRendererService.render(item.text)).element);
		}
	}

	private renderProgress(container: HTMLElement, item: IStatusBarHoverProgressDto): void {
		const bit = $('div.quota-bit');
		const bar = $('div.quota-bar', { role: 'progressbar', 'aria-label': item.label }, bit);
		if (item.value === undefined) {
			bar.classList.add('indeterminate');
		} else {
			bit.style.width = `${item.value}%`;
			bar.setAttribute('aria-valuemin', '0');
			bar.setAttribute('aria-valuemax', '100');
			bar.setAttribute('aria-valuenow', String(Math.round(item.value)));
			if (item.valueLabel) {
				bar.setAttribute('aria-valuetext', [item.valueLabel, item.description, item.detail].filter(Boolean).join(' '));
			}
		}

		const title = $('div.quota-title', undefined, $('span', undefined, ...renderLabelWithIcons(item.label)));
		if (item.detail) {
			title.appendChild($('span.quota-reset', undefined, item.detail));
		}
		const indicator = append(container, $('div.quota-indicator.devhub-hover-progress', undefined, title));
		if (item.valueLabel || item.description) {
			indicator.appendChild($('div.quota-details', undefined,
				$('div.quota-percentage', undefined,
					$('span.quota-value', undefined, item.valueLabel ?? ''),
					$('span.quota-value-suffix', undefined, item.description ?? ''),
				),
			));
		}
		indicator.appendChild(bar);
	}

	private renderCheckbox(container: HTMLElement, item: IStatusBarHoverCheckboxDto, key: string): void {
		const setting = append(container, $('div.setting'));
		let state: StatusBarHoverCheckedState = item.checked;
		const checkbox = item.triState
			? this.content.add(new TriStateCheckbox(item.label, state, { ...defaultCheckboxStyles }))
			: this.content.add(new Checkbox(item.label, state === true, { ...defaultCheckboxStyles }));
		setting.appendChild(checkbox.domNode);
		checkbox.domNode.setAttribute(KEY_ATTRIBUTE, key);
		const label = append(setting, $('span.setting-label', undefined, ...renderLabelWithIcons(item.label)));
		if (item.description) {
			append(setting, $('span.setting-overridden', undefined, item.description));
		}

		const show = (next: StatusBarHoverCheckedState) => {
			state = next;
			if (checkbox instanceof TriStateCheckbox) {
				checkbox.checked = next;
			} else {
				checkbox.checked = next === true;
			}
			checkbox.domNode.setAttribute('aria-checked', String(next));
		};
		const change = () => {
			const next = nextCheckedState(state, item.triState);
			show(next);
			this.run(item.handle, next);
		};
		show(state);

		// The checkbox has already flipped itself when it fires; the state it
		// moves to is decided here, so a tri-state one cycles like the label.
		this.content.add(checkbox.onChange(() => {
			show(state);
			change();
		}));
		this.content.add(Gesture.addTarget(label));
		for (const eventType of [EventType.CLICK, TouchEventType.Tap]) {
			this.content.add(addDisposableListener(label, eventType, e => {
				if (checkbox.enabled) {
					EventHelper.stop(e, true);
					change();
					checkbox.focus();
				}
			}));
		}

		if (!item.enabled) {
			setting.classList.add('disabled');
			checkbox.disable();
		}
	}

	private renderButtons(container: HTMLElement, item: IStatusBarHoverButtonsDto, key: string): void {
		const row = append(container, $('div.devhub-hover-buttons'));
		item.buttons.forEach((spec, index) => {
			const button = this.content.add(new Button(row, {
				...defaultButtonStyles,
				secondary: spec.secondary,
				supportIcons: true,
				hoverDelegate: nativeHoverDelegate,
				title: spec.title || undefined,
				disabled: !spec.enabled,
			}));
			button.label = spec.label;
			button.element.setAttribute(KEY_ATTRIBUTE, `${key}:${index}`);
			this.content.add(button.onDidClick(() => this.runAndHide(spec.handle)));
		});
	}

	/**
	 * A button or an action is done with the hover, as in the Copilot
	 * dashboard; a checkbox is not, so several can be changed in a row.
	 */
	private runAndHide(handle: number): void {
		this.run(handle, undefined);
		this.hide();
	}
}
