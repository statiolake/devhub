# Working on DevHub

- Run the full suite locally: `pnpm test:local` (`scripts/test-local.sh`). It
  reproduces CI on this machine — Linux included — fmt, lint, the extension
  checks, every typecheck (the desktop's main process included), vitest,
  `test:pty` under Electron, the script tests, the VS Code overlay's tests
  (devhubVim etc.) and the app smoke test under `xvfb-run`. The first run
  provisions the VS Code submodule (about 6 GB, stamped and cached); later runs
  skip it.
- Iterate locally: name only the stages you need, e.g.
  `scripts/test-local.sh --no-provision vitest overlay`. Logs are in
  `.spike/test-local/<stage>.log`.
- Use CI only as the final check after pushing — not as the edit-test loop.
- Under root the test stages run as the unprivileged `devhub-test` user, so
  permission-based tests behave as on CI's macOS runner.
- See `CONTRIBUTING.md` (Local checks) and `docs/ci.md` for what runs where.
