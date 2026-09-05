import { afterEach, describe, expect, test } from 'bun:test';

import {
  buildProgrammaticTaskRuntimeConfig,
  getWorkstationHostingError,
  parseCliOptions,
} from './standaloneOptions';

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  }
});

describe('standaloneOptions', () => {
  test('inherits existing config by default', () => {
    const options = parseCliOptions(['--message', 'read notes']);
    const runtimeConfig = buildProgrammaticTaskRuntimeConfig(options);

    expect(runtimeConfig.codexApprovalPolicy).toBeUndefined();
    expect(runtimeConfig.codexSandboxMode).toBeUndefined();
    expect(runtimeConfig.codexNetworkAccess).toBeUndefined();
    expect(runtimeConfig.defaultProfile).toBeUndefined();
  });

  test('builds an explicit programmatic profile only when model overrides are passed', () => {
    process.env.OPENAI_API_KEY = 'sk-test';

    const options = parseCliOptions([
      '--message',
      'read notes',
      '--model',
      'gpt-5.4-mini',
    ]);
    const runtimeConfig = buildProgrammaticTaskRuntimeConfig(options);

    expect(runtimeConfig.defaultProfile).toEqual({
      id: 'programmatic:headless-openai-api',
      name: 'Headless OpenAI API',
      provider: 'api',
      modelId: 'gpt-5.4-mini',
      apiKey: 'sk-test',
      baseURL: 'https://api.openai.com/v1',
      apiFormat: 'openai',
      codexProfileId: 'openai-api',
      wireApi: 'responses',
      useResponsesApi: true,
    });
  });

  test('keeps explicit runtime overrides explicit', () => {
    const options = parseCliOptions([
      '--message',
      'read notes',
      '--approval-policy',
      'never',
      '--sandbox',
      'danger-full-access',
      '--no-network-access',
    ]);
    const runtimeConfig = buildProgrammaticTaskRuntimeConfig(options);

    expect(runtimeConfig.codexApprovalPolicy).toBe('never');
    expect(runtimeConfig.codexSandboxMode).toBe('danger-full-access');
    expect(runtimeConfig.codexNetworkAccess).toBe(false);
  });

  test('parses dev auto-approve tool sidecar mode', () => {
    const options = parseCliOptions([
      '--',
      '--port',
      'auto',
      '--quiet-startup',
      '--stream-jsonl',
      '--dev-auto-approve-tools',
    ]);

    expect(options.port).toBe('auto');
    expect(options.quietStartup).toBe(true);
    expect(options.streamJsonl).toBe(true);
    expect(options.devAutoApproveTools).toBe(true);
  });

  test('parses an explicitly hosted Workstation bridge', () => {
    const options = parseCliOptions([
      '--host',
      '0.0.0.0',
      '--access',
      'read-write',
      '--auth',
      'password',
    ]);

    expect(options.host).toBe('0.0.0.0');
    expect(options.workstationAccess).toBe('read-write');
    expect(options.workstationAuth).toBe('password');
  });

  test('keeps loopback development available without remote host settings', () => {
    expect(getWorkstationHostingError(parseCliOptions([]))).toBeNull();
  });

  test('requires explicit access and password authentication beyond loopback', () => {
    expect(getWorkstationHostingError(parseCliOptions(['--host', '0.0.0.0']))).toContain('--access');
    expect(getWorkstationHostingError(parseCliOptions([
      '--host', '0.0.0.0',
      '--access', 'read-only',
      '--auth', 'none',
    ]))).toContain('--auth password');
    expect(getWorkstationHostingError(parseCliOptions([
      '--host', '0.0.0.0',
      '--access', 'read-only',
      '--auth', 'password',
    ]))).toBeNull();
  });
});
