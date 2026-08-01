import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const logsDir = path.join(repoRoot, 'logs');
const parserBinaryPath = path.join(
  repoRoot,
  'apps',
  'interpreter-overlay',
  'runtime',
  'infra',
  'accessibility-parser',
  'accessibility-tree',
);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = {
    command: 'run',
    app: 'Google Chrome',
    prompt: '',
    timeoutMs: 15000,
    acceptAfterMs: null,
    output: '',
    outputDir: '',
    debugPort: Number(process.env.INTERPRETER_OVERLAY_DEBUG_PORT || '9877'),
    debugToken: process.env.INTERPRETER_OVERLAY_DEBUG_TOKEN || '',
    noActivate: false,
    ocrChars: 3000,
  };

  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('--')) {
    args.command = rest.shift();
  }

  while (rest.length > 0) {
    const token = rest.shift();
    if (token === '--') {
      continue;
    }
    switch (token) {
      case '--app':
        args.app = rest.shift() || '';
        break;
      case '--prompt':
        args.prompt = rest.shift() || '';
        break;
      case '--timeout-ms':
        args.timeoutMs = Number(rest.shift() || '15000');
        break;
      case '--accept-after-ms':
        args.acceptAfterMs = Number(rest.shift() || '0');
        break;
      case '--output':
        args.output = rest.shift() || '';
        break;
      case '--output-dir':
        args.outputDir = rest.shift() || '';
        break;
      case '--debug-port':
        args.debugPort = Number(rest.shift() || '9877');
        break;
      case '--debug-token':
        args.debugToken = rest.shift() || '';
        break;
      case '--ocr-chars':
        args.ocrChars = Number(rest.shift() || '3000');
        break;
      case '--no-activate':
        args.noActivate = true;
        break;
      default:
        fail(`Unknown argument: ${token}`);
    }
  }

  return args;
}

function runAppleScript(lines) {
  const scriptArgs = lines.flatMap((line) => ['-e', line]);
  const result = spawnSync('osascript', scriptArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    fail(result.stderr || result.stdout || 'osascript failed');
  }
}

function activateApp(appName) {
  runAppleScript([
    `tell application "${appName}" to activate`,
    'delay 0.5',
  ]);
}

function sendDebugCommand(port, debugToken, command, params = {}) {
  if (!debugToken) {
    fail('Missing debug auth token. Set INTERPRETER_OVERLAY_DEBUG_TOKEN or pass --debug-token.');
  }

  const body = JSON.stringify({ command, params });
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/command',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-interpreter-debug-token': debugToken,
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += chunk.toString();
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Debug command failed: ${res.statusCode} ${responseBody}`));
            return;
          }

          try {
            resolve(JSON.parse(responseBody));
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.on('error', reject);
    request.setTimeout(10000, () => {
      request.destroy(new Error('Debug command timed out'));
    });
    request.write(body);
    request.end();
  });
}

function slugify(value) {
  return String(value || 'app')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'app';
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function truncateLabel(value, maxLength = 48) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function isInteractiveRole(role) {
  return /^AX(Button|TextField|TextArea|SearchField|PopUpButton|MenuItem|CheckBox|RadioButton|Link|DateField|TimeField|SecureTextField|Slider|ComboBox|MenuBarItem|MenuButton)$/.test(
    role,
  );
}

function buildOverlaySvg(snapshot, imageWidth, imageHeight, { interactiveOnly = false } = {}) {
  const bounds = snapshot.displayBoundsDIP;
  if (!bounds) {
    fail('Debug snapshot did not include displayBoundsDIP');
  }

  const xScale = imageWidth / bounds.width;
  const yScale = imageHeight / bounds.height;
  const fontSize = 13;
  const elements = snapshot.elements.filter((element) => {
    if (!element?.bbox) {
      return false;
    }
    if (element.bbox.width <= 0 || element.bbox.height <= 0) {
      return false;
    }

    if (interactiveOnly && !isInteractiveRole(element.role)) {
      return false;
    }

    return true;
  });

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidth}" height="${imageHeight}" viewBox="0 0 ${imageWidth} ${imageHeight}">`,
  ];

  for (const element of elements) {
    const x = (element.bbox.x - bounds.x) * xScale;
    const y = (element.bbox.y - bounds.y) * yScale;
    const width = element.bbox.width * xScale;
    const height = element.bbox.height * yScale;

    if (width <= 0 || height <= 0) {
      continue;
    }

    const isInteractive = isInteractiveRole(element.role);
    const stroke = isInteractive ? '#ff453a' : '#f59e0b';
    const fill = isInteractive ? 'rgba(255,69,58,0.08)' : 'rgba(245,158,11,0.06)';
    const label = truncateLabel(`${element.id} ${element.role} ${element.label || ''}`.trim());
    const labelY = Math.max(18, y - 6);
    const labelWidth = Math.min(imageWidth - 8, Math.max(60, label.length * 7.4));

    parts.push(
      `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`,
    );

    if (label) {
      parts.push(
        `<rect x="${Math.max(4, x).toFixed(2)}" y="${(labelY - 16).toFixed(2)}" width="${labelWidth.toFixed(2)}" height="18" rx="4" fill="${stroke}" opacity="0.92"/>`,
      );
      parts.push(
        `<text x="${(Math.max(4, x) + 5).toFixed(2)}" y="${(labelY - 3).toFixed(2)}" fill="#ffffff" font-size="${fontSize}" font-family="Menlo, Monaco, monospace">${label
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')}</text>`,
      );
    }
  }

  parts.push('</svg>');
  return parts.join('');
}

