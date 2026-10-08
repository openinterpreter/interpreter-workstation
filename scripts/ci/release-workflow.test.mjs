import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workflow = await readFile('.github/workflows/release.yml', 'utf8');
const signedTestWorkflow = await readFile('.github/workflows/signed-macos-test-build.yml', 'utf8');
const electronBuilderConfig = await readFile('electron-builder.yml', 'utf8');
const publishedVerifier = await readFile('scripts/ci/verify-published-release.mjs', 'utf8');
const licensePolicy = JSON.parse(await readFile('licenses/release-policy.json', 'utf8'));

test('each packaging verifier requires every reviewed license notice', async () => {
  for (const scriptPath of [
    'scripts/package-smoke.mjs',
    'scripts/verify-official-release-candidate.mjs',
    'scripts/verify-internal-release.mjs',
  ]) {
    const source = await readFile(scriptPath, 'utf8');
    for (const notice of licensePolicy.noticeFiles) {
      const required = scriptPath.endsWith('package-smoke.mjs')
        ? notice.split('/').at(-1)
        : `licenses/${notice.split('/').at(-1)}`;
      assert.ok(source.includes(`'${required}'`), `${scriptPath} omits ${required}`);
    }
  }
});

test('signed macOS test builds reuse the protected signing boundary without publishing updates', () => {
  assert.match(signedTestWorkflow, /github\.actor == 'interpreterwork-automation\[bot\]'/);
  assert.match(signedTestWorkflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(signedTestWorkflow, /inputs\.confirm == 'test'/);
  assert.match(signedTestWorkflow, /environment: production-release/);
  assert.match(signedTestWorkflow, /runner: macos-26\s+arch: arm64/);
  assert.match(signedTestWorkflow, /runner: macos-15-intel\s+arch: x64/);
  assert.match(signedTestWorkflow, /pnpm run package:official -- --mac dmg zip --\$\{\{ matrix\.arch \}\} --publish never/);
  assert.match(signedTestWorkflow, /codesign --verify --deep --strict/);
  assert.match(signedTestWorkflow, /spctl --assess --type execute/);
  assert.match(signedTestWorkflow, /xcrun stapler validate/);
  assert.match(signedTestWorkflow, /pnpm run release:verify:official-candidate -- --arch=\$\{\{ matrix\.arch \}\}/);
  assert.match(signedTestWorkflow, /SOURCE_COMMIT/);
  assert.match(signedTestWorkflow, /SHA256SUMS/);
  assert.match(signedTestWorkflow, /actions\/upload-artifact@/);
  assert.doesNotMatch(signedTestWorkflow, /gh release|upload_and_verify|latest\*\.yml|AWS_ACCESS_KEY_ID|contents: write|secrets\.SENTRY_AUTH_TOKEN/);

  const certificateStep = /      - name: Prepare the passwordless macOS signing certificate\n([\s\S]*?)(?=      - name: Build signed and notarized macOS package)/;
  assert.equal(signedTestWorkflow.match(certificateStep)?.[1],
    workflow.match(certificateStep)?.[1].replace(/^        if: matrix\.os == 'macos'\n/, ''));
});

test('macOS candidate verifier selects the matching architecture without changing the production default', async () => {
  const source = await readFile('scripts/verify-official-release-candidate.mjs', 'utf8');
  assert.match(source, /archArg\?\.slice\('--arch='\.length\) \?\? 'arm64'/);
  assert.match(source, /arch !== 'arm64' && arch !== 'x64'/);
  assert.match(source, /path\.join\(distRoot, `mac-\$\{arch\}`, 'Interpreter\.app'\)/);
});

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
