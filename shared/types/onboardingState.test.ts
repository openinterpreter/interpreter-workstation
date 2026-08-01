import { describe, expect, test } from 'bun:test';
import {
  buildOnboardingCustomInstructionsDraft,
  buildOnboardingImportedToolSummary,
  buildOnboardingInterviewResult,
  createDefaultOnboardingState,
  markOnboardingStepIdComplete,
  mergeOnboardingImportedToolSummary,
  ONBOARDING_OVERLAY_FIRST_SUCCESS_STEP_ID,
  parseOnboardingInterviewDraft,
} from './onboardingState';

describe('onboarding state', () => {
  test('defaults to no interview result or custom-instructions draft', () => {
    const state = createDefaultOnboardingState();

    expect(state.interviewDraft).toBe('');
    expect(state.interviewResult).toBeNull();
  });

  test('marks onboarding milestones without duplicating completed step ids', () => {
    const state = createDefaultOnboardingState();
    const first = markOnboardingStepIdComplete(state, ONBOARDING_OVERLAY_FIRST_SUCCESS_STEP_ID);
    const second = markOnboardingStepIdComplete(first, ONBOARDING_OVERLAY_FIRST_SUCCESS_STEP_ID);

    expect(first.completedStepIds).toEqual([ONBOARDING_OVERLAY_FIRST_SUCCESS_STEP_ID]);
    expect(second.completedStepIds).toEqual([ONBOARDING_OVERLAY_FIRST_SUCCESS_STEP_ID]);
  });

  test('builds a reviewable custom-instructions draft from interview output', () => {
    expect(buildOnboardingCustomInstructionsDraft({
      summary: ' Uses local models for code and cloud models for planning. ',
      modelPreferences: ['local-first for private code', '  fast cloud for broad research  ', ''],
      workingPreferences: ['ask before broad edits', 'keep changes simple'],
    })).toBe([
      'Onboarding summary: Uses local models for code and cloud models for planning.',
      'Model preference: local-first for private code',
      'Model preference: fast cloud for broad research',
      'Working preference: ask before broad edits',
      'Working preference: keep changes simple',
    ].join('\n'));
  });

  test('does not fabricate interview output from blank answers', () => {
    expect(buildOnboardingInterviewResult({
      modelsUsed: '  ',
      aiUseToday: '',
      currentSetup: '\n',
    }, '2026-06-22T00:00:00.000Z')).toEqual({
      interviewDraft: '',
      interviewResult: null,
    });
  });

  test('builds structured interview output from onboarding answers', () => {
    expect(buildOnboardingInterviewResult({
      modelsUsed: 'GPT-5, Claude\nOllama',
      aiUseToday: 'coding and research',
      currentSetup: 'ChatGPT plus local Ollama',
    }, '2026-06-22T00:00:00.000Z')).toEqual({
      interviewDraft: [
        'Models used now:',
        'GPT-5, Claude\nOllama',
        '',
        'How I use AI today:',
        'coding and research',
        '',
        'Current AI setup:',
        'ChatGPT plus local Ollama',
      ].join('\n'),
      interviewResult: {
        summary: 'Models used now: GPT-5, Claude Ollama. AI use today: coding and research. Current AI setup: ChatGPT plus local Ollama.',
        modelPreferences: [
          'Currently uses GPT-5',
          'Currently uses Claude',
          'Currently uses Ollama',
        ],
        workingPreferences: [
          'AI use today: coding and research',
          'Current AI setup: ChatGPT plus local Ollama',
        ],
        customInstructionsDraft: [
          'Onboarding summary: Models used now: GPT-5, Claude Ollama. AI use today: coding and research. Current AI setup: ChatGPT plus local Ollama.',
          'Model preference: Currently uses GPT-5',
          'Model preference: Currently uses Claude',
          'Model preference: Currently uses Ollama',
          'Working preference: AI use today: coding and research',
          'Working preference: Current AI setup: ChatGPT plus local Ollama',
        ].join('\n'),
        updatedAt: '2026-06-22T00:00:00.000Z',
      },
    });
  });

  test('parses the current interview draft format back into answers', () => {
    const draft = [
      'Models used now:',
      'GPT-5, Claude',
      'Ollama',
      '',
      'How I use AI today:',
      'coding and research',
      '',
      'Current AI setup:',
      'ChatGPT plus local Ollama',
    ].join('\n');

    expect(parseOnboardingInterviewDraft(draft)).toEqual({
      modelsUsed: 'GPT-5, Claude\nOllama',
      aiUseToday: 'coding and research',
      currentSetup: 'ChatGPT plus local Ollama',
    });
  });

  test('builds a redacted imported tool summary from detected local AI markers', () => {
    expect(buildOnboardingImportedToolSummary({
      detectedProviders: ['openai-key', 'ollama', 'claude-cli'],
      detectedTools: ['claude', 'claude-cli', 'codex', 'cursor', 'unknown-tool'],
      detectedConfigDirs: ['.claude', '.cursor', '.ssh', '.cache/huggingface'],
      detectedApps: ['LM Studio.app', 'Slack.app'],
      generatedAt: '2026-06-22T00:00:00.000Z',
    })).toEqual({
      generatedAt: '2026-06-22T00:00:00.000Z',
      sources: [
        'detected-providers',
        'detected-tools',
        'detected-config-markers',
        'detected-apps',
      ],
      summary: [
        'Provider markers: OpenAI API key marker, Ollama, Claude CLI.',
        'Detected tools: Claude CLI, Interpreter CLI command marker, Cursor.',
        'Local config markers: Claude CLI config marker, Cursor config marker, Hugging Face model cache marker.',
        'Detected apps: LM Studio app.',
      ].join(' '),
    });
  });

  test('does not stamp imported tool summary when no relevant local AI markers are detected', () => {
    expect(buildOnboardingImportedToolSummary({
      detectedProviders: [],
      detectedTools: ['git', 'python3'],
      detectedConfigDirs: ['.ssh', '.aws'],
      detectedApps: ['Slack.app'],
      generatedAt: '2026-06-22T00:00:00.000Z',
    })).toEqual({
      generatedAt: null,
      sources: [],
      summary: '',
    });
  });

  test('summarizes discovered MCP configs without env, args, headers, or paths', () => {
    expect(buildOnboardingImportedToolSummary({
      detectedProviders: [],
      detectedTools: [],
      detectedConfigDirs: [],
      detectedApps: [],
      discoveredMcps: [
        { name: 'GitHub', source: 'claude-code', transport: 'stdio' },
        { name: 'Linear', source: 'cursor', transport: 'http' },
        { name: 'GitHub', source: 'claude-code', transport: 'stdio' },
      ],
      generatedAt: '2026-06-22T00:00:00.000Z',
    })).toEqual({
      generatedAt: '2026-06-22T00:00:00.000Z',
      sources: ['discovered-mcp-configs'],
      summary: 'Importable MCP servers: GitHub (Claude Code, stdio), Linear (Cursor, http).',
    });
  });

  test('merges imported tool summary additions without duplicating repeated discovery', () => {
    const base = {
      generatedAt: '2026-06-22T00:00:00.000Z',
      sources: ['detected-tools'],
      summary: 'Detected tools: Claude CLI.',
    };
    const addition = {
      generatedAt: '2026-06-22T00:01:00.000Z',
      sources: ['discovered-mcp-configs'],
      summary: 'Importable MCP servers: GitHub (Claude Code, stdio).',
    };
    const merged = mergeOnboardingImportedToolSummary(base, addition);

    expect(merged).toEqual({
      generatedAt: '2026-06-22T00:01:00.000Z',
      sources: ['detected-tools', 'discovered-mcp-configs'],
      summary: 'Detected tools: Claude CLI. Importable MCP servers: GitHub (Claude Code, stdio).',
    });
    expect(mergeOnboardingImportedToolSummary(merged, addition)).toEqual({
      ...merged,
      generatedAt: '2026-06-22T00:01:00.000Z',
    });
  });
});
