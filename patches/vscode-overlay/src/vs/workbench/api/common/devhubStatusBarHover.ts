/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: the `devhubStatusBarHover` proposal's wire format
// (patches/vscode/0009-devhub-status-bar-hover.patch).
//
// The extension host turns a `StatusBarHover` into this DTO: commands stay in
// the extension host and cross as handles, so a checkbox can run its command
// with the new state appended without the commands converter, and arguments
// never have to be serialisable. The renderer is
// `../browser/devhubStatusBarHover.ts`.

import type * as vscode from 'vscode';
import type { IMarkdownString } from '../../../base/common/htmlContent.js';

export type StatusBarHoverCheckedState = boolean | 'mixed';

interface IItemDto {
	readonly id?: string;
}

export interface IStatusBarHoverHeaderDto extends IItemDto {
	readonly kind: 'header';
	readonly label: string;
	readonly description?: string;
	readonly actions: readonly { readonly icon: string; readonly title: string; readonly handle: number }[];
}

export interface IStatusBarHoverTextDto extends IItemDto {
	readonly kind: 'text';
	readonly text: string | IMarkdownString;
	readonly muted: boolean;
}

export interface IStatusBarHoverProgressDto extends IItemDto {
	readonly kind: 'progress';
	readonly label: string;
	/** 0 to 100, or undefined for an indeterminate bar. */
	readonly value: number | undefined;
	readonly valueLabel?: string;
	readonly description?: string;
	readonly detail?: string;
}

export interface IStatusBarHoverCheckboxDto extends IItemDto {
	readonly kind: 'checkbox';
	readonly label: string;
	readonly checked: StatusBarHoverCheckedState;
	readonly triState: boolean;
	readonly enabled: boolean;
	readonly description?: string;
	readonly handle: number;
}

export interface IStatusBarHoverButtonsDto extends IItemDto {
	readonly kind: 'buttons';
	readonly buttons: readonly { readonly label: string; readonly title: string; readonly secondary: boolean; readonly enabled: boolean; readonly handle: number }[];
}

export interface IStatusBarHoverSeparatorDto extends IItemDto {
	readonly kind: 'separator';
}

export interface IStatusBarHoverSectionDto extends IItemDto {
	readonly kind: 'section';
	readonly label: string;
	readonly description?: string;
	readonly items: readonly StatusBarHoverLeafDto[];
}

export type StatusBarHoverLeafDto =
	| IStatusBarHoverHeaderDto
	| IStatusBarHoverTextDto
	| IStatusBarHoverProgressDto
	| IStatusBarHoverCheckboxDto
	| IStatusBarHoverButtonsDto
	| IStatusBarHoverSeparatorDto;

export type StatusBarHoverItemDto = StatusBarHoverLeafDto | IStatusBarHoverSectionDto;

export interface IStatusBarHoverDto {
	readonly items: readonly StatusBarHoverItemDto[];
}

/**
 * The state a checkbox moves to when it is clicked: a two-state one toggles,
 * a tri-state one cycles `true` → `false` → `'mixed'` → `true`.
 */
export function nextCheckedState(checked: StatusBarHoverCheckedState, triState: boolean): StatusBarHoverCheckedState {
	if (!triState) {
		return checked !== true;
	}
	return checked === true ? false : checked === false ? 'mixed' : true;
}

/** The arguments a hover control runs its command with: a checkbox appends its new state. */
export function hoverCommandArguments(command: vscode.Command, checked: StatusBarHoverCheckedState | undefined): unknown[] {
	return [...(command.arguments ?? []), ...(checked === undefined ? [] : [checked])];
}

/**
 * `StatusBarHover` to its DTO. Every command is pushed onto `commands` and
 * replaced by its index there. Malformed items are dropped rather than
 * thrown on: the item is redrawn on every change, and one bad field should
 * not take the status bar entry with it.
 */
