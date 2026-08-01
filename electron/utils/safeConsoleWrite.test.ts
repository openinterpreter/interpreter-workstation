import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  attachConsoleSinkGuards,
  invokeConsoleSafely,
  isIgnorableConsoleWriteError,
  resetSafeConsoleWriteStateForTests,
} from './safeConsoleWrite';

describe('safeConsoleWrite', () => {
  beforeEach(() => {
    resetSafeConsoleWriteStateForTests();
  });

  test('recognizes common broken stdio errors', () => {
    expect(isIgnorableConsoleWriteError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(true);
    expect(isIgnorableConsoleWriteError(Object.assign(new Error('write EIO'), { code: 'EIO' }))).toBe(true);
    expect(isIgnorableConsoleWriteError(Object.assign(new Error('stream is destroyed'), { code: 'ERR_STREAM_DESTROYED' }))).toBe(true);
    expect(isIgnorableConsoleWriteError(new Error('EPIPE: broken pipe, write'))).toBe(true);
    expect(isIgnorableConsoleWriteError(new Error('Error: write EIO'))).toBe(true);
    expect(isIgnorableConsoleWriteError(new Error('Cannot call write after a stream was destroyed'))).toBe(true);
  });

  test('does not treat arbitrary errors as ignorable', () => {
    expect(isIgnorableConsoleWriteError(new Error('permission denied'))).toBe(false);
    expect(isIgnorableConsoleWriteError(new Error('native EIO outside console write'))).toBe(false);
    expect(isIgnorableConsoleWriteError({ code: 'EACCES' })).toBe(false);
  });

  test('returns false when write fails with ignorable stdio error', () => {
    const result = invokeConsoleSafely(
      () => {
        throw Object.assign(new Error('write EIO'), { code: 'EIO' });
      },
      ['message'],
    );
    expect(result).toBe(false);
  });

  test('disables future writes for a console method after ignorable failure', () => {
    let calls = 0;
    const method = () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      }
    };

    expect(invokeConsoleSafely(method, ['first'])).toBe(false);
    expect(calls).toBe(1);

    expect(invokeConsoleSafely(method, ['second'])).toBe(false);
    expect(calls).toBe(1);
  });

  test('keeps other console methods enabled after one method is disabled', () => {
    const brokenMethod = () => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    };
    let healthyCalls = 0;
    const healthyMethod = () => {
      healthyCalls += 1;
    };

    expect(invokeConsoleSafely(brokenMethod, ['first'])).toBe(false);
    expect(invokeConsoleSafely(healthyMethod, ['second'])).toBe(true);
    expect(healthyCalls).toBe(1);
  });

  test('rethrows non-ignorable failures', () => {
    const failure = new Error('unexpected failure');
    expect(() =>
      invokeConsoleSafely(
        () => {
          throw failure;
        },
        ['message'],
      ),
    ).toThrow(failure);
  });

  test('disables stdout writes after an async stdout error event', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    attachConsoleSinkGuards({
      stdout,
      stderr,
    });

    stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    let calls = 0;
    expect(invokeConsoleSafely(() => {
      calls += 1;
    }, ['message'], 'stdout')).toBe(false);
    expect(calls).toBe(0);
  });

  test('only disables the sink that emitted the async failure', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    attachConsoleSinkGuards({
      stdout,
      stderr,
    });

    stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    let stderrCalls = 0;
    expect(invokeConsoleSafely(() => {
      stderrCalls += 1;
    }, ['message'], 'stderr')).toBe(true);
    expect(stderrCalls).toBe(1);
  });

  test('disables a sink after its stream closes', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    attachConsoleSinkGuards({
      stdout,
      stderr,
    });

    stdout.emit('close');

    let calls = 0;
    expect(invokeConsoleSafely(() => {
      calls += 1;
    }, ['message'], 'stdout')).toBe(false);
    expect(calls).toBe(0);
  });
});
