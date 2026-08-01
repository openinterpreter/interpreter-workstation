import type { BuiltinServerDefinition } from '../../builtinTools';
import { cuaDriverTools } from './tools';

export function isCuaDriverSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'darwin' || platform === 'win32';
}

function cuaDriverServerDescription(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return 'Native Windows desktop computer use through Windows UI Automation and targeted HWND messages';
  }
  return 'Native macOS desktop computer use through Interpreter Computer Use';
}

export const cuaDriverServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-cua-driver',
  name: 'Computer Use',
  description: cuaDriverServerDescription(),
  isBuiltin: true,
  tools: cuaDriverTools,
  resources: [],
  prompts: [],
};
