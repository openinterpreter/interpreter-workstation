const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const REQUIRED_ENVIRONMENT = [
  'AZURE_KEY_VAULT_URI',
  'AZURE_CLIENT_ID',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_CERT_NAME',
];

function requireSigningEnvironment(environment = process.env) {
  const missing = REQUIRED_ENVIRONMENT.filter((name) => !environment[name]);
  if (missing.length > 0) {
    throw new Error(`[sign-windows] Missing required environment: ${missing.join(', ')}`);
  }
}

function buildAzureSignArguments(filePath, environment = process.env) {
  if (!filePath) {
    throw new Error('[sign-windows] electron-builder did not provide a file path');
  }
  requireSigningEnvironment(environment);
  return [
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
    filePath,
  ];
}

async function signWindowsExecutable(configuration) {
  const filePath = configuration?.path;
  const args = buildAzureSignArguments(filePath);
  console.log(`[sign-windows] Signing ${filePath} with Azure Key Vault`);
  await execFileAsync('AzureSignTool', args, {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
}

module.exports = signWindowsExecutable;
module.exports.buildAzureSignArguments = buildAzureSignArguments;
module.exports.requireSigningEnvironment = requireSigningEnvironment;