export function toStatusBarHoverDto(
	hover: vscode.StatusBarHover,
	commands: vscode.Command[],
	toMarkdown: (value: vscode.MarkdownString) => IMarkdownString,
): IStatusBarHoverDto {
	const handleOf = (command: unknown): number | undefined => {
		if (!isRecord(command) || typeof command.command !== 'string' || command.command.length === 0) {
			return undefined;
		}
		commands.push(command as unknown as vscode.Command);
		return commands.length - 1;
	};

	const leaf = (item: unknown): StatusBarHoverLeafDto | undefined => {
		if (!isRecord(item)) {
			return undefined;
		}
		const id = optionalString(item.id);
		switch (item.kind) {
			case 'header': {
				if (typeof item.label !== 'string') {
					return undefined;
				}
				const actions: { icon: string; title: string; handle: number }[] = [];
				for (const action of Array.isArray(item.actions) ? item.actions : []) {
					if (!isRecord(action) || !isRecord(action.icon) || typeof action.icon.id !== 'string') {
						continue;
					}
					const handle = handleOf(action.command);
					if (handle !== undefined) {
						actions.push({ icon: action.icon.id, title: commandTitle(action.command), handle });
					}
				}
				return { kind: 'header', id, label: item.label, description: optionalString(item.description), actions };
			}
			case 'text': {
				const text = typeof item.text === 'string'
					? item.text
					: isRecord(item.text) && typeof item.text.value === 'string'
						? toMarkdown(item.text as unknown as vscode.MarkdownString)
						: undefined;
				return text === undefined ? undefined : { kind: 'text', id, text, muted: item.muted === true };
			}
			case 'progress': {
				if (typeof item.label !== 'string') {
					return undefined;
				}
				const value = typeof item.value === 'number' && Number.isFinite(item.value)
					? Math.min(100, Math.max(0, item.value))
					: undefined;
				return {
					kind: 'progress', id, label: item.label, value,
					valueLabel: optionalString(item.valueLabel),
					description: optionalString(item.description),
					detail: optionalString(item.detail),
				};
			}
			case 'checkbox': {
				const handle = handleOf(item.command);
				if (typeof item.label !== 'string' || handle === undefined) {
					return undefined;
				}
				const triState = item.triState === true;
				const checked: StatusBarHoverCheckedState = item.checked === 'mixed' && triState ? 'mixed' : item.checked === true;
				return {
					kind: 'checkbox', id, label: item.label, checked, triState,
					enabled: item.enabled !== false,
					description: optionalString(item.description),
					handle,
				};
			}
			case 'buttons': {
				const buttons: { label: string; title: string; secondary: boolean; enabled: boolean; handle: number }[] = [];
				for (const button of Array.isArray(item.buttons) ? item.buttons : []) {
					if (!isRecord(button) || typeof button.label !== 'string') {
						continue;
					}
					const handle = handleOf(button.command);
					if (handle !== undefined) {
						buttons.push({
							label: button.label,
							title: commandTitle(button.command),
							secondary: button.secondary === true,
							enabled: button.enabled !== false,
							handle,
						});
					}
				}
				return buttons.length === 0 ? undefined : { kind: 'buttons', id, buttons };
			}
			case 'separator':
				return { kind: 'separator', id };
			default:
				return undefined;
		}
	};

	const items: StatusBarHoverItemDto[] = [];
	for (const item of Array.isArray(hover?.items) ? hover.items : []) {
		if (isRecord(item) && item.kind === 'section') {
			if (typeof item.label !== 'string') {
				continue;
			}
			const children: StatusBarHoverLeafDto[] = [];
			for (const child of Array.isArray(item.items) ? item.items : []) {
				const converted = leaf(child);
				if (converted) {
					children.push(converted);
				}
			}
			items.push({ kind: 'section', id: optionalString(item.id), label: item.label, description: optionalString(item.description), items: children });
		} else {
			const converted = leaf(item);
			if (converted) {
				items.push(converted);
			}
		}
	}
	return { items };
}

function commandTitle(command: unknown): string {
	if (!isRecord(command)) {
		return '';
	}
	return typeof command.tooltip === 'string' && command.tooltip.length > 0
		? command.tooltip
		: typeof command.title === 'string' ? command.title : '';
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
