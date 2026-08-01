/**
 * Silent Environment Detection
 *
 * Detects installed tools, config directories, applications, and environment
 * variables on the user's system to derive an onboarding persona.
 *
 * All methods are confirmed to trigger ZERO OS permission prompts on all platforms.
 * AVOID: ~/Desktop, ~/Documents, ~/Downloads on macOS (TCC prompt).
 *
 * Detection runs in parallel with the name input screen during onboarding.
 * By the time the user finishes typing their name, detection is complete.
 */

import { existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface EnvironmentDetectionResult {
  /** Commands found via `command -v` / `which` / `where` */
  commands: Record<string, boolean>;

  /** Config directories that exist */
  configDirs: Record<string, boolean>;

  /** macOS applications found in /Applications */
  applications: string[];

  /** Environment variables that are set */
  envVars: Record<string, boolean>;

  /** Platform info */
  platform: string;
}

// ============================================================================
// Detection Lists
// ============================================================================

const COMMANDS_TO_CHECK = [
  // Development
  'node', 'npm', 'yarn', 'pnpm', 'bun', 'deno',
  'python3', 'python', 'pip',
  'go', 'rustc', 'cargo',
  'java', 'javac',
  'ruby', 'php',
  'gcc', 'clang',
  'dotnet',
  'swift',
  'flutter', 'dart',
  // DevOps
  'docker', 'kubectl', 'terraform', 'ansible',
  'aws', 'gcloud', 'az',
  // AI
  'ollama', 'lms', 'lmstudio', 'claude', 'codex', 'aider', 'cursor',
  // Creative
  'blender', 'ffmpeg', 'inkscape', 'gimp', 'freecad', 'openscad',
  // Academic
  'latex', 'pdflatex', 'R', 'Rscript', 'matlab', 'jupyter',
  // Data
  'conda',
  // General
  'git', 'brew', 'code', 'vim', 'nvim', 'tmux',
];

/** Config directories to check relative to home directory */
function getConfigDirsToCheck(): Record<string, string> {
  const home = homedir();
  return {
    // AI tools
    '.ollama': join(home, '.ollama'),
    '.lmstudio': join(home, '.lmstudio'),
    '.claude': join(home, '.claude'),
    '.cursor': join(home, '.cursor'),
    '.vscode': join(home, '.vscode'),
    '.docker': join(home, '.docker'),
    '.kube': join(home, '.kube'),
    '.aws': join(home, '.aws'),
    '.config/gcloud': join(home, '.config', 'gcloud'),
    '.azure': join(home, '.azure'),
    // Python
    '.pyenv': join(home, '.pyenv'),
    '.conda': join(home, '.conda'),
    'anaconda3': join(home, 'anaconda3'),
    'miniconda3': join(home, 'miniconda3'),
    '.jupyter': join(home, '.jupyter'),
    // Rust
    '.rustup': join(home, '.rustup'),
    '.cargo': join(home, '.cargo'),
    // Go / Java
    'go': join(home, 'go'),
    '.m2': join(home, '.m2'),
    '.gradle': join(home, '.gradle'),
    // Creative
    '.config/blender': join(home, '.config', 'blender'),
    '.config/obs-studio': join(home, '.config', 'obs-studio'),
    // AI model caches
    '.cache/huggingface': join(home, '.cache', 'huggingface'),
    '.cache/lm-studio': join(home, '.cache', 'lm-studio'),
    // General dev
    '.ssh': join(home, '.ssh'),
    '.gitconfig': join(home, '.gitconfig'),
  };
}

const MACOS_APPLICATIONS_TO_CHECK = [
  // Creative
  'Blender.app',
  'Adobe Premiere Pro',
  'DaVinci Resolve',
  'Logic Pro.app',
  'Ableton Live',
  'Figma.app',
  'Sketch.app',
  // CAD/Engineering
  'AutoCAD',
  'Autodesk Fusion',
  'FreeCAD.app',
  'KiCad',
  // Game engines
  'Unity Hub.app',
  'Unreal Engine',
  'Godot.app',
  // Academic
  'MATLAB',
  'RStudio.app',
  'Zotero.app',
  // AI tools
  'LM Studio.app',
  'GPT4All.app',
  'Jan.app',
  // Office
  'Microsoft Word.app',
  'Microsoft Excel.app',
  'Microsoft PowerPoint.app',
  // Communication
  'Slack.app',
  'zoom.us.app',
  'Microsoft Teams.app',
];

const ENV_VARS_TO_CHECK = [
  // API keys
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'HF_TOKEN',
  // GPU/Hardware
  'CUDA_HOME',
  'CUDA_VISIBLE_DEVICES',
  // Language toolchains
  'JAVA_HOME',
  'GOPATH',
  'CONDA_DEFAULT_ENV',
];

// ============================================================================
// Detection Implementation
// ============================================================================

/**
 * Run a batch of `command -v` checks via a single shell command.
 * Uses `command -v` on macOS/Linux, `where.exe` on Windows.
 */
async function detectCommands(commands: string[]): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  const currentPlatform = platform();

  return new Promise((resolve) => {
    let shellCommand: string;

    if (currentPlatform === 'win32') {
      // Windows: use `where.exe` for each command, concatenated
      const checks = commands.map(cmd =>
        `where.exe ${cmd} >nul 2>&1 && echo ${cmd}:found || echo ${cmd}:notfound`
      );
      shellCommand = checks.join(' & ');
    } else {
      // macOS/Linux: use `command -v` for each command
      const checks = commands.map(cmd =>
        `command -v ${cmd} >/dev/null 2>&1 && echo "${cmd}:found" || echo "${cmd}:notfound"`
      );
      shellCommand = checks.join('; ');
    }

    // Set a generous timeout since we're running many checks
    exec(shellCommand, { timeout: 15000, shell: currentPlatform === 'win32' ? 'cmd.exe' : '/bin/bash' }, (_error, stdout) => {
      // Parse output even if there was a partial error
      const output = stdout || '';
      for (const cmd of commands) {
        result[cmd] = output.includes(`${cmd}:found`);
      }
      resolve(result);
    });
  });
}

