# Working on DevHub

- Run the full suite locally: `pnpm test:local` (`scripts/test-local.sh`). It
  reproduces CI on this machine — Linux included — fmt, lint, every typecheck
  (the desktop's main process included), vitest, `test:pty` under DevHub's own
  Electron, the script tests and the app smoke test under `xvfb-run` against
  the packaged layout. There is nothing to provision beyond `pnpm install`
  (DevHub has no VS Code any more: `docs/without-vscode.md`).
- Iterate locally: name only the stages you need, e.g.
  `scripts/test-local.sh --no-provision vitest pty`. Logs are in
  `.spike/test-local/<stage>.log`.
- Use CI only as the final check after pushing — not as the edit-test loop.
- Under root the test stages run as the unprivileged `devhub-test` user, so
  permission-based tests behave as on CI's macOS runner.
- See `CONTRIBUTING.md` (Local checks) and `docs/ci.md` for what runs where.