async function visualizeSnapshot(args) {
  if (!args.noActivate) {
    activateApp(args.app);
  }

  const snapshot = await sendDebugCommand(
    args.debugPort,
    args.debugToken,
    'captureDebugSnapshot',
  );
  if (!snapshot.screenshotBase64) {
    fail('Debug snapshot did not include screenshot data');
  }

  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const outputDir = args.outputDir
    ? path.resolve(repoRoot, args.outputDir)
    : path.join(repoRoot, 'overlay-debug', `${timestamp}-${slugify(args.app)}`);
  ensureDir(outputDir);

  const screenshotBuffer = Buffer.from(snapshot.screenshotBase64, 'base64');
  const screenshotPath = path.join(outputDir, 'screenshot.png');
  const annotatedPath = path.join(outputDir, 'annotated.png');
  const annotatedAllPath = path.join(outputDir, 'annotated-all.png');
  const textPath = path.join(outputDir, 'formatted-text.txt');
  const elementsPath = path.join(outputDir, 'elements.json');
  const snapshotPath = path.join(outputDir, 'snapshot.json');

  fs.writeFileSync(screenshotPath, screenshotBuffer);
  fs.writeFileSync(textPath, `${snapshot.formattedText}\n`);
  fs.writeFileSync(elementsPath, `${JSON.stringify(snapshot.elements, null, 2)}\n`);
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

  const metadata = await sharp(screenshotBuffer).metadata();
  if (!metadata.width || !metadata.height) {
    fail('Could not determine screenshot dimensions');
  }

  const interactiveOverlaySvg = buildOverlaySvg(snapshot, metadata.width, metadata.height, {
    interactiveOnly: true,
  });
  const fullOverlaySvg = buildOverlaySvg(snapshot, metadata.width, metadata.height, {
    interactiveOnly: false,
  });
  await sharp(screenshotBuffer)
    .composite([{ input: Buffer.from(interactiveOverlaySvg), blend: 'over' }])
    .png()
    .toFile(annotatedPath);
  await sharp(screenshotBuffer)
    .composite([{ input: Buffer.from(fullOverlaySvg), blend: 'over' }])
    .png()
    .toFile(annotatedAllPath);

  console.log(`debug_port: ${args.debugPort}`);
  console.log(`output_dir: ${outputDir}`);
  console.log(`screenshot: ${screenshotPath}`);
  console.log(`annotated: ${annotatedPath}`);
  console.log(`annotated_all: ${annotatedAllPath}`);
  console.log(`formatted_text: ${textPath}`);
  console.log(`elements: ${elementsPath}`);
}

