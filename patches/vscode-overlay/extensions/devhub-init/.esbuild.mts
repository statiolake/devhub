/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Nothing to bundle (plain JS). build/lib/extensions.ts runs an extension's
// `.esbuild.mts` before it packages the extension's files, and this one puts
// a copy of the API's types, src/vscode-dts/vscode.d.ts, at types/vscode.d.ts,
// for the editor's IntelliSense on init.ts (extension.js copies it into the
// config directory). A source run reads src/vscode-dts/ itself.

import * as fs from 'node:fs';
import * as path from 'node:path';

const here = import.meta.dirname;
fs.copyFileSync(path.join(here, '..', '..', 'src', 'vscode-dts', 'vscode.d.ts'), path.join(here, 'types', 'vscode.d.ts'));
