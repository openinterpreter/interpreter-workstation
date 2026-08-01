#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_WINDOWS_VM_NAME, inferMountedWindowsPath } from './windows-vm-utils.mjs';

function usage() {
  console.error(
    'Usage: node scripts/windows-vm-shell.mjs [--vm <name>] [--shell powershell|cmd] [--cwd <windows-path>] [--env NAME=VALUE] [--stdin | --stdin-base64 <b64>] -- <command>',
  );
  console.error(
    '       node scripts/windows-vm-shell.mjs [--vm <name>] [--shell powershell|cmd] [--cwd <windows-path>] [--env NAME=VALUE] --stdin',
  );
}

function escapePowerShellLiteral(value) {
  return value.replaceAll("'", "''");
}

function escapeCmdDoubleQuoted(value) {
  return value.replaceAll('"', '""');
}

function isMountedRepoPath(cwd) {
  if (!cwd) {
    return false;
  }
  const normalized = cwd.toLowerCase();
  return normalized === 'c:\\mac\\home' || normalized.startsWith('c:\\mac\\home\\');
}

function parseArgs(argv) {
  const options = {
    vm: DEFAULT_WINDOWS_VM_NAME,
    shell: 'powershell',
    cwd: inferMountedWindowsPath(),
    env: [],
    command: [],
    stdin: false,
    stdinBase64: '',
  };

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '--') {
      options.command = argv.slice(index + 1);
      break;
    }

    if (arg === '--vm') {
      index += 1;
      options.vm = argv[index] ?? '';
    } else if (arg === '--shell') {
      index += 1;
      options.shell = argv[index] ?? '';
    } else if (arg === '--cwd') {
      index += 1;
      options.cwd = argv[index] ?? '';
    } else if (arg === '--env') {
      index += 1;
      options.env.push(argv[index] ?? '');
    } else if (arg === '--stdin') {
      options.stdin = true;
    } else if (arg === '--stdin-base64') {
      index += 1;
      options.stdinBase64 = argv[index] ?? '';
    } else {
      options.command = argv.slice(index);
      break;
    }

    index += 1;
  }

  return options;
}

function readCommandFromStdin() {
  return fs.readFileSync(0, 'utf8').trim();
}

function readCommandFromBase64(value) {
  return Buffer.from(value, 'base64').toString('utf8').trim();
}

function getDefaultEnvPairs(options) {
  if (options.shell !== 'cmd' || !isMountedRepoPath(options.cwd)) {
    return [];
  }

  return [
    ['npm_config_node_linker', 'hoisted'],
    ['npm_config_store_dir', '%LOCALAPPDATA%\\pnpm\\store-mounted'],
    ['npm_config_script_shell', '%ProgramFiles%\\Git\\bin\\bash.exe'],
  ];
}

function buildPowerShellScript(command, cwd, envPairs) {
  const lines = ["$ErrorActionPreference = 'Stop'"];
  if (cwd) {
    lines.push(`Set-Location -LiteralPath '${escapePowerShellLiteral(cwd)}'`);
  }
  for (const [name, value] of envPairs) {
    lines.push(`$env:${name} = '${escapePowerShellLiteral(value)}'`);
  }
  lines.push(command);
  return `${lines.join('\n')}\n`;
}

function buildCmdCommand(command, cwd, envPairs) {
  const parts = [];
  if (cwd) {
    parts.push(`pushd "${escapeCmdDoubleQuoted(cwd)}"`);
  }
  for (const [name, value] of envPairs) {
    parts.push(`set "${name}=${value}"`);
  }
  parts.push(command);
  return parts.join(' && ');
}

