'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureBundledWhatwgUrlDependency: ensure } = require('./ensureBundledWhatwgUrlDependency.cjs');
const whatwg = [String.fromCharCode(92) + 'node_modules' + String.fromCharCode(92) + 'whatwg-url' + String.fromCharCode(92) + 'lib' + String.fromCharCode(92) + 'url-state-machine.js'];
function setup(t, version = '1.14.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-byte-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourcesRoot = path.join(root, 'resources');
  const sourceNodeModulesRoot = path.join(root, 'node_modules');
  fs.mkdirSync(resourcesRoot, { recursive: true });
  if (version) {
    const p = path.join(sourceNodeModulesRoot, '.pnpm', '@exodus+bytes@' + version, 'node_modules', '@exodus', 'bytes');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name: '@exodus/bytes', version }));
    fs.writeFileSync(path.join(p, 'encoding.js'), 'module.exports={ok:true};');
  }
  return { resourcesRoot, sourceNodeModulesRoot };
}
test('bundles @exodus/bytes when whatwg-url needs it', t => {
  const opts=setup(t);
  assert.equal(ensure({...opts,asarEntries:whatwg}), 'staged-before-signing');
  assert.equal(fs.existsSync(path.join(opts.resourcesRoot,'node_modules','@exodus','bytes','encoding.js')), true);
});
test('respects already-bundled bytes', t => {
  const opts=setup(t,null);
  const code=String.fromCharCode(92)+'node_modules'+String.fromCharCode(92)+'@exodus'+String.fromCharCode(92)+'bytes'+String.fromCharCode(92)+'encoding.js';
  assert.equal(ensure({...opts,asarEntries:[...whatwg,code]}), 'already-present');
});
test('refuses a missing source dependency', t => {
  const opts=setup(t,null);
  assert.throws(()=>ensure({...opts,asarEntries:whatwg}), /missing from pnpm/);
});
test('refuses unsupported source versions', t => {
  const opts=setup(t,'1.8.0');
  assert.throws(()=>ensure({...opts,asarEntries:whatwg}), /incompatible version/);
});
test('skips when whatwg-url is not included', t => {
  const opts=setup(t,null);
  assert.equal(ensure({...opts,asarEntries:[]}), 'not-required');
});
