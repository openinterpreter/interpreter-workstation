import { _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { getTestRunDir } from './test-recorder';
import { getTestConfig } from './test-config';

async function globalSetup() {
  console.log('🚀 Starting global Electron instance...');

  const testRunDir = getTestRunDir();
  const logsDir = path.join(testRunDir, 'logs');
  const sessionLogPath = path.join(logsDir, 'session.log');

  // Ensure logs directory exists
  fs.mkdirSync(logsDir, { recursive: true });

  console.log(`📝 Session log: ${sessionLogPath}`);

  const electronApp = await electron.launch({
    args: [
      getTestConfig().electronMainPath,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-software-rasterizer',
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ELECTRON_ENABLE_LOGGING: '1',
      NODE_V8_COVERAGE: path.join(testRunDir, 'coverage-backend'),
      LOG_FILE: sessionLogPath,
    },
    timeout: 30000,
  });

  // Store the electron instance globally so tests can access it
  (global as any).__ELECTRON_APP__ = electronApp;

  console.log('✅ Global Electron instance started');
}

export default globalSetup;
