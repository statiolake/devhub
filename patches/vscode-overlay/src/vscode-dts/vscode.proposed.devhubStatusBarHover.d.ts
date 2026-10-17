/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// DevHub: this file is patches/vscode-overlay/'s, the API behind it
	// patches/vscode/0009's. Not upstream; DevHub's product.json enables it for
	// DevHub's own built-in extensions.

	export interface StatusBarItem {

		/**
		 * A rich hover the workbench draws from its own widgets (the ones its
		 * Copilot status dashboard is made of): headers, text, progress bars,
		 * checkboxes, buttons, sections.
		 *
		 * While set it takes the place of {@link StatusBarItem.tooltip}. An item
		 * without a {@link StatusBarItem.command} then toggles the hover on
		 * click and moves keyboard focus into it, so it can be pinned and used
		 * from the keyboard.
		 *
		 * Assign a new value to change it; a hover that is open is redrawn in
		 * place, keeping focus on the control that had it (matched by
		 * {@link StatusBarHoverItemBase.id}, else by position).
		 */
		hover: StatusBarHover | undefined;
	}

	export interface StatusBarHover {
		readonly items: readonly StatusBarHoverItem[];
	}

	export type StatusBarHoverItem =
		| StatusBarHoverHeader
		| StatusBarHoverText
		| StatusBarHoverProgress
		| StatusBarHoverCheckbox
		| StatusBarHoverButtons
		| StatusBarHoverSeparator
		| StatusBarHoverSection;

	export interface StatusBarHoverItemBase {
		/** Identifies the item across updates, so focus stays on it. */
		readonly id?: string;
	}

	/**
	 * A title row: a label, a muted second line and icon-only actions on the
	 * right. `label` and `description` may contain `$(icon)`s.
	 */
	export interface StatusBarHoverHeader extends StatusBarHoverItemBase {
		readonly kind: 'header';
		readonly label: string;
		readonly description?: string;
		/** Each command's `title` is its tooltip and accessible name. */
		readonly actions?: readonly { readonly icon: ThemeIcon; readonly command: Command }[];
	}

	/**
	 * A line of text. A string may contain `$(icon)`s, `$(loading~spin)` among
	 * them; a `MarkdownString` may contain links, command links only when it is
	 * trusted.
	 */
	export interface StatusBarHoverText extends StatusBarHoverItemBase {
		readonly kind: 'text';
		readonly text: string | MarkdownString;
		/** Drawn in the description colour. */
		readonly muted?: boolean;
	}

	/**
	 * A meter, drawn like a quota indicator: `label` and `detail` above,
	 * `valueLabel` and `description` beside the value, then the bar.
	 */
	export interface StatusBarHoverProgress extends StatusBarHoverItemBase {
		readonly kind: 'progress';
		readonly label: string;
		/** How full the bar is, 0 to 100. Leave it out for an indeterminate bar. */
		readonly value?: number;
		/** The large figure, e.g. `42%`. */
		readonly valueLabel?: string;
		/** Beside the figure, e.g. `used`. */
		readonly description?: string;
		/** Right of the label, e.g. `Resets Nov 1`. */
		readonly detail?: string;
	}

	/**
	 * A checkbox. Clicking it, its label, or pressing Space on it runs
	 * `command` with its arguments followed by the new state; the checkbox
	 * shows that state at once and then whatever the next update says.
	 */
	export interface StatusBarHoverCheckbox extends StatusBarHoverItemBase {
		readonly kind: 'checkbox';
		readonly label: string;
		/** `'mixed'` is only drawn by a `triState` checkbox. */
		readonly checked: boolean | 'mixed';
		/** Cycles `true` → `false` → `'mixed'` → `true`, like a setting with an inherited state. */
		readonly triState?: boolean;
		readonly command: Command;
		/** Default `true`. */
		readonly enabled?: boolean;
		/** A muted note after the label, e.g. `(overridden)`. */
		readonly description?: string;
	}

	/** A row of buttons. Labels may contain `$(icon)`s. */
	export interface StatusBarHoverButtons extends StatusBarHoverItemBase {
		readonly kind: 'buttons';
		readonly buttons: readonly {
			readonly label: string;
			readonly command: Command;
			readonly secondary?: boolean;
			/** Default `true`. */
			readonly enabled?: boolean;
		}[];
	}

	export interface StatusBarHoverSeparator extends StatusBarHoverItemBase {
		readonly kind: 'separator';
	}

	/**
	 * A titled group with a rule above it. `description` is drawn muted at the
	 * right of the title. Sections do not nest.
	 */
	export interface StatusBarHoverSection extends StatusBarHoverItemBase {
		readonly kind: 'section';
		readonly label: string;
		readonly description?: string;
		readonly items: readonly Exclude<StatusBarHoverItem, StatusBarHoverSection>[];
	}
}
