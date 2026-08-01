#!/usr/bin/env node

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_WINDOWS_WORKSPACE_CMD,
  inferMountedWindowsPath,
} from './windows-vm-utils.mjs';

const subcommand = process.argv[2];
const passthroughArgs = process.argv.slice(3);
const normalizedPassthroughArgs =
  passthroughArgs[0] === '--' ? passthroughArgs.slice(1) : passthroughArgs;
const sourceWindowsPath = inferMountedWindowsPath();
const sourceBundlePath = path.join(process.cwd(), '.platform-workspace', 'windows', 'source.bundle');

function usage() {
  console.error(
    'Usage: node scripts/windows-vm-workspace.mjs <status|sync|install|run|test:smoke|test:voice> [-- <command>]',
  );
}

function runLocalGit(command) {
  return execSync(command, {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
}

function getSourceInfo() {
  return {
    branch: runLocalGit('git rev-parse --abbrev-ref HEAD'),
    commit: runLocalGit('git rev-parse HEAD'),
    dirty: runLocalGit('git status --porcelain').length > 0,
    sourcePath: process.cwd(),
  };
}

function buildSourceBundle() {
  fs.mkdirSync(path.dirname(sourceBundlePath), { recursive: true });
  execSync(`git bundle create ${JSON.stringify(sourceBundlePath)} HEAD`, {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
}

function runWindowsShell(args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, ['scripts/windows-vm-shell.mjs', ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (!allowFailure && result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return result.status ?? 0;
}

function quotePowerShellString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function buildWorkspaceExpression() {
  const override = process.env.INTERPRETER_WINDOWS_WORKSPACE;
  if (override && override.trim().length > 0) {
    return quotePowerShellString(override.trim());
  }
  return "Join-Path $env:USERPROFILE 'workstation-app-win'";
}

function getWorkspaceCmdPath() {
  const override = process.env.INTERPRETER_WINDOWS_WORKSPACE;
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  return DEFAULT_WINDOWS_WORKSPACE_CMD;
}

function getPassthroughEnvArgs() {
  const passthroughKeys = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'GROQ_API_KEY',
  ];

  return passthroughKeys.flatMap((key) => {
    const value = process.env[key];
    if (!value) {
      return [];
    }
    return ['--env', `${key}=${value}`];
  });
}

function runWorkspaceStatus() {
  const script = `
$ErrorActionPreference = 'Stop'
$dest = ${buildWorkspaceExpression()}
$metadataPath = Join-Path $dest '.interpreter-windows-mirror-state.txt'

Write-Output "workspace=$dest"
Write-Output ("exists=" + (Test-Path -LiteralPath $dest))
Write-Output ("git=" + (Test-Path -LiteralPath (Join-Path $dest '.git')))
if (Test-Path -LiteralPath $metadataPath) {
  Write-Output "metadata:"
  Get-Content -LiteralPath $metadataPath
}
if (Test-Path -LiteralPath (Join-Path $dest '.git')) {
  $branch = (git -C $dest rev-parse --abbrev-ref HEAD).Trim()
  $commit = (git -C $dest rev-parse HEAD).Trim()
  $status = git -C $dest status --short --ignore-submodules=all
  if ($null -eq $status) {
    $status = ''
  }
  $dirty = ($status.ToString().Trim().Length -gt 0)
  Write-Output "branch=$branch"
  Write-Output "commit=$commit"
  Write-Output "dirty=$dirty"
}
`;

  runWindowsShell(['--shell', 'powershell', '--', script]);
}

function syncWorkspace() {
  if (!sourceWindowsPath) {
    throw new Error('The current repo is not under your macOS home directory, so no mounted Windows source path could be inferred.');
  }

  buildSourceBundle();

  const sourceInfo = getSourceInfo();
  const bundleWindowsPath = `${sourceWindowsPath}\\.platform-workspace\\windows\\source.bundle`;
  const syncScriptWindowsPath = `${sourceWindowsPath}\\scripts\\windows-vm-sync.cmd`;

  runWindowsShell([
    '--shell',
    'cmd',
    '--',
    `"${syncScriptWindowsPath}" "${sourceWindowsPath}" "${bundleWindowsPath}" "${sourceInfo.branch}" "${sourceInfo.commit}" "${sourceInfo.dirty}" "${sourceInfo.sourcePath}" "${new Date().toISOString()}"`,
  ]);
}

function runWorkspaceCommand(command) {
  const workspacePath = getWorkspaceCmdPath();
  runWindowsShell([
    '--shell',
    'cmd',
    ...getPassthroughEnvArgs(),
    '--env',
    'npm_config_script_shell=%ProgramFiles%\\Git\\bin\\bash.exe',
    '--env',
    'NODE_OPTIONS=--max-old-space-size=4096',
    '--',
    `pushd "${workspacePath}" && ${command}`,
  ]);
}

if (!subcommand) {
  usage();
  process.exit(1);
}

switch (subcommand) {
  case 'status':
    runWorkspaceStatus();
    break;
  case 'sync':
    syncWorkspace();
    break;
  case 'install':
    syncWorkspace();
    runWorkspaceCommand('pnpm install --config.confirmModulesPurge=false');
    break;
  case 'run': {
    const command = normalizedPassthroughArgs.join(' ').trim();
    if (!command) {
      usage();
      process.exit(1);
    }
    runWorkspaceCommand(command);
    break;
  }
  case 'test:smoke':
    syncWorkspace();
    runWorkspaceCommand('set SHOW_WINDOW=1 && pnpm run test:e2e:smoke');
    break;
  case 'test:voice':
    syncWorkspace();
    runWorkspaceCommand('set SHOW_WINDOW=1 && pnpm run test:voice');
    break;
  default:
    usage();
    process.exit(1);
}
