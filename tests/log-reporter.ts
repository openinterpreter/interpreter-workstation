/**
 * Custom Playwright reporter that captures ALL output to per-test log files.
 *
 * This reporter ensures that Playwright's test output (steps, assertions, errors, timeouts)
 * goes to the same log files as backend and renderer logs.
 */

import type { Reporter, FullConfig, Suite, TestCase, TestResult, TestStep, FullResult } from '@playwright/test/reporter';
import fs from 'fs';
import path from 'path';
import { getTestRunDir } from './test-recorder';

class LogReporter implements Reporter {
  private currentTestLogPath: string | null = null;
  private pendingPlaywrightApiSummary: {
    title: string;
    count: number;
    firstAt: number;
    lastAt: number;
  } | null = null;
  private pendingChunkSummaries = new Map<string, { message: string; count: number }>();
  private firstFailingStepTitle: string | null = null;

  onBegin(_config: FullConfig, _suite: Suite) {
    // Nothing needed - per-test logging starts in onTestBegin
  }

  onTestBegin(test: TestCase, _result: TestResult) {
    const currentTestName = this.sanitizeTestName(test.title);
    const logDir = path.join(getTestRunDir(), 'logs');

    // Store the log path - we use appendFileSync for atomic writes
    // This avoids race conditions with fixtures.ts which also writes to this file
    this.currentTestLogPath = path.join(logDir, `${currentTestName}.log`);
    this.pendingPlaywrightApiSummary = null;
    this.pendingChunkSummaries.clear();
    this.firstFailingStepTitle = null;

    this.writeToLog('PLAYWRIGHT', `=== TEST BEGIN: ${test.title} ===`);
    this.writeToLog('PLAYWRIGHT', `File: ${test.location.file}:${test.location.line}`);
    this.writeToLog('PLAYWRIGHT', `Timeout: ${test.timeout}ms`);
  }

  onStepBegin(_test: TestCase, _result: TestResult, step: TestStep) {
    this.flushPendingChunkSummaries();

    if (step.category === 'test.step') {
      this.flushPendingPlaywrightApiSummary();
      this.writeToLog('PLAYWRIGHT_STEP', `→ ${step.title}`);
    } else if (step.category === 'pw:api') {
      if (this.shouldCoalescePlaywrightApiStep(step.title)) {
        this.bufferPlaywrightApiStep(step.title);
      } else {
        this.flushPendingPlaywrightApiSummary();
        this.writeToLog('PLAYWRIGHT_API', `${step.title}`);
      }
    } else if (step.category === 'expect') {
      this.flushPendingPlaywrightApiSummary();
      this.writeToLog('PLAYWRIGHT_EXPECT', `${step.title}`);
    }
  }

  onStepEnd(_test: TestCase, _result: TestResult, step: TestStep) {
    if (step.error) {
      this.flushPendingChunkSummaries();
      this.flushPendingPlaywrightApiSummary();
      this.firstFailingStepTitle ??= step.title;
      this.writeToLog('PLAYWRIGHT_ERROR', `✗ Step failed: ${step.title}`);
      this.writeToLog('PLAYWRIGHT_ERROR', `  Error: ${step.error.message}`);
      if (step.error.stack) {
        const stackLines = step.error.stack.split('\n').slice(0, 5);
        stackLines.forEach(line => this.writeToLog('PLAYWRIGHT_ERROR', `  ${line}`));
      }
    }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const status = result.status.toUpperCase();
    const duration = result.duration;

    this.flushPendingChunkSummaries();
    this.flushPendingPlaywrightApiSummary();
    this.writeToLog('PLAYWRIGHT', `=== TEST ${status}: ${test.title} (${duration}ms) ===`);
    this.writeToLog(
      'PLAYWRIGHT_SUMMARY',
      `status=${result.status} durationMs=${duration} retry=${result.retry} attachments=${result.attachments.length} firstFailingStep=${JSON.stringify(this.firstFailingStepTitle ?? '')}`,
    );

    if (result.status === 'failed' || result.status === 'timedOut') {
      if (result.error) {
        this.writeToLog('PLAYWRIGHT_FAIL', `Error: ${result.error.message}`);
        if (result.error.stack) {
          this.writeToLog('PLAYWRIGHT_FAIL', `Stack: ${result.error.stack}`);
        }
      }

      for (const attachment of result.attachments) {
        this.writeToLog('PLAYWRIGHT_ATTACHMENT', `${attachment.name}: ${attachment.path || '[inline]'}`);
      }
    }

    if (result.retry > 0) {
      this.writeToLog('PLAYWRIGHT', `Retry: ${result.retry}`);
    }

    // Clear the log path (no stream to close - we use appendFileSync)
    this.currentTestLogPath = null;
  }

