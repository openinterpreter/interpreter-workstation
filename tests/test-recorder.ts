import { Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { getTestConfig } from './test-config';

/**
 * Get the current test run directory (finds the most recent one)
 */
export function getTestRunDir(): string {
  const testRunsDir = getTestConfig().testRunsDir;

  // Find the most recent test-runs directory
  const dirs = fs.readdirSync(testRunsDir)
    .filter(f => /^20\d{2}-\d{2}-\d{2}T/.test(f))
    .map(f => ({
      name: f,
      path: path.join(testRunsDir, f),
      mtime: fs.statSync(path.join(testRunsDir, f)).mtime
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  if (dirs.length === 0) {
    throw new Error('No test run directory found');
  }

  return dirs[0].path;
}

/**
 * Get path to test run log file
 */
export function getTestLogPath(): string {
  const runDir = getTestRunDir();
  return path.join(runDir, 'logs', 'test-output.log');
}

/**
 * Record a test by taking screenshots and converting to video
 */
export async function recordTest(page: Page, testName: string) {
  const runDir = getTestRunDir();
  const screenshotsDir = path.join(runDir, 'temp-screenshots', testName);
  fs.mkdirSync(screenshotsDir, { recursive: true });

  const fps = 10; // 10 frames per second
  const interval = 1000 / fps;
  let frameCount = 0;
  let isRecording = true;

  // NOTE: Screenshots are disabled for now - they generate noisy timeout errors in logs
  // and don't provide much value during development. Re-enable when video recording is needed.
  const SCREENSHOTS_DISABLED = true;

  const screenshotInterval = setInterval(async () => {
    if (!isRecording || SCREENSHOTS_DISABLED) {
      clearInterval(screenshotInterval);
      return;
    }

    const framePath = path.join(screenshotsDir, `frame-${String(frameCount).padStart(6, '0')}.png`);
    try {
      await page.screenshot({ path: framePath, timeout: 5000 }); // Shorter timeout
      frameCount++;
    } catch (e) {
      // Page might be closed - silently ignore
      clearInterval(screenshotInterval);
      isRecording = false;
    }
  }, interval);

  return {
    stop: async () => {
      isRecording = false;
      clearInterval(screenshotInterval);

      // Wait longer to ensure any pending screenshots complete
      // Screenshots happen every 100ms, so wait 500ms to be safe
      await new Promise(resolve => setTimeout(resolve, 500));

      if (frameCount === 0) {
        console.log(`⚠️  No frames captured for ${testName}`);
        return;
      }

      console.log(`📹 Captured ${frameCount} frames for ${testName}`);

      // Convert screenshots to video
      const videoPath = path.join(runDir, 'videos', `${testName}.mp4`);

      try {
        // execSync is synchronous - waits for ffmpeg to complete
        execSync(
          `ffmpeg -framerate ${fps} -i "${screenshotsDir}/frame-%06d.png" -c:v libx264 -pix_fmt yuv420p -y "${videoPath}" 2>/dev/null`,
          { stdio: 'ignore' }
        );
        console.log(`✅ Video: ${testName}.mp4`);

        // Wait a moment to ensure ffmpeg has fully released all file handles
        await new Promise(resolve => setTimeout(resolve, 100));

        // Delete screenshots after successful video creation
        try {
          fs.rmSync(screenshotsDir, { recursive: true, force: true });
          console.log(`🗑️  Deleted temp screenshots: ${testName}`);
        } catch (cleanupError) {
          console.warn(`⚠️ Failed to delete temp screenshots for ${testName}:`, cleanupError);
        }
      } catch (e) {
        console.error(`❌ Failed to create video for ${testName}:`, e);
        // Still try to cleanup on failure
        try {
          await new Promise(resolve => setTimeout(resolve, 100));
          fs.rmSync(screenshotsDir, { recursive: true, force: true });
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
      }
    }
  };
}