function parseEnvPairs(entries) {
  return entries.map((entry) => {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Invalid --env value: ${entry}`);
    }
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  });
}

function assertTahoeNotRunning() {
  const result = spawnSync('tart', ['list'], {
    encoding: 'utf8',
  });
  if (result.error && result.error.code === 'ENOENT') {
    return;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'Failed to inspect Tahoe VMs with tart list.\n');
    process.exit(result.status ?? 1);
  }
  const runningLines = (result.stdout || '')
    .split(/\r?\n/)
    .filter((line) => /\brunning\b/i.test(line));
  if (runningLines.length > 0) {
    throw new Error(`Refusing to start Windows while Tahoe VM is running:\n${runningLines.join('\n')}`);
  }
}

function ensureVmRunning(vmName) {
  const status = spawnSync('prlctl', ['status', vmName], {
    encoding: 'utf8',
  });
  if (status.error) {
    throw status.error;
  }
  if (status.status !== 0) {
    process.stderr.write(status.stderr || status.stdout || `Failed to inspect VM ${vmName}\n`);
    process.exit(status.status ?? 1);
  }
  if (/\brunning\b/i.test(status.stdout || '')) {
    return false;
  }

  assertTahoeNotRunning();
  const start = spawnSync('prlctl', ['start', vmName], {
    stdio: 'inherit',
  });
  if (start.error) {
    throw start.error;
  }
  if (start.status !== 0) {
    process.exit(start.status ?? 1);
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const probe = spawnSync('prlctl', ['exec', vmName, '--current-user', 'cmd', '/d', '/s', '/c', 'ver'], {
      stdio: 'ignore',
    });
    if (probe.status === 0) {
      return true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error(`Windows VM "${vmName}" started but did not become ready for prlctl exec within 120s.`);
}

function suspendVmIfStarted(vmName, startedByThisCommand) {
  if (!startedByThisCommand) {
    return;
  }
  const suspend = spawnSync('prlctl', ['suspend', vmName], {
    stdio: 'inherit',
  });
  if (suspend.error) {
    throw suspend.error;
  }
  if (suspend.status !== 0) {
    process.stderr.write(`Failed to suspend Windows VM "${vmName}" after command.\n`);
  }
}

const options = parseArgs(process.argv.slice(2));

if (!options.vm || !options.shell) {
  usage();
  process.exit(1);
}

if (options.shell !== 'powershell' && options.shell !== 'cmd') {
  throw new Error(`Unsupported shell: ${options.shell}`);
}

const envPairs = parseEnvPairs(options.env);
const mergedEnvPairs = [...getDefaultEnvPairs(options), ...envPairs];
let command = options.command.join(' ').trim();

if (options.stdinBase64) {
  command = readCommandFromBase64(options.stdinBase64);
} else if (options.stdin || (!command && !process.stdin.isTTY)) {
  command = readCommandFromStdin();
}

if (!command) {
  usage();
  process.exit(1);
}

const startedVm = ensureVmRunning(options.vm);

let prlctlArgs;
let localPowerShellScriptPath = null;

if (options.shell === 'powershell') {
  const script = buildPowerShellScript(command, options.cwd, mergedEnvPairs);
  const powerShellTempDir = path.join(process.cwd(), '.platform-workspace', 'windows', 'tmp');
  fs.mkdirSync(powerShellTempDir, { recursive: true });
  localPowerShellScriptPath = path.join(
    powerShellTempDir,
    `winvm-${Date.now()}-${process.pid}.ps1`,
  );
  fs.writeFileSync(localPowerShellScriptPath, script, 'utf8');
  const windowsPowerShellScriptPath = inferMountedWindowsPath(localPowerShellScriptPath);
  if (!windowsPowerShellScriptPath) {
    throw new Error(
      'Failed to map the temporary PowerShell script into the mounted Windows path.',
    );
  }
  prlctlArgs = [
    'exec',
    options.vm,
    '--current-user',
    'cmd',
    '/d',
    '/s',
    '/c',
    `powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${escapeCmdDoubleQuoted(windowsPowerShellScriptPath)}"`,
  ];
} else {
  prlctlArgs = [
    'exec',
    options.vm,
    '--current-user',
    'cmd',
    '/d',
    '/s',
    '/c',
    buildCmdCommand(command, options.cwd, mergedEnvPairs),
  ];
}

let exitCode = 1;
try {
  const result = spawnSync('prlctl', prlctlArgs, {
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  exitCode = result.status ?? 1;
} finally {
  if (localPowerShellScriptPath) {
    fs.rmSync(localPowerShellScriptPath, { force: true });
  }
  suspendVmIfStarted(options.vm, startedVm);
}

process.exit(exitCode);
