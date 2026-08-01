import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { appendFeedbackMetadataDump } from './feedbackMetadata';

export type FeedbackLogAttachment = {
  filename: string;
  content: string;
};

export type ExtraFeedbackLogFile = {
  filePath: string;
  label: string;
};

type BuildFeedbackLogAttachmentOptions = {
  logFilePath: string | null;
  logsDir: string | null;
  metadata: unknown;
  extraLogFiles?: ExtraFeedbackLogFile[];
  readTextFile?: (filePath: string, encoding: BufferEncoding) => Promise<string>;
  listFiles?: (dir: string) => Promise<string[]>;
};

type FeedbackLogLookup = {
  activeRuntimeLogFilePath: string | null;
  logsDir: string | null;
  logsDirFileNames: string[];
  logsDirError?: string;
  reason: 'missing_active_runtime_log_path' | 'missing_runtime_log_file' | 'empty_runtime_log_file';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeFeedbackLogLookup(metadata: unknown, feedbackLogLookup: FeedbackLogLookup): unknown {
  if (!isRecord(metadata)) {
    return {
      feedbackMetadata: metadata,
      feedbackLogLookup,
    };
  }

  return {
    ...metadata,
    feedbackLogLookup,
  };
}

function formatFeedbackLogLookupMessage(feedbackLogLookup: FeedbackLogLookup): string {
  const lines: string[] = [];

  if (feedbackLogLookup.reason === 'missing_active_runtime_log_path') {
    lines.push('[FEEDBACK_LOG_LOOKUP] No active runtime log file path is known.');
  } else if (feedbackLogLookup.reason === 'missing_runtime_log_file') {
    lines.push(`[FEEDBACK_LOG_LOOKUP] No log file found at location ${feedbackLogLookup.activeRuntimeLogFilePath}.`);
  } else {
    lines.push(`[FEEDBACK_LOG_LOOKUP] Runtime log file was empty at location ${feedbackLogLookup.activeRuntimeLogFilePath}.`);
  }

  if (feedbackLogLookup.logsDir) {
    lines.push(`[FEEDBACK_LOG_LOOKUP] logs_dir=${feedbackLogLookup.logsDir}`);
  }

  lines.push(`[FEEDBACK_LOG_LOOKUP] logs_dir_file_names=${JSON.stringify(feedbackLogLookup.logsDirFileNames)}`);

  if (feedbackLogLookup.logsDirError) {
    lines.push(`[FEEDBACK_LOG_LOOKUP] logs_dir_error=${feedbackLogLookup.logsDirError}`);
  }

  return lines.join('\n');
}

function escapeTagAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function buildExtraLogSections(
  extraLogFiles: ExtraFeedbackLogFile[],
  readTextFile: (filePath: string, encoding: BufferEncoding) => Promise<string>,
): Promise<string[]> {
  const sections: string[] = [];

  for (const extraLogFile of extraLogFiles) {
    try {
      const content = (await readTextFile(extraLogFile.filePath, 'utf-8')).trimEnd();
      if (!content) {
        continue;
      }

      sections.push(
        [
          `<attached_log label="${escapeTagAttribute(extraLogFile.label)}" path="${escapeTagAttribute(extraLogFile.filePath)}">`,
          content,
          '</attached_log>',
        ].join('\n'),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sections.push(
        `<attached_log label="${escapeTagAttribute(extraLogFile.label)}" path="${escapeTagAttribute(extraLogFile.filePath)}" error="${escapeTagAttribute(message)}" />`,
      );
    }
  }

  return sections;
}

async function listLogFileNames(
  logsDir: string | null,
  listFiles: (dir: string) => Promise<string[]>,
): Promise<{ fileNames: string[]; error?: string }> {
  if (!logsDir) {
    return { fileNames: [] };
  }

  try {
    const fileNames = await listFiles(logsDir);
    return {
      fileNames: fileNames.filter(fileName => fileName.endsWith('.log')).sort(),
    };
  } catch (error) {
    return {
      fileNames: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function buildFeedbackLogAttachment({
  logFilePath,
  logsDir,
  metadata,
  extraLogFiles = [],
  readTextFile = readFile,
  listFiles = readdir,
}: BuildFeedbackLogAttachmentOptions): Promise<FeedbackLogAttachment | null> {
  const extraLogSections = await buildExtraLogSections(extraLogFiles, readTextFile);

  if (!logFilePath) {
    const logLookupList = await listLogFileNames(logsDir, listFiles);
    const feedbackLogLookup: FeedbackLogLookup = {
      activeRuntimeLogFilePath: null,
      logsDir,
      logsDirFileNames: logLookupList.fileNames,
      logsDirError: logLookupList.error,
      reason: 'missing_active_runtime_log_path',
    };

    return {
      filename: 'feedback-log-diagnostic.log',
      content: appendFeedbackMetadataDump(
        [
          formatFeedbackLogLookupMessage(feedbackLogLookup),
          ...extraLogSections,
        ].filter((section) => section.length > 0).join('\n\n'),
        mergeFeedbackLogLookup(metadata, feedbackLogLookup),
      ),
    };
  }

  try {
    const logContent = await readTextFile(logFilePath, 'utf-8');
    const combinedLogContent = [
      logContent.trimEnd(),
      ...extraLogSections,
    ].filter((section) => section.length > 0).join('\n\n');

    if (logContent.trimEnd() === '') {
      const logLookupList = await listLogFileNames(logsDir, listFiles);
      const feedbackLogLookup: FeedbackLogLookup = {
        activeRuntimeLogFilePath: logFilePath,
        logsDir,
        logsDirFileNames: logLookupList.fileNames,
        logsDirError: logLookupList.error,
        reason: 'empty_runtime_log_file',
      };

      return {
        filename: path.basename(logFilePath),
        content: appendFeedbackMetadataDump(
          [
            formatFeedbackLogLookupMessage(feedbackLogLookup),
            ...extraLogSections,
          ].filter((section) => section.length > 0).join('\n\n'),
          mergeFeedbackLogLookup(metadata, feedbackLogLookup),
        ),
      };
    }

    return {
      filename: path.basename(logFilePath),
      content: appendFeedbackMetadataDump(combinedLogContent, metadata),
    };
  } catch (error) {
    const logLookupList = await listLogFileNames(logsDir, listFiles);
    const feedbackLogLookup: FeedbackLogLookup = {
      activeRuntimeLogFilePath: logFilePath,
      logsDir,
      logsDirFileNames: logLookupList.fileNames,
      logsDirError: logLookupList.error ?? (error instanceof Error ? error.message : String(error)),
      reason: 'missing_runtime_log_file',
    };

    return {
      filename: path.basename(logFilePath),
      content: appendFeedbackMetadataDump(
        [
          formatFeedbackLogLookupMessage(feedbackLogLookup),
          ...extraLogSections,
        ].filter((section) => section.length > 0).join('\n\n'),
        mergeFeedbackLogLookup(metadata, feedbackLogLookup),
      ),
    };
  }
}
