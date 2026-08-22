# Keep diagnostics local and content-free

DevHub writes rotating structured logs under `~/Library/Logs/DevHub` and never sends telemetry, analytics, crash data, or logs automatically. Diagnostics describe lifecycle, versions, health, error codes, retries, migrations, and provider exits without recording user content.

## Consequences

- Logs rotate at 10 MB and retain at most five generations. Each app launch has a diagnostic session identifier.
- Terminal frames and input, editor content, Agent prompts and conversations, clipboard data, credentials, tokens, environment values, URL queries, and full command output are never logged.
- Normal paths abbreviate the home directory as `~`.
- Error Surfaces provide a concise cause, retry and settings actions, and an optional detail disclosure with module, code, time, and runtime version.
- Settings exposes runtime health, recheck, log-folder access, and a redacted `Copy Diagnostics` summary.
- Release logging defaults to `info`; detailed logging is a development-only option.
