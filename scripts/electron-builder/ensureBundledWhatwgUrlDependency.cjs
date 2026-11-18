'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Guarantee the runtime graph is complete BEFORE signing and publishing.
function ensureBundledWhatwgUrlDependency({ resourcesRoot, sourceNodeModulesRoot, asarEntries }) {
  if (!Array.isArray(asarEntries)) throw new Error('Missing ASAR inventory');
  const paths = asarEntries.map((entry) => entry.replaceAll(String.fromCharCode(92), '/'));
  const contains = (entry) => paths.some((name) => name.endsWith('/' + entry));
  if (!contains('node_modules/whatwg-url/lib/url-state-machine.js')) return 'not-required';

  const installed = path.join(resourcesRoot, 'node_modules', '@exodus', 'bytes', 'encoding.js');
  const unpacked = path.join(resourcesRoot, 'app.asar.unpacked', 'node_modules', '@exodus', 'bytes', 'encoding.js');
  if (contains('node_modules/@exodus/bytes/encoding.js') || fs.existsSync(installed) || fs.existsSync(unpacked)) {
    return 'already-present';
  }

  const virtualStore = path.join(sourceNodeModulesRoot, '.pnpm');
  const possible = [path.join(sourceNodeModulesRoot, '@exodus', 'bytes')];
  if (fs.existsSync(virtualStore)) {
    for (const name of fs.readdirSync(virtualStore).sort()) {
      if (name.startsWith('@exodus+bytes@')) {
        possible.push(path.join(virtualStore, name, 'node_modules', '@exodus', 'bytes'));
      }
    }
  }
  const source = possible.find((dir) => fs.existsSync(path.join(dir, 'encoding.js')));
  if (!source) throw new Error('[afterPack] Required whatwg-url dependency @exodus/bytes is missing from pnpm build graph');

  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  if (pkg.name !== '@exodus/bytes' || !/^1\.(?:1[1-9]|[2-9]\d)\.\d+/.test(pkg.version)) {
    throw new Error('[afterPack] Wrong @exodus/bytes source package or incompatible version');
  }
  const destination = path.dirname(installed);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, dereference: true, force: false, errorOnExist: true });
  if (!fs.existsSync(installed)) throw new Error('[afterPack] @exodus/bytes copy was incomplete');
  return 'staged-before-signing';
}
module.exports = { ensureBundledWhatwgUrlDependency };
