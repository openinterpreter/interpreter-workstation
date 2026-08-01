/**
 * Persona Derivation
 *
 * Takes raw environment detection signals and derives:
 * - Primary bucket: non-developer, developer, developer-local-ai
 * - Sub-categories for vision screen personalization
 * - Detected API key providers
 * - Detected tool integrations
 * - Confidence level (determines if fallback bucket question is shown)
 */

import type { EnvironmentDetectionResult } from './environmentDetection';

// ============================================================================
// Types
// ============================================================================

export type PersonaBucket = 'non-developer' | 'developer' | 'developer-local-ai';

export type PersonaSubCategory =
  | 'frontend-dev'
  | 'backend-dev'
  | 'fullstack-dev'
  | 'mobile-dev'
  | 'devops'
  | 'data-scientist'
  | 'ml-engineer'
  | '3d-artist'
  | 'video-editor'
  | 'audio-producer'
  | 'designer'
  | 'cad-engineer'
  | 'photographer'
  | 'academic-researcher'
  | 'writer'
  | 'business-professional'
  | 'ai-enthusiast'
  | 'game-developer';

export interface DerivedPersona {
  /** Primary bucket (one of three) */
  bucket: PersonaBucket;

  /** Sub-categories for vision screen personalization */
  subCategories: PersonaSubCategory[];

  /** Detected API key providers */
  detectedProviders: string[];

  /** Detected tool integrations */
  detectedTools: {
    has_claude_cli: boolean;
    has_ollama: boolean;
    has_lmstudio: boolean;
    has_cursor: boolean;
    has_vscode: boolean;
  };

  /** Whether detection was confident enough to skip the bucket question */
  confident: boolean;

  /** Raw signal counts for debugging */
  signalCounts: {
    devCommands: number;
    aiTools: number;
    creativeTools: number;
    totalSignals: number;
  };
}

// ============================================================================
// Detection Helpers
// ============================================================================

function hasCmd(signals: EnvironmentDetectionResult, cmd: string): boolean {
  return signals.commands[cmd] === true;
}

function hasDir(signals: EnvironmentDetectionResult, dir: string): boolean {
  return signals.configDirs[dir] === true;
}

function hasApp(signals: EnvironmentDetectionResult, appName: string): boolean {
  return signals.applications.some(a => a.toLowerCase().includes(appName.toLowerCase()));
}

function hasEnv(signals: EnvironmentDetectionResult, varName: string): boolean {
  return signals.envVars[varName] === true;
}

// ============================================================================
// Sub-Category Detection
// ============================================================================

