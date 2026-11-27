import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { linuxFocusedKeyboardArgs, linuxPixelClickArgs } from './linuxPointer';

test('Linux pixel clicks use real foreground delivery without changing element or other-platform actions', () => {
  const pixel = { pid: 42, window_id: 99, x: 20, y: 35, count: 2 };
  expect(linuxPixelClickArgs(pixel, 'linux')).toEqual({ ...pixel, delivery_mode: 'foreground' });
  expect(linuxPixelClickArgs(pixel, 'darwin')).toEqual(pixel);
  expect(linuxPixelClickArgs({ pid: 42, window_id: 99, element_index: 7 }, 'linux'))
    .toEqual({ pid: 42, window_id: 99, element_index: 7 });
});

test('app-scoped pixel click invokes the foreground selector at driver dispatch', () => {
  const source = fs.readFileSync(path.join(import.meta.dir, 'tools.ts'), 'utf8');
  const click = source.slice(source.indexOf("if (toolName === 'click')", source.indexOf('async function callMacComputerUseTool(')));
  expect(click).toMatch(/callCuaDriverCli\('click', linuxPixelClickArgs\(\{[\s\S]*?x: args\.x,[\s\S]*?y: args\.y,/);
});

test('Linux window-scoped key, chord and text actions request real foreground delivery', () => {
  const target = { pid: 42, window_id: 99, key: 'tab' };
  expect(linuxFocusedKeyboardArgs(target, 'linux')).toEqual({ ...target, delivery_mode: 'foreground' });
  expect(linuxFocusedKeyboardArgs(target, 'darwin')).toEqual(target);
  expect(linuxFocusedKeyboardArgs({ key: 'tab' }, 'linux')).toEqual({ key: 'tab' });
});

test('app-scoped press_key, hotkey and type_text dispatch through the Linux foreground selector', () => {
  const source = fs.readFileSync(path.join(import.meta.dir, 'tools.ts'), 'utf8');
  const input = source.slice(source.indexOf("if (toolName === 'press_key')", source.indexOf('async function callMacComputerUseTool(')));
  expect(input).toMatch(/callCuaDriverCli\('hotkey', linuxFocusedKeyboardArgs\(\{/);
  expect(input).toMatch(/callCuaDriverCli\('press_key', linuxFocusedKeyboardArgs\(pressArgs\)/);
  expect(input).toMatch(/callCuaDriverCli\('type_text', linuxFocusedKeyboardArgs\(typeArgs\)/);
});
