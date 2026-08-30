/**
 * The ambient declarations VS Code's own sources are compiled against.
 *
 * DevHub type-checks against `vscode/src/**`, which means it must be given the
 * same globals VS Code's `src/tsconfig.json` includes — `Timeout`, `Thenable`
 * and the rest. Referencing the submodule's typings directly keeps them one
 * copy, pinned with the submodule.
 */

/// <reference path="../../node_modules/code-oss-dev/src/typings/base-common.d.ts" />
/// <reference path="../../node_modules/code-oss-dev/src/typings/thenable.d.ts" />
/// <reference path="../../node_modules/code-oss-dev/src/typings/crypto.d.ts" />
/// <reference path="../../node_modules/code-oss-dev/src/typings/css.d.ts" />
/// <reference path="../../node_modules/code-oss-dev/src/typings/editContext.d.ts" />
/// <reference path="../../node_modules/code-oss-dev/src/typings/vscode-globals-nls.d.ts" />
/// <reference path="../../node_modules/code-oss-dev/src/typings/vscode-globals-product.d.ts" />
/// <reference path="../../node_modules/code-oss-dev/src/typings/vscode-globals-ttp.d.ts" />
