import { describe, expect, test } from 'bun:test';

import { buildFeedbackLogAttachment } from './feedbackLogAttachment';

describe('buildFeedbackLogAttachment', () => {
  test('records missing runtime log path details and nearby log file names when no active log path is known', async () => {
    const attachment = await buildFeedbackLogAttachment({
      logFilePath: null,
      logsDir: '/tmp/custom-log-path/logs',
      metadata: { ok: true },
      extraLogFiles: [
        {
          filePath: '/tmp/custom-log-path/logs/browser-extension-relay.log',
          label: 'browser_extension_relay_log',
        },
      ],
      readTextFile: async (filePath) => {
        if (filePath === '/tmp/custom-log-path/logs/browser-extension-relay.log') {
          return 'relay line 1\n';
        }
        throw new Error(`Unexpected file read: ${filePath}`);
      },
      listFiles: async () => ['session-a.log', 'session-b.log', 'notes.txt'],
    });

    expect(attachment).toEqual({
      filename: 'feedback-log-diagnostic.log',
      content: [
        '[FEEDBACK_LOG_LOOKUP] No active runtime log file path is known.',
        '[FEEDBACK_LOG_LOOKUP] logs_dir=/tmp/custom-log-path/logs',
        '[FEEDBACK_LOG_LOOKUP] logs_dir_file_names=["session-a.log","session-b.log"]',
        '',
        '<attached_log label="browser_extension_relay_log" path="/tmp/custom-log-path/logs/browser-extension-relay.log">',
        'relay line 1',
        '</attached_log>',
        '',
        '<feedback_metadata_dump>',
        '{"ok":true,"feedbackLogLookup":{"activeRuntimeLogFilePath":null,"logsDir":"/tmp/custom-log-path/logs","logsDirFileNames":["session-a.log","session-b.log"],"reason":"missing_active_runtime_log_path"}}',
        '</feedback_metadata_dump>',
        '',
      ].join('\n'),
    });
  });

  test('records the expected location and nearby log file names when the active runtime log is empty', async () => {
    const attachment = await buildFeedbackLogAttachment({
      logFilePath: '/tmp/custom-log-path/current-session.log',
      logsDir: '/tmp/custom-log-path/logs',
      metadata: { ok: true },
      readTextFile: async () => '',
      listFiles: async () => ['older-session.log'],
    });

    expect(attachment).toEqual({
      filename: 'current-session.log',
      content: [
        '[FEEDBACK_LOG_LOOKUP] Runtime log file was empty at location /tmp/custom-log-path/current-session.log.',
        '[FEEDBACK_LOG_LOOKUP] logs_dir=/tmp/custom-log-path/logs',
        '[FEEDBACK_LOG_LOOKUP] logs_dir_file_names=["older-session.log"]',
        '',
        '<feedback_metadata_dump>',
        '{"ok":true,"feedbackLogLookup":{"activeRuntimeLogFilePath":"/tmp/custom-log-path/current-session.log","logsDir":"/tmp/custom-log-path/logs","logsDirFileNames":["older-session.log"],"reason":"empty_runtime_log_file"}}',
        '</feedback_metadata_dump>',
        '',
      ].join('\n'),
    });
  });

  test('appends metadata to the active runtime log file instead of scanning a default logs directory', async () => {
    const attachment = await buildFeedbackLogAttachment({
      logFilePath: '/tmp/custom-log-path/current-session.log',
      logsDir: '/tmp/custom-log-path/logs',
      metadata: { ok: true },
      readTextFile: async (filePath) => {
        expect(filePath).toBe('/tmp/custom-log-path/current-session.log');
        return 'line 1\nline 2\n';
      },
    });

    expect(attachment).toEqual({
      filename: 'current-session.log',
      content: 'line 1\nline 2\n\n<feedback_metadata_dump>\n{"ok":true}\n</feedback_metadata_dump>\n',
    });
  });

  test('appends extra relay logs into the single uploaded feedback log artifact', async () => {
    const attachment = await buildFeedbackLogAttachment({
      logFilePath: '/tmp/custom-log-path/current-session.log',
      logsDir: '/tmp/custom-log-path/logs',
      metadata: { ok: true },
      extraLogFiles: [
        {
          filePath: '/tmp/custom-log-path/logs/browser-extension-relay.log',
          label: 'browser_extension_relay_log',
        },
        {
          filePath: '/tmp/custom-log-path/logs/browser-extension-relay-cdp.jsonl',
          label: 'browser_extension_relay_cdp_log',
        },
      ],
      readTextFile: async (filePath) => {
        if (filePath === '/tmp/custom-log-path/current-session.log') {
          return 'session line 1\n';
        }
        if (filePath === '/tmp/custom-log-path/logs/browser-extension-relay.log') {
          return 'relay line 1\nrelay line 2\n';
        }
        if (filePath === '/tmp/custom-log-path/logs/browser-extension-relay-cdp.jsonl') {
          return '{"event":"attached"}\n';
        }
        throw new Error(`Unexpected file read: ${filePath}`);
      },
    });

    expect(attachment).toEqual({
      filename: 'current-session.log',
      content: [
        'session line 1',
        '',
        '<attached_log label="browser_extension_relay_log" path="/tmp/custom-log-path/logs/browser-extension-relay.log">',
        'relay line 1',
        'relay line 2',
        '</attached_log>',
        '',
        '<attached_log label="browser_extension_relay_cdp_log" path="/tmp/custom-log-path/logs/browser-extension-relay-cdp.jsonl">',
        '{"event":"attached"}',
        '</attached_log>',
        '',
        '<feedback_metadata_dump>',
        '{"ok":true}',
        '</feedback_metadata_dump>',
        '',
      ].join('\n'),
    });
  });

  test('records missing extra relay logs without dropping the main session log', async () => {
    const attachment = await buildFeedbackLogAttachment({
      logFilePath: '/tmp/custom-log-path/current-session.log',
      logsDir: '/tmp/custom-log-path/logs',
      metadata: { ok: true },
      extraLogFiles: [
        {
          filePath: '/tmp/custom-log-path/logs/browser-extension-relay.log',
          label: 'browser_extension_relay_log',
        },
      ],
      readTextFile: async (filePath) => {
        if (filePath === '/tmp/custom-log-path/current-session.log') {
          return 'session line 1\n';
        }
        throw new Error(`ENOENT: ${filePath}`);
      },
    });

    expect(attachment).toEqual({
      filename: 'current-session.log',
      content: [
        'session line 1',
        '',
        '<attached_log label="browser_extension_relay_log" path="/tmp/custom-log-path/logs/browser-extension-relay.log" error="ENOENT: /tmp/custom-log-path/logs/browser-extension-relay.log" />',
        '',
        '<feedback_metadata_dump>',
        '{"ok":true}',
        '</feedback_metadata_dump>',
        '',
      ].join('\n'),
    });
  });
});