function findLatestLogPath() {
  if (!fs.existsSync(logsDir)) {
    fail(`Logs directory not found: ${logsDir}`);
  }

  const entries = fs.readdirSync(logsDir)
    .filter((name) => name.startsWith('session-') && name.endsWith('.log'))
    .map((name) => {
      const fullPath = path.join(logsDir, name);
      const stat = fs.statSync(fullPath);
      return { fullPath, mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (entries.length === 0) {
    fail(`No log files found in ${logsDir}`);
  }

  return entries[0];
}

function readLogDelta(logPath, startSize) {
  const content = fs.readFileSync(logPath);
  return content.subarray(startSize).toString('utf8');
}

function extractReasoning(logText) {
  const match = logText.match(/"reasoning": "([\s\S]*?)",\n\s+"tool_calls"/);
  if (!match) {
    return null;
  }

  return match[1]
    .replaceAll('\\n', '\n')
    .replaceAll('\\"', '"')
    .replaceAll('\\\\', '\\');
}

function extractPromptTokens(logText) {
  const matches = [...logText.matchAll(/"prompt_tokens":\s+(\d+)/g)];
  return matches.length > 0 ? Number(matches.at(-1)[1]) : null;
}

function extractRelevantLines(logText) {
  const patterns = [
    'Accessibility parse completed',
    'Screenshot warmup completed',
    'LLM API call completed',
    'onToolCall callback fired',
    'Instant match field',
    'Instant match completed',
    'Agent done',
    'Run error',
  ];

  return logText
    .split('\n')
    .filter((line) => patterns.some((pattern) => line.includes(pattern)));
}

async function waitForDebugSignal(logPath, startSize, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const currentSize = fs.statSync(logPath).size;
    if (currentSize > startSize) {
      const delta = readLogDelta(logPath, startSize);
      if (
        delta.includes('onToolCall callback fired') ||
        delta.includes('Agent done:') ||
        delta.includes('Run error')
      ) {
        return delta;
      }
    }

    await sleep(200);
  }

  return readLogDelta(logPath, startSize);
}

async function runOverlayPrompt(args) {
  if (!args.prompt.trim()) {
    fail('run mode requires --prompt');
  }

  const latestLog = findLatestLogPath();

  if (!args.noActivate) {
    activateApp(args.app);
  }

  runAppleScript([
    'tell application "System Events" to key code 49 using control down',
    'delay 0.75',
    `tell application "System Events" to keystroke "${args.prompt.replaceAll('"', '\\"')}"`,
    'delay 0.2',
    'tell application "System Events" to key code 36',
  ]);

  if (args.acceptAfterMs !== null) {
    await sleep(args.acceptAfterMs);
    runAppleScript([
      'tell application "System Events" to key down control',
      'delay 0.1',
      'tell application "System Events" to key up control',
    ]);
  }

  const delta = await waitForDebugSignal(latestLog.fullPath, latestLog.size, args.timeoutMs);
  const reasoning = extractReasoning(delta);
  const promptTokens = extractPromptTokens(delta);
  const relevantLines = extractRelevantLines(delta);

  console.log(`log: ${latestLog.fullPath}`);
  if (promptTokens !== null) {
    console.log(`prompt_tokens: ${promptTokens}`);
  }
  for (const line of relevantLines) {
    console.log(line);
  }
  if (reasoning) {
    console.log('\nreasoning:\n');
    console.log(reasoning);
  }
}

function runParseOnly(args) {
  if (!fs.existsSync(parserBinaryPath)) {
    fail(`Parser binary not found: ${parserBinaryPath}`);
  }

  if (!args.noActivate) {
    activateApp(args.app);
  }

  const result = spawnSync(parserBinaryPath, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      INTERPRETER_OVERLAY_EXCLUDED_PID: String(process.pid),
    },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.status !== 0) {
    fail(result.stderr || result.stdout || `Parser exited with code ${result.status}`);
  }

  const parsed = JSON.parse(result.stdout);
  const formattedText = String(parsed.formatted_text || '');

  if (args.output) {
    fs.writeFileSync(args.output, result.stdout);
    console.log(`wrote: ${args.output}`);
  }

  console.log(`parser: ${parserBinaryPath}`);
  console.log(`chars: ${formattedText.length}`);

  const debugLines = result.stderr
    .split('\n')
    .filter((line) =>
      line.includes('Replacing auxiliary top window') ||
      line.includes('Target window owner=') ||
      line.includes('Restricting AX traversal') ||
      line.includes('Processed target PID'),
    );

  for (const line of debugLines) {
    console.log(line);
  }

  console.log('\nformatted_text:\n');
  console.log(formattedText.slice(0, args.ocrChars));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'parse') {
    runParseOnly(args);
    return;
  }

  if (args.command === 'run') {
    await runOverlayPrompt(args);
    return;
  }

  if (args.command === 'visualize') {
    await visualizeSnapshot(args);
    return;
  }

  fail(`Unknown command: ${args.command}`);
}

await main();
