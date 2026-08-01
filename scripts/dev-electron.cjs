const { spawn } = require('child_process');
const http = require('http');
const process = require('process');
const { execSync } = require('child_process');
const { prepareDevElectronBundle } = require('./prepare-dev-electron-bundle-v2.cjs');

const START_TIMEOUT_MS = Number(process.env.ELECTRON_DEV_TIMEOUT_MS || 120_000);
const POLL_INTERVAL_MS = 500;
const BASE_VITE_PORT = 5173;
const MAX_VITE_PORT = 5193;

const probeUrl = (targetUrl) =>
  new Promise((resolve, reject) => {
    const req = http.get(`${targetUrl}/@vite/client`, (res) => {
      const isViteClient = (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300;
      res.destroy();
      resolve(isViteClient);
    });

    req.on('error', reject);
    req.end();
  });

function isProjectElectronCommand(command) {
  const normalizedCommand = command.toLowerCase();
  const normalizedCwd = process.cwd().toLowerCase();
  return normalizedCommand.includes(normalizedCwd) && normalizedCommand.includes('electron .');
}

function listElectronProcesses() {
  if (process.platform === 'win32') {
    const output = execSync(
      'powershell -NoLogo -NoProfile -NonInteractive -Command '
        + "\"Get-CimInstance Win32_Process -Filter \\\"Name='electron.exe'\\\" "
        + '| Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"',
      { encoding: 'utf-8' },
    ).trim();

    if (!output) {
      return [];
    }

    const parsed = JSON.parse(output);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries
      .map((entry) => ({
        pid: Number(entry?.ProcessId),
        command: typeof entry?.CommandLine === 'string' ? entry.CommandLine : '',
      }))
      .filter((entry) => Number.isFinite(entry.pid) && entry.command);
  }

  const output = execSync('ps -axo pid=,command=', { encoding: 'utf-8' });
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        command: match[2],
      };
    })
    .filter((entry) => entry !== null);
}

async function killStaleProjectElectronProcesses() {
  try {
    const stalePids = listElectronProcesses()
      .map(({ pid, command }) => {
        if (!isProjectElectronCommand(command) || pid === process.pid) {
          return null;
        }

        return pid;
      })
      .filter((pid) => pid !== null);

    if (stalePids.length === 0) return;

    for (const pid of stalePids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Process may already be gone.
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 800));

    for (const pid of stalePids) {
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  } catch (error) {
    console.warn('[dev-electron] Failed to cleanup stale Electron processes:', error);
  }
}

async function waitForVite() {
  const start = Date.now();
  const explicitPort = process.env.VITE_PORT;
  const candidatePorts = explicitPort
    ? [Number(explicitPort)]
    : Array.from({ length: MAX_VITE_PORT - BASE_VITE_PORT + 1 }, (_, index) => BASE_VITE_PORT + index);
  let lastError;

  while (Date.now() - start < START_TIMEOUT_MS) {
    for (const port of candidatePorts) {
      const targetUrl = `http://localhost:${port}`;
      try {
        const isViteClient = await probeUrl(targetUrl);
        if (!isViteClient) {
          lastError = new Error(`Non-Vite server responded at ${targetUrl}`);
          continue;
        }
        process.env.VITE_PORT = String(port);
        return { port, targetUrl };
      } catch (error) {
        lastError = error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Timed out waiting for Vite dev server on ports ${candidatePorts.join(', ')}: ${lastError?.message || 'unreachable'}`,
  );
}

const runElectron = ({ port }) => {
  const electronBinary = prepareDevElectronBundle({ projectRoot: process.cwd() });
  const args = ['.', '--no-sandbox'];
  if (process.platform === 'linux') {
    args.push('--disable-dev-shm-usage');
  }
  const child = spawn(
    electronBinary,
    args,
    { stdio: 'inherit', env: { ...process.env, VITE_PORT: String(port) } },
  );

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on('error', (err) => {
    console.error(`Failed to launch Electron: ${err.message}`);
    process.exit(1);
  });
};

waitForVite()
  .then(async (result) => {
    await killStaleProjectElectronProcesses();
    runElectron(result);
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
