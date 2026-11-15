import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const pnpmStore = path.resolve('node_modules/.pnpm');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const version = manifest.devDependencies['electron-builder'];
if (!['26.15.3', '26.18.0'].includes(version)) {
  throw new Error(`Unreviewed electron-builder keychain behavior: ${version}`);
}
const entries = await readdir(pnpmStore);
const packageDirectory = entries.find((entry) => (
  entry.startsWith(`app-builder-lib@${version}_`)
  && !entry.includes('patch_hash=')
));

if (!packageDirectory) {
  throw new Error(`Could not locate the pinned app-builder-lib ${version} package`);
}

const sourcePath = path.join(
  pnpmStore,
  packageDirectory,
  'node_modules/app-builder-lib/out/codeSign/macCodeSign.js',
);
const source = await readFile(sourcePath, 'utf8');
if (version === '26.18.0') {
  // This upstream revision passes the keychain unlock password to the partition-list
  // command already. Fail closed if a future build changes the reviewed source.
  const fixed = `    return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);
}
async function importCerts(keychainFile, paths, keyPasswords, keychainPassword) {
    var _a;
    for (let i = 0; i < paths.length; i++) {
        const password = (_a = keyPasswords[i]) !== null && _a !== void 0 ? _a : "";
        await (0, builder_util_1.exec)("/usr/bin/security", ["import", paths[i], "-k", keychainFile, "-T", "/usr/bin/codesign", "-T", "/usr/bin/productbuild", "-P", password]);
        // https://stackoverflow.com/questions/39868578/security-codesign-in-sierra-keychain-ignores-access-control-settings-and-ui-p
        // https://github.com/electron-userland/electron-packager/issues/701#issuecomment-322315996
        // \`-k\` expects the keychain's own unlock password (as used by create-keychain/unlock-keychain above),
        // not the imported item's password used by \`security import -P\`.
        await (0, builder_util_1.exec)("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainFile]);
`;
  if (!source.includes(fixed) || source.indexOf(fixed) !== source.lastIndexOf(fixed)) {
    throw new Error('Pinned electron-builder source no longer matches the reviewed upstream keychain fix');
  }
  console.log('Verified electron-builder upstream keychain fix; no local patch needed');
  process.exit(0);
}
const original = `    return await importCerts(keychainFile, certPaths, cscPasswords);
}
async function importCerts(keychainFile, paths, keyPasswords) {
    var _a;
    for (let i = 0; i < paths.length; i++) {
        const password = (_a = keyPasswords[i]) !== null && _a !== void 0 ? _a : "";
        await (0, builder_util_1.exec)("/usr/bin/security", ["import", paths[i], "-k", keychainFile, "-T", "/usr/bin/codesign", "-T", "/usr/bin/productbuild", "-P", password]);
        // https://stackoverflow.com/questions/39868578/security-codesign-in-sierra-keychain-ignores-access-control-settings-and-ui-p
        // https://github.com/electron-userland/electron-packager/issues/701#issuecomment-322315996
        await (0, builder_util_1.exec)("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]);
`;
const replacement = original
  .replace('cscPasswords);', 'cscPasswords, keychainPassword);')
  .replace('keyPasswords) {', 'keyPasswords, keychainPassword) {')
  .replace('"-k", password, keychainFile]);\n', '"-k", keychainPassword, keychainFile]);\n');

if (!source.includes(original) || source.indexOf(original) !== source.lastIndexOf(original)) {
  throw new Error('Pinned electron-builder source no longer matches the reviewed patch target');
}

await writeFile(sourcePath, source.replace(original, replacement));
console.log('Patched electron-builder temporary keychain authentication');
