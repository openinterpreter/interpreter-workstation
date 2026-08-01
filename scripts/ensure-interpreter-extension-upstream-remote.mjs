import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const extensionRepoDir = path.join(repoRoot, 'apps', 'interpreter-extension');
const upstreamName = 'upstream';
const upstreamUrl = 'https://github.com/remorses/playwriter.git';
const args = new Set(process.argv.slice(2));

function runGit(gitArgs, options = {}) {
  const output = execFileSync('git', ['-C', extensionRepoDir, ...gitArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  return typeof output === 'string' ? output.trim() : '';
}

function remoteExists(name) {
  try {
    runGit(['remote', 'get-url', name]);
    return true;
  } catch {
    return false;
  }
}

function ensureUpstreamRemote() {
  if (!remoteExists(upstreamName)) {
    runGit(['remote', 'add', upstreamName, upstreamUrl]);
    console.log(`[extension-upstream] Added ${upstreamName} -> ${upstreamUrl}`);
    return;
  }

  const currentUrl = runGit(['remote', 'get-url', upstreamName]);
  if (currentUrl !== upstreamUrl) {
    runGit(['remote', 'set-url', upstreamName, upstreamUrl]);
    console.log(`[extension-upstream] Updated ${upstreamName} -> ${upstreamUrl}`);
    return;
  }

  console.log(`[extension-upstream] ${upstreamName} already points to ${upstreamUrl}`);
}

function fetchUpstream() {
  runGit(['fetch', upstreamName, '--tags', '--prune'], { stdio: 'inherit' });
}

ensureUpstreamRemote();

if (args.has('--fetch')) {
  fetchUpstream();
}
