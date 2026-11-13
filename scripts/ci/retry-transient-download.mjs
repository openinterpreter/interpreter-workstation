#!/usr/bin/env node
// Retry only a transient download failure. Assertion, build and authentication
// failures always retain their original nonzero result without another run.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MAX_CAPTURE = 32 * 1024;
const MAX_ATTEMPTS = 3;

export function isTransientDownloadFailure(output) {
  return /(?:HTTPError:\s*Response code|Response code|curl:\s*\(22\)\s*The requested URL returned error:)\s*(?:502|503|504)\b/i.test(output);
}

export async function retryTransientDownload(script, args, options = {}) {
  const attempts = options.attempts ?? MAX_ATTEMPTS;
  const delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const execute = options.execute ?? ((file, argv) => new Promise(resolve => {
    const child = spawn(process.execPath, [file, ...argv], { stdio: ['inherit', 'pipe', 'pipe'] });
    let tail = '';
    const collect = (chunk, output) => {
      output.write(chunk);
      tail = (tail + chunk.toString('utf8')).slice(-MAX_CAPTURE);
    };
    child.stdout.on('data', chunk => collect(chunk, process.stdout));
    child.stderr.on('data', chunk => collect(chunk, process.stderr));
    child.on('error', () => resolve({ code: 1, tail: '' }));
    child.on('close', (code, signal) => resolve({ code: code ?? 1, signal, tail }));
  }));
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) {
    throw new Error('Invalid download attempt bound.');
  }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await execute(script, args);
    if (result.code === 0 && !result.signal) return 0;
    if (result.signal || !isTransientDownloadFailure(result.tail) || attempt === attempts) {
      return result.code || 1;
    }
    process.stderr.write(`[download] Transient HTTP failure; retrying ${attempt + 1}/${attempts}.\n`);
    await delay(attempt * 2_000);
  }
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [script, ...args] = process.argv.slice(2);
  if (!script || !['node_modules/electron/install.js', 'scripts/download-pdfcpu.mjs'].includes(script)) {
    process.stderr.write('Only pinned Electron or pdfcpu download scripts are supported.\n');
    process.exitCode = 2;
  } else {
    process.exitCode = await retryTransientDownload(script, args);
  }
}
