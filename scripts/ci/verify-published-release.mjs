import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const [version, baseUrl, repository] = process.argv.slice(2);
assert.match(version ?? '', /^0\.2\.\d+$/, 'Expected a public release version');
assert.ok(baseUrl, 'Expected the public release base URL');
assert.ok(repository, 'Expected the GitHub repository');

const expectedManifestFiles = {
  'latest-mac.yml': [
    `Interpreter-arm64-${version}.dmg`,
    `Interpreter-x64-${version}.dmg`,
  ],
  'latest.yml': [`Interpreter-win-x64-${version}.exe`],
  'latest-linux.yml': [
    `Interpreter-linux-x86_64-${version}.AppImage`,
  ],
};

async function fetchOk(name, init) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/${name}`, init);
  assert.ok(response.ok, `${name} returned ${response.status}`);
  return response;
}

for (const [manifest, filenames] of Object.entries(expectedManifestFiles)) {
  const text = await (await fetchOk(manifest)).text();
  assert.match(text, new RegExp(`(?:^|\\n)version:\\s*["']?${version.replaceAll('.', '\\.')}(?:["']?\\s*$)`, 'm'), `${manifest} has the wrong version`);
  for (const filename of filenames) assert.ok(text.includes(filename), `${manifest} does not reference ${filename}`);
}

const aliases = new Map([
  ['Interpreter-arm64.dmg', `Interpreter-arm64-${version}.dmg`],
  ['Interpreter-x64.dmg', `Interpreter-x64-${version}.dmg`],
  ['Interpreter-x64.exe', `Interpreter-win-x64-${version}.exe`],
  ['Interpreter-latest.AppImage', `Interpreter-linux-x86_64-${version}.AppImage`],
  ['Interpreter-linux-amd64.deb', `Interpreter-linux-amd64-${version}.deb`],
]);

for (const [alias, source] of aliases) {
  const [aliasResponse, sourceResponse] = await Promise.all([
    fetchOk(alias, { method: 'HEAD' }),
    fetchOk(source, { method: 'HEAD' }),
  ]);
  const aliasSize = Number(aliasResponse.headers.get('content-length'));
  const sourceSize = Number(sourceResponse.headers.get('content-length'));
  assert.ok(aliasSize > 0, `${alias} is empty`);
  assert.equal(aliasSize, sourceSize, `${alias} does not match ${source}`);
}

const release = JSON.parse(execFileSync('gh', [
  'release', 'view', `v${version}`, '--repo', repository,
  '--json', 'isDraft,tagName,targetCommitish',
], { encoding: 'utf8' }));
assert.equal(release.isDraft, false, 'GitHub release is still a draft');
assert.equal(release.tagName, `v${version}`);
const [latest] = JSON.parse(execFileSync('gh', [
  'release', 'list', '--repo', repository, '--exclude-drafts', '--exclude-pre-releases',
  '--limit', '1', '--json', 'tagName',
], { encoding: 'utf8' }));
assert.equal(latest?.tagName, `v${version}`, 'GitHub release is not latest');
console.log(`Verified published Workstation v${version}.`);
