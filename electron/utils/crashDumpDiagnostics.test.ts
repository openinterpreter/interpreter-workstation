import { describe, expect, test } from 'bun:test';

import { formatTelemetrySettingState, listCrashDumpBasenamesForLog } from './crashDumpDiagnostics';

describe('formatTelemetrySettingState', () => {
  test('maps telemetry setting states', () => {
    expect(formatTelemetrySettingState(true)).toBe('enabled');
    expect(formatTelemetrySettingState(false)).toBe('disabled');
    expect(formatTelemetrySettingState(null)).toBe('unset');
  });
});

describe('listCrashDumpBasenamesForLog', () => {
  test('returns comma-separated basenames and caps list length', () => {
    expect(listCrashDumpBasenamesForLog([
      '/tmp/a.dmp',
      '/tmp/b.dmp',
      '/tmp/c.dmp',
      '/tmp/d.dmp',
      '/tmp/e.dmp',
      '/tmp/f.dmp',
    ])).toBe('a.dmp,b.dmp,c.dmp,d.dmp,e.dmp');
  });
});
