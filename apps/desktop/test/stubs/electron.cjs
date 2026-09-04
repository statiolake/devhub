/*
 * Stands in for the `electron` module when a test reaches into VS Code.
 *
 * A suite that imports one of VS Code's main-process modules pulls its
 * `import { app, BrowserWindow, … } from 'electron'` in with it, and vitest
 * runs in plain Node, where there is no Electron to import. Up to 1.131.0 the
 * import was answered by `vscode/node_modules/electron`, because VS Code listed
 * Electron among its devDependencies; 1.136.1 dropped it, leaving the import to
 * reach whichever nested `node_modules` a walk up the tree found first.
 *
 * DevHub's own `electron` dependency is not the answer either. It is there for
 * its type declarations, and `pnpm-workspace.yaml` turns its install script off
 * precisely so that no second Electron is downloaded — the binary DevHub runs is
 * VS Code's own, under `vscode/.build/electron`. Naming that package here would
 * undo that: the package's entry point downloads the binary on first require, so
 * the test suite would fetch a hundred megabytes the moment it touched a VS Code
 * module.
 *
 * So the answer is nothing at all, which is also what it has always been. The
 * real package exports a *path string*, so every one of those named imports was
 * already `undefined` in these tests, and every test that passes today passes
 * because it never reads one. This keeps that exactly, minus the download.
 *
 * A test that needs a real Electron cannot be a vitest test: it has to run under
 * the Electron interpreter, which is what `test/terminal/run-under-electron.sh`
 * is for.
 */
module.exports = {};
