#!/usr/bin/env node
// CLI entry point — Phase 2 M3. Subcommands live in commands.ts.

import { main } from './commands.js';

main().catch((err: unknown) => {
  process.stderr.write(`[sepia] fatal: ${String(err)}\n`);
  process.exit(1);
});