function detectSubCategories(signals: EnvironmentDetectionResult): PersonaSubCategory[] {
  const categories: PersonaSubCategory[] = [];

  // Frontend dev
  const hasFrontend = hasCmd(signals, 'node') && (hasCmd(signals, 'npm') || hasCmd(signals, 'yarn') || hasCmd(signals, 'pnpm') || hasCmd(signals, 'bun'));
  if (hasFrontend) {
    categories.push('frontend-dev');
  }

  // Backend dev
  const hasBackend = hasCmd(signals, 'python3') || hasCmd(signals, 'python') || hasCmd(signals, 'go') || hasCmd(signals, 'java') || hasCmd(signals, 'ruby') || hasCmd(signals, 'php') || hasCmd(signals, 'dotnet');
  if (hasBackend) {
    categories.push('backend-dev');
  }

  // Fullstack (has both frontend and backend)
  if (hasFrontend && hasBackend) {
    categories.push('fullstack-dev');
  }

  // Mobile dev
  if (hasCmd(signals, 'flutter') || hasCmd(signals, 'dart') || hasCmd(signals, 'swift')) {
    categories.push('mobile-dev');
  }

  // DevOps
  if (hasCmd(signals, 'docker') || hasCmd(signals, 'kubectl') || hasCmd(signals, 'terraform') || hasCmd(signals, 'ansible') || hasCmd(signals, 'aws') || hasCmd(signals, 'gcloud') || hasCmd(signals, 'az') || hasDir(signals, '.kube') || hasDir(signals, '.aws') || hasDir(signals, '.config/gcloud') || hasDir(signals, '.azure')) {
    categories.push('devops');
  }

  // Data scientist
  if (hasCmd(signals, 'jupyter') || hasCmd(signals, 'conda') || hasDir(signals, '.jupyter') || hasDir(signals, '.conda') || hasDir(signals, 'anaconda3') || hasDir(signals, 'miniconda3') || hasCmd(signals, 'R') || hasCmd(signals, 'Rscript') || hasEnv(signals, 'CONDA_DEFAULT_ENV')) {
    categories.push('data-scientist');
  }

  // ML engineer
  if (hasDir(signals, '.cache/huggingface') || hasEnv(signals, 'HF_TOKEN') || hasEnv(signals, 'CUDA_HOME') || hasEnv(signals, 'CUDA_VISIBLE_DEVICES')) {
    categories.push('ml-engineer');
  }

  // 3D artist
  if (hasCmd(signals, 'blender') || hasDir(signals, '.config/blender') || hasApp(signals, 'Blender') || hasApp(signals, 'Unity') || hasApp(signals, 'Unreal') || hasApp(signals, 'Godot')) {
    categories.push('3d-artist');
  }

  // Video editor
  if (hasCmd(signals, 'ffmpeg') || hasApp(signals, 'Premiere') || hasApp(signals, 'DaVinci') || hasDir(signals, '.config/obs-studio')) {
    categories.push('video-editor');
  }

  // Audio producer
  if (hasApp(signals, 'Logic Pro') || hasApp(signals, 'Ableton')) {
    categories.push('audio-producer');
  }

  // Designer
  if (hasApp(signals, 'Figma') || hasApp(signals, 'Sketch') || hasCmd(signals, 'inkscape')) {
    categories.push('designer');
  }

  // CAD engineer
  if (hasApp(signals, 'AutoCAD') || hasApp(signals, 'Fusion') || hasApp(signals, 'FreeCAD') || hasApp(signals, 'KiCad') || hasCmd(signals, 'freecad') || hasCmd(signals, 'openscad')) {
    categories.push('cad-engineer');
  }

  // Academic researcher
  if (hasCmd(signals, 'latex') || hasCmd(signals, 'pdflatex') || hasCmd(signals, 'matlab') || hasApp(signals, 'MATLAB') || hasApp(signals, 'RStudio') || hasApp(signals, 'Zotero')) {
    categories.push('academic-researcher');
  }

  // Business professional (Office apps without dev tools)
  if (hasApp(signals, 'Microsoft Word') || hasApp(signals, 'Microsoft Excel') || hasApp(signals, 'Microsoft PowerPoint')) {
    categories.push('business-professional');
  }

  // AI enthusiast
  if (hasCmd(signals, 'ollama') || hasCmd(signals, 'claude') || hasCmd(signals, 'aider') || hasDir(signals, '.ollama') || hasDir(signals, '.claude') || hasDir(signals, '.cache/lm-studio') || hasApp(signals, 'LM Studio') || hasApp(signals, 'GPT4All') || hasApp(signals, 'Jan')) {
    categories.push('ai-enthusiast');
  }

  // Game developer
  if (hasApp(signals, 'Unity') || hasApp(signals, 'Unreal') || hasApp(signals, 'Godot')) {
    categories.push('game-developer');
  }

  return categories;
}

// ============================================================================
// Provider Detection
// ============================================================================

function detectProviders(signals: EnvironmentDetectionResult): string[] {
  const providers: string[] = [];

  if (hasEnv(signals, 'OPENAI_API_KEY')) {
    providers.push('openai-key');
  }
  if (hasEnv(signals, 'ANTHROPIC_API_KEY')) {
    providers.push('anthropic-key');
  }
  if (hasEnv(signals, 'OPENROUTER_API_KEY')) {
    providers.push('openrouter-key');
  }
  if (hasEnv(signals, 'GROQ_API_KEY')) {
    providers.push('groq-key');
  }
  if (hasEnv(signals, 'DEEPSEEK_API_KEY')) {
    providers.push('deepseek-key');
  }
  if (hasCmd(signals, 'ollama') || hasDir(signals, '.ollama')) {
    providers.push('ollama');
  }
  if (
    hasCmd(signals, 'lms') ||
    hasCmd(signals, 'lmstudio') ||
    hasDir(signals, '.cache/lm-studio') ||
    hasDir(signals, '.lmstudio') ||
    hasApp(signals, 'LM Studio')
  ) {
    providers.push('lmstudio');
  }
  if (hasCmd(signals, 'claude') || hasDir(signals, '.claude')) {
    providers.push('claude-cli');
  }

  return providers;
}

// ============================================================================
// Tool Detection
// ============================================================================

function detectTools(signals: EnvironmentDetectionResult): DerivedPersona['detectedTools'] {
  return {
    has_claude_cli: hasCmd(signals, 'claude') || hasDir(signals, '.claude'),
    has_ollama: hasCmd(signals, 'ollama') || hasDir(signals, '.ollama'),
    has_lmstudio:
      hasCmd(signals, 'lms') ||
      hasCmd(signals, 'lmstudio') ||
      hasDir(signals, '.cache/lm-studio') ||
      hasDir(signals, '.lmstudio') ||
      hasApp(signals, 'LM Studio'),
    has_cursor: hasCmd(signals, 'cursor') || hasDir(signals, '.cursor'),
    has_vscode: hasCmd(signals, 'code') || hasDir(signals, '.vscode'),
  };
}

