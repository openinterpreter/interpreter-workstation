const MAC_OPTION_NUMBER_SYMBOL_TO_SLOT: Record<string, number> = {
  '¡': 1,
  '™': 2,
  '£': 3,
  '¢': 4,
  '∞': 5,
  '§': 6,
  '¶': 7,
  '•': 8,
  'ª': 9,
};

export interface ProfileShortcutKeyboardEventLike {
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  key: string;
  code: string;
}

export function resolveProfileShortcutSlot(event: ProfileShortcutKeyboardEventLike): number | null {
  if (!event.altKey || event.shiftKey || (!event.metaKey && !event.ctrlKey)) {
    return null;
  }

  const codeMatch = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
  if (codeMatch) {
    return Number(codeMatch[1]);
  }

  if (/^[1-9]$/.test(event.key)) {
    return Number(event.key);
  }

  return MAC_OPTION_NUMBER_SYMBOL_TO_SLOT[event.key] ?? null;
}