/**
 * Check which config directories exist using fs.existsSync (no OS prompts).
 */
function detectConfigDirs(): Record<string, boolean> {
  const dirs = getConfigDirsToCheck();
  const result: Record<string, boolean> = {};
  for (const [name, dirPath] of Object.entries(dirs)) {
    try {
      result[name] = existsSync(dirPath);
    } catch {
      result[name] = false;
    }
  }
  return result;
}

/**
 * List macOS applications in /Applications (silent, not TCC-protected).
 * Returns empty array on non-macOS platforms.
 */
async function detectApplications(): Promise<string[]> {
  if (platform() !== 'darwin') {
    return [];
  }

  return new Promise((resolve) => {
    exec('ls /Applications', { timeout: 5000 }, (error, stdout) => {
      if (error || !stdout) {
        resolve([]);
        return;
      }

      const installedApps = stdout.split('\n').filter(Boolean);
      const found: string[] = [];

      for (const appToCheck of MACOS_APPLICATIONS_TO_CHECK) {
        // Check if any installed app name contains the check string
        if (installedApps.some(installed => installed.includes(appToCheck.replace('.app', '')))) {
          found.push(appToCheck);
        }
      }

      resolve(found);
    });
  });
}

/**
 * Check which environment variables are set.
 * Uses process.env which is always free (no OS prompts).
 */
function detectEnvVars(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const varName of ENV_VARS_TO_CHECK) {
    result[varName] = !!process.env[varName] && process.env[varName]!.trim().length > 0;
  }
  return result;
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Run all environment detection probes in parallel.
 * Returns raw signals that can be fed into `derivePersona()`.
 *
 * This function is designed to complete within ~2-3 seconds, well before
 * the user finishes typing their name on the first onboarding screen.
 */
export async function detectEnvironment(): Promise<EnvironmentDetectionResult> {
  // Run all probes in parallel
  const [commands, applications] = await Promise.all([
    detectCommands(COMMANDS_TO_CHECK),
    detectApplications(),
  ]);

  // These are synchronous
  const configDirs = detectConfigDirs();
  const envVars = detectEnvVars();

  return {
    commands,
    configDirs,
    applications,
    envVars,
    platform: platform(),
  };
}
