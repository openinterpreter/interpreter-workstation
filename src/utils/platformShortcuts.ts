import { getRuntimeSystemInfo } from '@/ipc';

export type ShortcutPlatform = ReturnType<typeof getRuntimeSystemInfo>['platform'];
export type ShortcutToken = 'primary' | 'shift' | 'alt' | 'control' | string;

export function getShortcutPlatform(): ShortcutPlatform {
  return getRuntimeSystemInfo().platform;
}

export function isMacPlatform(platform: ShortcutPlatform = getShortcutPlatform()): boolean {
  return platform === 'darwin';
}

export function getPrimaryModifierKey(platform: ShortcutPlatform = getShortcutPlatform()): 'Meta' | 'Control' {
  return isMacPlatform(platform) ? 'Meta' : 'Control';
}

export function hasPrimaryModifier(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>,
  platform: ShortcutPlatform = getShortcutPlatform(),
): boolean {
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey;
}

export function getPrimaryModifierLabel(platform: ShortcutPlatform = getShortcutPlatform()): string {
  return isMacPlatform(platform) ? '⌘' : 'Ctrl';
}

function formatLiteralKey(token: string): string {
  return token.length === 1 && /[a-z0-9]/i.test(token) ? token.toUpperCase() : token;
}

function formatShortcutToken(token: ShortcutToken, platform: ShortcutPlatform): string {
  switch (token) {
    case 'primary':
      return isMacPlatform(platform) ? '⌘' : 'Ctrl';
    case 'shift':
      return isMacPlatform(platform) ? '⇧' : 'Shift';
    case 'alt':
      return isMacPlatform(platform) ? '⌥' : 'Alt';
    case 'control':
      return isMacPlatform(platform) ? '⌃' : 'Ctrl';
    default:
      return formatLiteralKey(token);
  }
}

export function formatShortcut(
  tokens: ShortcutToken[],
  platform: ShortcutPlatform = getShortcutPlatform(),
): string {
  const resolvedTokens = tokens.map((token) => formatShortcutToken(token, platform));
  return isMacPlatform(platform) ? resolvedTokens.join('') : resolvedTokens.join('+');
}

export function formatPrimaryShortcut(
  key: string,
  platform: ShortcutPlatform = getShortcutPlatform(),
): string {
  return formatShortcut(['primary', key], platform);
}

export function formatShiftedPrimaryShortcut(
  key: string,
  platform: ShortcutPlatform = getShortcutPlatform(),
): string {
  return formatShortcut(['primary', 'shift', key], platform);
}
