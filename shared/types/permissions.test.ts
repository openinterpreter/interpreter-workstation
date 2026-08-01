import { describe, test, expect } from 'bun:test';
import {
  toRuntimeFileAccessPolicy,
  toStorageFileAccessPolicy,
  type FileAccessPolicyData,
  type FileAccessPolicy,
} from './permissions';

describe('toRuntimeFileAccessPolicy', () => {
  test('converts Record customPaths to Map', () => {
    const data: FileAccessPolicyData = {
      system: 'read',
      workspace: 'write',
      customPaths: { '/tmp': 'read', '/home': 'write' },
    };

    const result = toRuntimeFileAccessPolicy(data);

    expect(result.customPaths).toBeInstanceOf(Map);
    expect(result.customPaths.get('/tmp')).toBe('read');
    expect(result.customPaths.get('/home')).toBe('write');
    expect(result.customPaths.size).toBe(2);
  });

  test('handles empty customPaths', () => {
    const data: FileAccessPolicyData = {
      system: 'none',
      workspace: 'read',
      customPaths: {},
    };

    const result = toRuntimeFileAccessPolicy(data);

    expect(result.customPaths).toBeInstanceOf(Map);
    expect(result.customPaths.size).toBe(0);
  });

  test('handles undefined customPaths', () => {
    const data = {
      system: 'read',
      workspace: 'write',
      customPaths: undefined,
    } as unknown as FileAccessPolicyData;

    const result = toRuntimeFileAccessPolicy(data);

    expect(result.customPaths).toBeInstanceOf(Map);
    expect(result.customPaths.size).toBe(0);
  });

  test('handles null customPaths', () => {
    const data = {
      system: 'read',
      workspace: 'write',
      customPaths: null,
    } as unknown as FileAccessPolicyData;

    const result = toRuntimeFileAccessPolicy(data);

    expect(result.customPaths).toBeInstanceOf(Map);
    expect(result.customPaths.size).toBe(0);
  });

  test('preserves system and workspace levels', () => {
    const data: FileAccessPolicyData = {
      system: 'none',
      workspace: 'write',
      customPaths: {},
    };

    const result = toRuntimeFileAccessPolicy(data);

    expect(result.system).toBe('none');
    expect(result.workspace).toBe('write');
  });
});

describe('toStorageFileAccessPolicy', () => {
  test('converts Map customPaths to Record', () => {
    const runtime: FileAccessPolicy = {
      system: 'read',
      workspace: 'write',
      customPaths: new Map([
        ['/tmp', 'read'],
        ['/home', 'write'],
      ]),
    };

    const result = toStorageFileAccessPolicy(runtime);

    expect(result.customPaths).toEqual({ '/tmp': 'read', '/home': 'write' });
    expect(result.customPaths).not.toBeInstanceOf(Map);
  });

  test('passes through already-storage format', () => {
    const data: FileAccessPolicyData = {
      system: 'read',
      workspace: 'write',
      customPaths: { '/tmp': 'none' },
    };

    const result = toStorageFileAccessPolicy(data);

    expect(result).toBe(data);
  });

  test('handles empty Map', () => {
    const runtime: FileAccessPolicy = {
      system: 'read',
      workspace: 'write',
      customPaths: new Map(),
    };

    const result = toStorageFileAccessPolicy(runtime);

    expect(result.customPaths).toEqual({});
  });
});

describe('round-trip', () => {
  test('toStorageFileAccessPolicy(toRuntimeFileAccessPolicy(data)) equals original', () => {
    const original: FileAccessPolicyData = {
      system: 'none',
      workspace: 'write',
      customPaths: { '/usr': 'read', '/var/log': 'none' },
    };

    const result = toStorageFileAccessPolicy(toRuntimeFileAccessPolicy(original));

    expect(result).toEqual(original);
  });
});
