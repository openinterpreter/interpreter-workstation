import { ElectronInstanceManager } from './electron-instance';
import { getTestRunDir } from './test-recorder';
import path from 'path';

async function globalTeardown() {
  // Print test run completion information
  try {
    const testRunDir = getTestRunDir();
    const logsDir = path.join(testRunDir, 'logs');

    console.log('\n✅ TEST RUN COMPLETED');
    console.log(`📁 Test run directory: ${testRunDir}`);
    console.log(`📝 Session log: ${path.join(logsDir, 'session.log')}`);
    console.log(`📝 Per-test logs: ${logsDir}/<test-name>.log`);
    console.log(`📹 Videos:   ${path.join(testRunDir, 'videos')}`);
    console.log(`📊 Coverage: ${path.join(testRunDir, 'coverage', 'index.html')}`);
    console.log('💡 All logs are unified - frontend, backend, and Playwright events');
    console.log('   are interleaved chronologically in each log file.\n');
  } catch (error) {
    // If we can't get test run dir, just skip the output
  }

  await ElectronInstanceManager.cleanup();
}

export default globalTeardown;
