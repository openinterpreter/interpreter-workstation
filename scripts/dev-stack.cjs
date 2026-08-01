const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE_VITE_PORT = Number(process.env.VITE_PORT || 5173);
const REDACTED = '[REDACTED]';
const NOISY_CHILD_OUTPUT_RULES = [];

function redactSensitiveText(text) {
  let redacted = text;

  redacted = redacted.replace(
    /((?:["'`]?)(?:api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|auth[_-]?token|oauth[_-]?token|authorization|client[_-]?secret|session[_-]?token|password|secret)(?:["'`]?)\s*[:=]\s*)(["'`]?)[^"'`,\s}\]]+\2/gi,
    (_match, prefix, quote) => `${prefix}${quote}${REDACTED}${quote}`,
  );

  redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, `Bearer ${REDACTED}`);
  redacted = redacted.replace(/\bsk-ant-[A-Za-z0-9_-]+\b/g, REDACTED);
  redacted = redacted.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, REDACTED);
  redacted = redacted.replace(/([?&](?:access_token|refresh_token|api_key|apikey|token)=)[^&\s]+/gi, `$1${REDACTED}`);

  return redacted;
}

function createSharedLogPath() {
  const configuredPath = process.env.LOG_FILE?.trim();
  if (configuredPath) {
    const resolvedPath = path.resolve(configuredPath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    return resolvedPath;
  }

  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const logDir = path.resolve(__dirname, '../logs');
  fs.mkdirSync(logDir, { recursive: true });
  return path.join(logDir, `session-${timestamp}.log`);
}

function writeLog(logFilePath, prefix, message) {
  const line = `[${new Date().toISOString()}] [${prefix}] ${redactSensitiveText(message)}\n`;
  try {
    fs.appendFileSync(logFilePath, line);
  } catch {
    // Best-effort dev logging only.
  }
}

function matchNoisyChildOutput(prefix, line) {
  return NOISY_CHILD_OUTPUT_RULES.find((rule) => (
    rule.prefix === prefix && rule.pattern.test(line)
  )) || null;
}

function createMirroredLineWriter(logFilePath, prefix) {
  let pendingSummary = null;

  const flushSummary = () => {
    if (!pendingSummary) return;
    writeLog(
      logFilePath,
      `${prefix}_SUMMARY`,
      `pattern=${pendingSummary.summary} count=${pendingSummary.count} firstAt=${pendingSummary.firstAt} lastAt=${pendingSummary.lastAt} sample=${JSON.stringify(pendingSummary.sample)}`,
    );
    pendingSummary = null;
  };

  const writeLine = (line) => {
    const matchedRule = matchNoisyChildOutput(prefix, line);
    if (!matchedRule) {
      flushSummary();
      writeLog(logFilePath, prefix, line);
      return;
    }

    const timestamp = new Date().toISOString();
    if (pendingSummary && pendingSummary.summary === matchedRule.summary) {
      pendingSummary.count += 1;
      pendingSummary.lastAt = timestamp;
      return;
    }

    flushSummary();
    pendingSummary = {
      summary: matchedRule.summary,
      count: 1,
      firstAt: timestamp,
      lastAt: timestamp,
      sample: line,
    };
  };

  return {
    writeLine,
    flushSummary,
  };
}

function attachOutputMirror(child, {
  label,
  logFilePath,
}) {
  const createMirror = (stream, targetStream, prefix) => {
    if (!stream) return () => {};

    let buffer = '';
    const mirroredLineWriter = createMirroredLineWriter(logFilePath, prefix);
    const flush = (includePartial = false) => {
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        mirroredLineWriter.writeLine(line);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
      }

      if (includePartial && buffer.length > 0) {
        mirroredLineWriter.writeLine(buffer.replace(/\r$/, ''));
        buffer = '';
      }

      if (includePartial) {
        mirroredLineWriter.flushSummary();
      }
    };

    stream.on('data', (chunk) => {
      targetStream.write(chunk);
      buffer += chunk.toString();
      flush(false);
    });

    return () => flush(true);
  };

  const flushStdout = createMirror(child.stdout, process.stdout, `${label}_STDOUT`);
  const flushStderr = createMirror(child.stderr, process.stderr, `${label}_STDERR`);

  child.on('close', () => {
    flushStdout();
    flushStderr();
  });
}

function getPnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

async function resolveVitePort() {
  const { default: getPort } = await import('get-port');
  return getPort({
    port: Array.from({ length: 21 }, (_, index) => BASE_VITE_PORT + index),
  });
}

function spawnManaged(command, args, extraEnv = {}, options = {}) {
  const stdinMode = options.stdin || (options.captureOutput ? 'ignore' : 'inherit');
  const child = spawn(command, args, {
    stdio: options.captureOutput ? [stdinMode, 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, ...extraEnv },
    // Windows cannot spawn pnpm.cmd directly without going through a shell.
    shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd'),
  });

  if (options.captureOutput && options.logFilePath && options.label) {
    attachOutputMirror(child, {
      label: options.label,
      logFilePath: options.logFilePath,
    });
  }

  return child;
}

async function main() {
  const pnpmCommand = getPnpmCommand();
  const vitePort = String(await resolveVitePort());
  const logFilePath = createSharedLogPath();
  process.env.LOG_FILE = logFilePath;
  const sharedEnv = { VITE_PORT: vitePort, LOG_FILE: logFilePath };
  const children = [];
  let shuttingDown = false;

  console.log(`[dev-stack] Using Vite port ${vitePort}`);
  console.log(`[dev-stack] Shared log file ${logFilePath}`);
  writeLog(logFilePath, 'DEV_STACK', `Using Vite port ${vitePort}`);
  writeLog(logFilePath, 'DEV_STACK', `Shared log file ${logFilePath}`);

  const stopAll = (signal = 'SIGTERM') => {
    writeLog(logFilePath, 'DEV_STACK', `Stopping child processes with ${signal}`);
    for (const child of children) {
      if (child.killed) continue;
      try {
        child.kill(signal);
      } catch {
        // Child already exited.
      }
    }
  };

  const handleExit = (code, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    writeLog(
      logFilePath,
      'DEV_STACK',
      `Dev stack exiting with code=${code ?? 'null'} signal=${signal ?? 'null'}`,
    );
    stopAll(signal || 'SIGTERM');
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  };

  process.on('SIGINT', () => handleExit(0, 'SIGINT'));
  process.on('SIGTERM', () => handleExit(0, 'SIGTERM'));

  children.push(
    spawnManaged(pnpmCommand, ['run', 'dev:vite', '--', '--port', vitePort, '--strictPort'], sharedEnv),
  );
  children.push(spawnManaged(pnpmCommand, ['run', 'dev:electron'], sharedEnv));

  for (const child of children) {
    child.on('exit', (code, signal) => {
      writeLog(
        logFilePath,
        'DEV_STACK',
        `Child exited pid=${child.pid ?? 'unknown'} code=${code ?? 'null'} signal=${signal ?? 'null'}`,
      );
      handleExit(code, signal);
    });
    child.on('error', (error) => {
      console.error('[dev-stack] Failed to start child process:', error);
      writeLog(logFilePath, 'DEV_STACK', `Failed to start child process: ${error.message}`);
      handleExit(1);
    });
  }
}

main().catch((error) => {
  console.error('[dev-stack] Failed to start dev stack:', error);
  const logFilePath = process.env.LOG_FILE?.trim();
  if (logFilePath) {
    writeLog(logFilePath, 'DEV_STACK', `Failed to start dev stack: ${error.message}`);
  }
  process.exit(1);
});
