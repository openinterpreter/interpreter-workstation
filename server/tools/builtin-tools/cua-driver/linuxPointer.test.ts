import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { linuxPixelClickArgs } from './linuxPointer';

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
