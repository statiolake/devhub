/*
 * Stands in for the `electron` module under vitest.
 *
 * vitest runs in plain Node, where there is no Electron to import, and the
 * real package's entry point exports the binary's *path string* — and
 * downloads the binary on first require. So a module under test that imports
 * `electron` gets nothing at all from this stub: every named import is
 * `undefined`, as it would be from the real package, minus the download.
 *
 * A test that needs a real Electron cannot be a vitest test: it has to run under
 * the Electron interpreter, which is what `test/terminal/run-under-electron.sh`
 * is for.
 */
module.exports = {};