// ============================================================================
// Bucket Derivation
// ============================================================================

function deriveBucket(signals: EnvironmentDetectionResult): { bucket: PersonaBucket; confident: boolean } {
  // Count dev tool signals
  const devCommands = [
    'node', 'npm', 'yarn', 'pnpm', 'bun', 'deno',
    'python3', 'python', 'pip',
    'go', 'rustc', 'cargo',
    'java', 'javac',
    'ruby', 'php',
    'gcc', 'clang',
    'dotnet', 'swift',
    'flutter', 'dart',
    'git',
  ];
  const devCommandCount = devCommands.filter(cmd => hasCmd(signals, cmd)).length;

  // Count local AI signals
  const hasLocalAi =
    hasCmd(signals, 'ollama') ||
    hasCmd(signals, 'lms') ||
    hasCmd(signals, 'lmstudio') ||
    hasDir(signals, '.ollama') ||
    hasDir(signals, '.lmstudio') ||
    hasDir(signals, '.cache/lm-studio') ||
    hasDir(signals, '.cache/huggingface') ||
    hasApp(signals, 'LM Studio') ||
    hasApp(signals, 'GPT4All') ||
    hasApp(signals, 'Jan') ||
    hasEnv(signals, 'CUDA_HOME') ||
    hasEnv(signals, 'CUDA_VISIBLE_DEVICES');

  // Dev config dirs as additional signal
  const devDirs = ['.vscode', '.docker', '.kube', '.aws', '.cargo', '.rustup', '.pyenv', '.conda'];
  const devDirCount = devDirs.filter(dir => hasDir(signals, dir)).length;

  const hasGit = hasCmd(signals, 'git') || hasDir(signals, '.gitconfig');
  const hasSsh = hasDir(signals, '.ssh');

  const totalDevSignals = devCommandCount + devDirCount + (hasGit ? 1 : 0) + (hasSsh ? 1 : 0);

  // Bucket determination
  if (totalDevSignals >= 3 && hasLocalAi) {
    return { bucket: 'developer-local-ai', confident: true };
  }

  if (totalDevSignals >= 3) {
    return { bucket: 'developer', confident: true };
  }

  // Weak signal: a few dev tools but not enough to be confident
  if (totalDevSignals >= 1) {
    // Has some tools, but not enough to be confident
    return { bucket: 'developer', confident: false };
  }

  // No dev tools at all
  if (totalDevSignals === 0) {
    return { bucket: 'non-developer', confident: true };
  }

  // Fallback - not confident
  return { bucket: 'non-developer', confident: false };
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Derive a user persona from raw environment detection signals.
 *
 * Returns:
 * - bucket: primary category (non-developer / developer / developer-local-ai)
 * - subCategories: fine-grained categories for personalization
 * - detectedProviders: API key providers found
 * - detectedTools: specific tool integrations found
 * - confident: whether to skip the fallback bucket question
 */
export function derivePersona(signals: EnvironmentDetectionResult): DerivedPersona {
  const { bucket, confident } = deriveBucket(signals);
  const subCategories = detectSubCategories(signals);
  const detectedProviders = detectProviders(signals);
  const detectedTools = detectTools(signals);

  // Compute signal counts for debugging
  const devCommands = ['node', 'npm', 'yarn', 'pnpm', 'bun', 'deno', 'python3', 'python', 'pip', 'go', 'rustc', 'cargo', 'java', 'javac', 'ruby', 'php', 'gcc', 'clang', 'dotnet', 'swift', 'flutter', 'dart', 'git'];
  const aiToolsList = ['ollama', 'lms', 'lmstudio', 'claude', 'aider', 'cursor'];
  const creativeList = ['blender', 'ffmpeg', 'inkscape', 'gimp', 'freecad', 'openscad'];

  const signalCounts = {
    devCommands: devCommands.filter(cmd => hasCmd(signals, cmd)).length,
    aiTools: aiToolsList.filter(cmd => hasCmd(signals, cmd)).length,
    creativeTools: creativeList.filter(cmd => hasCmd(signals, cmd)).length,
    totalSignals: Object.values(signals.commands).filter(Boolean).length +
                  Object.values(signals.configDirs).filter(Boolean).length +
                  signals.applications.length +
                  Object.values(signals.envVars).filter(Boolean).length,
  };

  return {
    bucket,
    subCategories,
    detectedProviders,
    detectedTools,
    confident,
    signalCounts,
  };
}
