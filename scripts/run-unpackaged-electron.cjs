const { spawn } = require('child_process');

const { prepareDevElectronBundle } = require('./prepare-dev-electron-bundle-v2.cjs');

const electronBinary = prepareDevElectronBundle({ projectRoot: process.cwd() });
const args = ['.', ...process.argv.slice(2)];

const child = spawn(electronBinary, args, {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(`Failed to launch Electron: ${error.message}`);
  process.exit(1);
});