  onEnd(result: FullResult) {
    console.log(`[PLAYWRIGHT] Test suite finished with status: ${result.status}`);
  }

  onError(error: any) {
    this.flushPendingChunkSummaries();
    this.flushPendingPlaywrightApiSummary();
    this.writeToLog('PLAYWRIGHT_ERROR', `Global error: ${error.message}`);
    if (error.stack) {
      this.writeToLog('PLAYWRIGHT_ERROR', error.stack);
    }
  }

  onStdOut(chunk: string | Buffer, _test?: TestCase, _result?: TestResult) {
    const text = chunk.toString().trim();
    if (text) {
      this.bufferChunk('STDOUT', text);
    }
  }

  onStdErr(chunk: string | Buffer, _test?: TestCase, _result?: TestResult) {
    const text = chunk.toString().trim();
    if (text) {
      this.bufferChunk('STDERR', text);
    }
  }

  private shouldCoalescePlaywrightApiStep(title: string): boolean {
    return /waitForTimeout|evaluate|waiting for|expect\(locator\)|locator\./i.test(title);
  }

  private bufferPlaywrightApiStep(title: string) {
    const now = Date.now();
    if (this.pendingPlaywrightApiSummary?.title === title) {
      this.pendingPlaywrightApiSummary.count += 1;
      this.pendingPlaywrightApiSummary.lastAt = now;
      return;
    }

    this.flushPendingPlaywrightApiSummary();
    this.pendingPlaywrightApiSummary = {
      title,
      count: 1,
      firstAt: now,
      lastAt: now,
    };
  }

  private flushPendingPlaywrightApiSummary() {
    if (!this.pendingPlaywrightApiSummary) return;

    const { title, count, firstAt, lastAt } = this.pendingPlaywrightApiSummary;
    if (count === 1) {
      this.writeToLog('PLAYWRIGHT_API', title);
    } else {
      this.writeToLog(
        'PLAYWRIGHT_API_SUMMARY',
        `title=${JSON.stringify(title)} repeats=${count} durationMs=${Math.max(0, lastAt - firstAt)}`,
      );
    }
    this.pendingPlaywrightApiSummary = null;
  }

  private bufferChunk(prefix: string, message: string) {
    const pending = this.pendingChunkSummaries.get(prefix);
    if (pending?.message === message) {
      pending.count += 1;
      return;
    }

    this.flushPendingChunkSummary(prefix);
    this.pendingChunkSummaries.set(prefix, { message, count: 1 });
  }

  private flushPendingChunkSummary(prefix: string) {
    const pending = this.pendingChunkSummaries.get(prefix);
    if (!pending) return;

    if (pending.count === 1) {
      this.writeToLog(prefix, pending.message);
    } else {
      this.writeToLog(
        `${prefix}_SUMMARY`,
        `repeated=${pending.count} message=${JSON.stringify(pending.message)}`,
      );
    }
    this.pendingChunkSummaries.delete(prefix);
  }

  private flushPendingChunkSummaries() {
    this.flushPendingChunkSummary('STDOUT');
    this.flushPendingChunkSummary('STDERR');
  }

  private writeToLog(prefix: string, message: string) {
    if (!this.currentTestLogPath) return;

    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${prefix}] ${message}\n`;
    // Use appendFileSync for atomic writes - avoids race conditions with fixtures.ts
    fs.appendFileSync(this.currentTestLogPath, line);
  }

  private sanitizeTestName(title: string): string {
    return title.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  }
}

export default LogReporter;
