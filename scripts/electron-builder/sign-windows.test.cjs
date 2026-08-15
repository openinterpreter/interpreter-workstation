const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildAzureSignArguments,
  requireSigningEnvironment,
} = require('./sign-windows.cjs');

const environment = {
  AZURE_KEY_VAULT_URI: 'https://example.vault.azure.net/',
  AZURE_CLIENT_ID: 'client-id',
  AZURE_TENANT_ID: 'tenant-id',
  AZURE_CLIENT_SECRET: 'client-secret',
  AZURE_CERT_NAME: 'certificate-name',
};

test('builds a SHA-256 timestamped AzureSignTool invocation', () => {
  const args = buildAzureSignArguments('C:\\release\\Interpreter.exe', environment);
  assert.deepEqual(args, [
    'sign',
    '-kvu', environment.AZURE_KEY_VAULT_URI,
    '-kvi', environment.AZURE_CLIENT_ID,
    '-kvt', environment.AZURE_TENANT_ID,
    '-kvs', environment.AZURE_CLIENT_SECRET,
    '-kvc', environment.AZURE_CERT_NAME,
    '-tr', 'http://timestamp.digicert.com',
    '-td', 'sha256',
    '-fd', 'sha256',
    '-v',
    'C:\\release\\Interpreter.exe',
  ]);
});

test('fails closed when any signing authority is missing', () => {
  const incomplete = { ...environment };
  delete incomplete.AZURE_CLIENT_SECRET;
  assert.throws(
    () => requireSigningEnvironment(incomplete),
    /AZURE_CLIENT_SECRET/,
  );
});
