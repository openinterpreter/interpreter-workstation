import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workflow = await readFile('.github/workflows/release.yml', 'utf8');
const electronBuilderConfig = await readFile('electron-builder.yml', 'utf8');
const publishedVerifier = await readFile('scripts/ci/verify-published-release.mjs', 'utf8');

test('Apple keychain patch matches the locked builder source and edits only a test copy', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const version = manifest.devDependencies['electron-builder'];
  const patchPath = path.resolve('scripts/ci/patch-electron-builder-keychain.mjs');
  const patchSource = await readFile(patchPath, 'utf8');
  assert.ok(patchSource.includes(`app-builder-lib@${version}_`));

  const pnpmStore = path.resolve('node_modules/.pnpm');
  const directory = (await readdir(pnpmStore)).find((entry) =>
    entry.startsWith(`app-builder-lib@${version}_`) && !entry.includes('patch_hash='));
  assert.ok(directory, `Missing locked app-builder-lib ${version}`);
  const relative = path.join('node_modules/.pnpm', directory,
    'node_modules/app-builder-lib/out/codeSign/macCodeSign.js');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'workstation-keychain-patch-'));
  try {
    const copied = path.join(temporary, relative);
    await mkdir(path.dirname(copied), { recursive: true });
    await copyFile(path.resolve(relative), copied);
    execFileSync(process.execPath, [patchPath], { cwd: temporary, encoding: 'utf8' });
    const patched = await readFile(copied, 'utf8');
    assert.match(patched, /importCerts\(keychainFile, certPaths, cscPasswords, keychainPassword\)/);
    assert.match(patched, /"set-key-partition-list"[^\n]+"-k", keychainPassword, keychainFile/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

function section(start, end) {
  const startIndex = workflow.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing workflow section: ${start}`);
  const endIndex = end ? workflow.indexOf(end, startIndex + start.length) : workflow.length;
  assert.notEqual(endIndex, -1, `Missing workflow boundary: ${end}`);
  return workflow.slice(startIndex, endIndex);
}

test('official release is dispatched only by the InterpreterWork App from main', () => {
  const authorize = section('  authorize:', '  verify:');
  assert.match(authorize, /github\.actor == 'interpreterwork-automation\[bot\]'/);
  assert.match(authorize, /github\.ref == 'refs\/heads\/main'/);
  assert.match(authorize, /inputs\.confirm == 'release'/);
});

test('publishing authority is not exposed at job scope', () => {
  const publish = section('  publish:');
  const envStart = publish.indexOf('    env:');
  const stepsStart = publish.indexOf('    steps:', envStart);
  assert.ok(envStart >= 0 && stepsStart > envStart);
  const jobEnvironment = publish.slice(envStart, stepsStart);
  assert.doesNotMatch(jobEnvironment, /\$\{\{ secrets\./);
  assert.doesNotMatch(jobEnvironment, /GH_TOKEN:/);

  assert.equal((publish.match(/AWS_ACCESS_KEY_ID:/g) ?? []).length, 3);
  assert.equal((publish.match(/AWS_SECRET_ACCESS_KEY:/g) ?? []).length, 3);
  assert.equal((publish.match(/GH_TOKEN:/g) ?? []).length, 3);
  assert.equal((publish.match(/GITHUB_TOKEN:/g) ?? []).length, 1);
});

test('passwordless Apple certificate is protected before electron-builder imports it', () => {
  const build = section('  build:', '  publish:');
  assert.match(build, /brew install openssl@3/);
  assert.match(build, /"\$openssl_bin" pkcs12 -legacy -in "\$original" -passin pass: -nodes/);
  assert.match(build, /"\$openssl_bin" pkcs12 -legacy -export[^\n]+-passout "pass:\$password"/);
  assert.doesNotMatch(build, /CSC_KEY_PASSWORD:\s*""/);
});

test('the GitHub read token is scoped to dependency installation', () => {
  const verify = section('  verify:', '  build:');
  const build = section('  build:', '  publish:');

  assert.doesNotMatch(verify.slice(0, verify.indexOf('    steps:')), /GITHUB_TOKEN:/);
  assert.doesNotMatch(build.slice(0, build.indexOf('    steps:')), /GITHUB_TOKEN:/);
  assert.equal((verify.match(/GITHUB_TOKEN:/g) ?? []).length, 1);
  assert.equal((build.match(/GITHUB_TOKEN:/g) ?? []).length, 1);
});

test('installed clients discover a release only after GitHub publication', () => {
  const publish = section('  publish:');
  const payloads = publish.indexOf('Upload immutable payloads to the public Supabase bucket');
  const github = publish.indexOf('Publish the GitHub release');
  const aliases = publish.indexOf('Publish stable website download aliases');
  const manifests = publish.indexOf('Publish auto-update manifests last');
  const endToEnd = publish.indexOf('Verify the published release end to end');

  assert.ok(payloads >= 0 && github > payloads && aliases > github && manifests > aliases && endToEnd > manifests);
  assert.equal(publish.indexOf('Publish the GitHub release', github + 1), -1);
  for (const filename of [
    'Interpreter-arm64.dmg',
    'Interpreter-x64.dmg',
    'Interpreter-x64.exe',
    'Interpreter-latest.AppImage',
    'Interpreter-linux-amd64.deb',
  ]) {
    assert.match(publish, new RegExp(filename.replaceAll('.', '\\.')));
  }
});

test('partial publication requires verified current-run Windows and Linux jobs, not macOS assets', () => {
  const publish = section('  publish:');
  assert.match(publish, /needs: \[authorize, verify, build\]/);
  assert.match(publish, /always\(\) && needs\.authorize\.result == 'success'/);
  assert.match(publish, /needs\.verify\.result == 'success'/);
  assert.match(publish, /actions: read/);
  assert.match(publish, /node scripts\/ci\/release-platform-mode\.mjs/);
  for (const platform of ['windows-x64', 'linux-x64', 'macos-arm64', 'macos-x64']) {
    assert.match(publish, new RegExp(`name: official-${platform}`));
  }
  assert.equal((publish.match(/if: steps\.platforms\.outputs\.mode == 'all'/g) ?? []).length, 2);
  assert.match(publish, /test ! -e release\/latest-mac\.yml/);
  assert.match(publish, /previous macOS release remains in place pending Apple notarization/);
  assert.match(publish, /--notes-file release\/RELEASE_NOTES\.md --draft=false --latest/);
  assert.match(publishedVerifier, /mode === 'all' \|\| mode === 'windows-linux'/);
  assert.match(publishedVerifier, /if \(mode === 'all'\) expectedManifestFiles\['latest-mac\.yml'\]/);
  assert.match(publishedVerifier, /Partial release unexpectedly includes macOS package/);
});

test('a failed publication can reuse only its exact commit', () => {
  const authorize = section('  authorize:', '  verify:');
  const publish = section('  publish:');
  assert.match(authorize, /--json isDraft,targetCommitish/);
  assert.match(authorize, /"\$target" != "\$GITHUB_SHA"/);
  assert.doesNotMatch(authorize, /"\$draft" != "true"/);
  assert.match(publish, /gh release upload "\$RELEASE_TAG" release\/\* --repo "\$GITHUB_REPOSITORY" --clobber/);
});

test('SBOM attestation scans bounded locked source dependencies, not recursive binaries', () => {
  const publish = section('  publish:');
  const prepare = publish.indexOf('Prepare bounded source dependency inventory');
  const generate = publish.indexOf('Generate SPDX software bill of materials');
  const validate = publish.indexOf('Validate source dependency SBOM for attestation');
  const attest = publish.indexOf('Attest the release SBOM');
  assert.ok(prepare >= 0 && generate > prepare && validate > generate && attest > validate);
  assert.match(publish, /cp package\.json pnpm-lock\.yaml release-sbom-source\//);
  assert.match(publish, /path: \.\/release-sbom-source/);
  assert.doesNotMatch(publish.slice(generate, validate), /^\s*path: \.$/m);
  assert.match(publish, /sbom\.packages\.length < 100/);
  assert.match(publish, /size >= 16 \* 1024 \* 1024/);
  assert.match(publish, /fs\.writeFileSync\(file, compact\)/);
});

test('release packaging does not rebuild N-API native dependencies', () => {
  assert.match(electronBuilderConfig, /^npmRebuild: false$/m);
});

test('Linux release verification follows electron-builder architecture names', () => {
  const build = section('  build:', '  publish:');
  const linuxVerification = build.slice(
    build.indexOf('      - name: Verify Linux release artifacts'),
    build.indexOf('      - name: Upload immutable build output'),
  );

  assert.match(linuxVerification, /Interpreter-linux-x86_64-\$\{\{ needs\.authorize\.outputs\.version \}\}\.AppImage/);
  assert.match(linuxVerification, /Interpreter-linux-amd64-\$\{\{ needs\.authorize\.outputs\.version \}\}\.deb/);
  assert.doesNotMatch(linuxVerification, /Interpreter-linux-x64-/);
});
