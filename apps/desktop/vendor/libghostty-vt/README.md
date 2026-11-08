# libghostty-vt (wasm32)

`ghostty-vt.wasm` is Ghostty's terminal core, libghostty-vt 1.0.0 (MIT, see
`distribution/licenses/Ghostty-MIT.txt`), compiled for `wasm32-freestanding`:
the per-pane engine of the tmux control-mode terminal
(`src/main/ptyHost/vt/libghosttyVt.ts`, `docs/terminal-mode.md`).

It is built by `scripts/build_libghostty_vt.py`, which writes it and
`BUILD.json` beside it: the `vt-1.0.0` tag at its commit, Zig 0.17.0 (PyPI's
`ziglang`), `ReleaseFast` with `simd128` (the wasm target's default CPU) and
debug info stripped, every dependency checked against the hash Ghostty's
manifests name and built with `--system`, so nothing else is reached.
`BUILD.json` holds the module's sha256; `libghosttyVt.test.ts` checks the
committed bytes against it.

Why it is committed rather than downloaded (as tmux and bash are, through
`product-overrides.json`): those are per-platform binaries a DevHub fetches
onto an SSH host at run time; this is one file, the same everywhere, that
every build needs. Committed, a build needs no network and no release to
exist, and the script reproduces it byte for byte.

To update it: change `TAG`, `COMMIT` and the Zig pins in the script, run it,
check `SUPPORTED_VERSIONS` and the ABI numbers in `libghosttyVt.ts` against the
new tag's headers, and commit the module and `BUILD.json` together.
