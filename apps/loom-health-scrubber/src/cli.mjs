#!/usr/bin/env node
// Line filter: reads log lines on stdin, writes scrubbed lines on stdout.
//   <engine process> 2>&1 | node cli.mjs
// There is deliberately NO bypass flag: a switch that turns the scrubber off is a PHI
// leak waiting for the wrong env var. The test suite's "scrubber bypassed" control pipes
// through `cat`, not through this program.
import { pipeline } from 'node:stream/promises';
import { createScrubTransform } from './scrub.mjs';

pipeline(process.stdin, createScrubTransform(), process.stdout).catch((err) => {
  // Fail closed: say what happened, without echoing any input.
  process.stderr.write(`scrubber: pipeline failed (${err && err.code ? err.code : 'error'})\n`);
  process.exit(1);
});
