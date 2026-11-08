# libghostty-vt (wasm32)

`ghostty-vt.wasm` is Ghostty's terminal core (`libghostty-vt`, MIT, see
`distribution/licenses/Ghostty-MIT.txt`) compiled for `wasm32-freestanding`:
the per-pane engine of the tmux control-mode terminal
(`src/main/ptyHost/vt/libghosttyVt.ts`, `docs/terminal-mode.md`).

- Source: the file `wasm/ghostty-vt.wasm` of the npm package
  `@gkoreli/ghostty-vt-js@0.6.0`, an unpatched build of the C ABI.
- sha256: `7cf0d42c8737137cb49293326e1d69b90de44b3800b9c52f6ba33e252fe171d7`
- `ghostty_build_info`: version `0.1.0-dev`, ReleaseSmall, no SIMD.

It is to be replaced by the release's own build (`vt-1.0.0`, ReleaseFast,
with the Zig its `build.zig.zon` names); see `docs/terminal-mode.md`, "Where
the wasm comes from". The binding checks the version and the struct layouts
it uses when it loads, so a different build is refused at start rather than
misread.
