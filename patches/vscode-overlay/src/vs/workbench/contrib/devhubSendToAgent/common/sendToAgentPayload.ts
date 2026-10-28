/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: what "Send to Agent…" tells DevHub about the editor — the file, its
// language and each selected range with its text. DevHub's main process reads
// it (apps/desktop/src/main/agent/sendSelection.ts, `parseSendSelection`),
// picks the Agent, writes the reference in the form that Agent's CLI reads and
// puts it in the Agent's input box. Nothing here knows about Agents.

import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IRange } from '../../../../editor/common/core/range.js';

/** The command: the editor's context menu, the Command Palette and the keys. */
export const SEND_TO_AGENT_COMMAND_ID = 'devhub.sendSelectionToAgent';

/** Workbench → main, once per send: one `SendToAgentPayload`. */
export const SEND_TO_AGENT_CHANNEL = 'vscode:devhubSendToAgent';

/**
 * One selected range, one-based and inclusive, as an editor counts lines.
 * `text` is what is selected; empty for a bare cursor, which sends the line
 * it is on as a reference only.
 */
export interface SendToAgentRange {
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
}

export interface SendToAgentPayload {
	/** The shape's version, so a DevHub and a workbench of different builds refuse rather than misread. */
	readonly version: 1;
	/** The document, as its URI says it. */
	readonly uri: string;
	/**
	 * The file's path on the machine it is on — this Mac for `file:`, the
	 * remote for `vscode-remote:` — or nothing for a document that is no file
	 * (an untitled editor, an output channel).
	 */
	readonly path: string | undefined;
	/** VS Code's language id (`typescript`, `shellscript`), which names the fence's language. */
	readonly languageId: string;
	/** Every selection, in document order; a range selected twice is sent once. */
	readonly ranges: readonly SendToAgentRange[];
}

/** As much of a text model as a payload is read from. */
export interface SendToAgentDocument {
	readonly uri: URI;
	getLanguageId(): string;
	getValueInRange(range: IRange): string;
}

/** As much of a selection as a payload is read from: its start and end, in document order. */
export type SendToAgentSelection = IRange;

/** The file's path on its machine, when the document is a file. */
export function documentPath(uri: URI): string | undefined {
	return uri.scheme === Schemas.file || uri.scheme === Schemas.vscodeRemote ? uri.path : undefined;
}

/**
 * One selection as lines and text. A selection that ends at the very start of
 * a line (a whole line selected by dragging down, or Vim's `V`) does not take
 * that line: its last line is the one before, as the editor highlights it.
 */
export function selectedRange(document: SendToAgentDocument, selection: SendToAgentSelection): SendToAgentRange {
	const startLine = selection.startLineNumber;
	const empty = selection.startLineNumber === selection.endLineNumber && selection.startColumn === selection.endColumn;
	if (empty) {
		return { startLine, endLine: startLine, text: '' };
	}
	const endsAtLineStart = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber;
	const endLine = endsAtLineStart ? selection.endLineNumber - 1 : selection.endLineNumber;
	return { startLine, endLine, text: document.getValueInRange(selection) };
}

export function sendToAgentPayload(document: SendToAgentDocument, selections: readonly SendToAgentSelection[]): SendToAgentPayload {
	const ranges = selections
		.map(selection => selectedRange(document, selection))
		.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
	const unique = ranges.filter((range, index) => {
		const before = ranges[index - 1];
		return before === undefined || before.startLine !== range.startLine || before.endLine !== range.endLine || before.text !== range.text;
	});
	return {
		version: 1,
		uri: document.uri.toString(),
		path: documentPath(document.uri),
		languageId: document.getLanguageId(),
		ranges: unique,
	};
}
