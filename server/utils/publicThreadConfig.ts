import { readFileSync } from 'node:fs';

const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

export function resolvePublicThreadId(
  environment: NodeJS.ProcessEnv = process.env,
  readFile: (path: string, encoding: BufferEncoding) => string = readFileSync,
): string | undefined {
  const configured = environment.INTERPRETER_PUBLIC_THREAD_ID?.trim();
  if (configured) {
    return THREAD_ID_PATTERN.test(configured) ? configured : undefined;
  }

  const configuredFile = environment.INTERPRETER_PUBLIC_THREAD_ID_FILE?.trim();
  if (!configuredFile) {
    return undefined;
  }

  try {
    const threadId = readFile(configuredFile, 'utf8').trim();
    return THREAD_ID_PATTERN.test(threadId) ? threadId : undefined;
  } catch {
    return undefined;
  }
}
