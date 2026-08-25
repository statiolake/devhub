#!/usr/bin/env node
// THROWAWAY finite lifecycle-audit entry point.
// The canonical ledger is produced by the full runner; this entry point makes
// the audited hide/show/focus/resize mode explicit for reviewers.
process.env.REAL_WORKBENCH_F02_MODE = 'lifecycle-audit';
await import('./run-f02-evidence.mjs');
