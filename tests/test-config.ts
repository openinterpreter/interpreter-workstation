import path from 'path';

/**
 * Configuration for test infrastructure
 * External test suites can configure these paths to use the shared test utilities
 */
export interface TestConfig {
  /** Path to the built Electron main.js */
  electronMainPath: string;
  /** Path to the test-runs output directory */
  testRunsDir: string;
  /** Path to the application logs directory */
  logsDir: string;
}

// Default configuration (for tests running from agent directory)
const defaultConfig: TestConfig = {
  electronMainPath: path.join(process.cwd(), 'dist-electron/electron/main.cjs'),
  testRunsDir: path.join(process.cwd(), 'test-runs'),
  logsDir: path.join(process.cwd(), 'logs'),
};

let currentConfig: TestConfig = { ...defaultConfig };

/**
 * Configure the test infrastructure for external use
 * Call this before running tests to set up paths
 */
export function configureTests(config: Partial<TestConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

/**
 * Get the current test configuration
 */
export function getTestConfig(): TestConfig {
  return currentConfig;
}

/**
 * Reset configuration to defaults
 */
export function resetTestConfig(): void {
  currentConfig = { ...defaultConfig };
}

/**
 * Helper to create config for external test suites
 * @param agentDir - Path to the agent directory (where the Electron app is built)
 * @param taskDir - Path to the external task directory (where tests and outputs go)
 */
export function createExternalConfig(agentDir: string, taskDir: string): TestConfig {
  return {
    electronMainPath: path.join(agentDir, 'dist-electron/electron/main.cjs'),
    testRunsDir: path.join(taskDir, 'test-runs'),
    logsDir: path.join(agentDir, 'logs'),
  };
}
