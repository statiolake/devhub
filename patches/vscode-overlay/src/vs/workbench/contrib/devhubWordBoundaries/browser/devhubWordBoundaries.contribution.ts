/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: the setting for word boundaries between scripts. The rule and why
// are in editor/common/core/scriptWordBoundaries.ts; this only switches it,
// for every editor at once, from `devhub.editor.wordBoundariesByScript`.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { editorConfigurationBaseNode } from '../../../../editor/common/config/editorConfigurationSchema.js';
import { ScriptWordBoundaries } from '../../../../editor/common/core/scriptWordBoundaries.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';

export const WORD_BOUNDARIES_BY_SCRIPT_SETTING = 'devhub.editor.wordBoundariesByScript';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...editorConfigurationBaseNode,
	properties: {
		[WORD_BOUNDARIES_BY_SCRIPT_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('devhub.editor.wordBoundariesByScript', "End words where the script changes, as Vim does: between kanji, hiragana, katakana, fullwidth letters and digits, CJK punctuation, hangul, emoji and other text (`日本語の文章` is `日本語` / `の` / `文章`). Applies to word moves and deletes (Alt+Left / Alt+Right, Alt+Backspace), double-click selection, the word under the cursor (Cmd+D, the word highlight), whole-word matches and DevHub Vim's `w b e ge iw aw * \\< \\>`. Changes between ASCII letters and punctuation stay `#editor.wordSeparators#`'. Works with `#editor.wordSegmenterLocales#`: its words are split at script changes too."),
		},
	},
});

class DevhubWordBoundaries extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.devhubWordBoundaries';

	constructor(@IConfigurationService configurationService: IConfigurationService) {
		super();
		const read = () => ScriptWordBoundaries.setEnabled(configurationService.getValue<boolean>(WORD_BOUNDARIES_BY_SCRIPT_SETTING) !== false);
		read();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(WORD_BOUNDARIES_BY_SCRIPT_SETTING)) {
				read();
			}
		}));
	}
}

registerWorkbenchContribution2(DevhubWordBoundaries.ID, DevhubWordBoundaries, WorkbenchPhase.BlockStartup);
