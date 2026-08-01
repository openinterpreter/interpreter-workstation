#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const suites = {
  darwin: [
    ['agent web app', 'pnpm', ['run', 'test:cua:agent:web']],
    ['native primitive app', 'pnpm', ['run', 'test:mac-cua-driver']],
  ],
  win32: [
    ['browser web app', 'pnpm', ['run', 'test:win-cua-chromium']],
    ['agent native app', 'pnpm', ['run', 'test:win-cua-agent-calculator']],
    ['native primitive app', 'pnpm', ['run', 'test:win-cua-driver']],
  ],
};

const selected = suites[process.platform];
if (!selected) {
  console.error(`No CUA suite is defined for ${process.platform}.`);
  process.exit(1);
}

for (const [label, command, args] of selected) {
  console.log(`\n[cua-suite] ${label}: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('\n[cua-suite] passed');
