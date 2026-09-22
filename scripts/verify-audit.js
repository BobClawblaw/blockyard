#!/usr/bin/env node
// Verify the audit trail's hash chain (audit 2026-09-22, L5 -- server/store/audit.js).
// Reads it the same way the running server would; does not need the server running.
//
//   node scripts/verify-audit.js
//
// Exits 0 and prints "ok" with the count checked if the chain is intact; exits 1 and names the
// first line that does not match its predecessor otherwise. See server/store/audit.js's own
// header comment for exactly what this does and does not prove -- there is no secret key, so
// this is tamper-EVIDENT (it catches an entry edited or removed without regenerating everything
// after it), not tamper-PROOF against someone with full read/write access to data/ who bothers
// to regenerate a self-consistent chain from scratch.
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { AuditLog } from '../server/store/audit.js';

const cfg = loadConfig();
const file = path.join(cfg.store.dir, 'audit.jsonl');
const log = new AuditLog(file, { maxBytes: cfg.store.auditMaxBytes, keep: cfg.store.auditKeep });
const result = await log.verifyChain();
if (result.ok) {
  process.stdout.write(`ok: ${result.checked} entries verify as one unbroken chain (${file})\n`);
  process.exit(0);
} else {
  process.stderr.write(`BROKEN: ${result.checked} entries verified, then ${result.brokenAt.file} line ${result.brokenAt.line} did not match (${result.brokenAt.reason})\n`);
  process.exit(1);
}
