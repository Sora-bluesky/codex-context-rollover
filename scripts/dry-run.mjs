#!/usr/bin/env node

import { runSyntheticDryRun } from "./synthetic/dry-run-scenario.mjs";

const result = await runSyntheticDryRun();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
