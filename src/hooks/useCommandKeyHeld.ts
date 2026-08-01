import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getPrimaryModifierKey,
  hasPrimaryModifier,
} from '../utils/platformShortcuts';

/**
 * Detects when the primary shortcut modifier is held for 150ms+.
 * Uses Command on macOS and Control on Windows/Linux.
 *
 * - keydown primary modifier → start 150ms timer → set isCommandHeld = true
 * - keyup primary modifier → immediately clear everything
 * - keydown where the primary modifier is held (excluding pure modifier keys) → set activatedKey, clear after 300ms
 * - window blur → clear everything
 */
export function useCommandKeyHeld() {
  const [isCommandHeld, setIsCommandHeld] = useState(false);
  const [activatedKey, setActivatedKey] = useState<string | null>(null);
  const primaryModifierKey = getPrimaryModifierKey();

  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modifierDownRef = useRef(false);

  const clearAll = useCallback(() => {
    modifierDownRef.current = false;
    setIsCommandHeld(false);
    setActivatedKey(null);
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (activatedTimerRef.current) {
      clearTimeout(activatedTimerRef.current);
      activatedTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === primaryModifierKey) {
        if (!modifierDownRef.current) {
          modifierDownRef.current = true;
          // Start 150ms timer before showing overlay
          holdTimerRef.current = setTimeout(() => {
            setIsCommandHeld(true);
          }, 75);
        }
        return;
      }

      if (e.key === 'Shift' || e.key === 'Alt' || e.key === 'Control' || e.key === 'Meta') {
        return;
      }

      // A non-modifier key was pressed while the primary modifier is held.
      if (hasPrimaryModifier(e) && modifierDownRef.current) {
        const key = e.key.toUpperCase();
        setActivatedKey(key);

        // Clear activated key after 300ms
        if (activatedTimerRef.current) {
          clearTimeout(activatedTimerRef.current);
        }
        activatedTimerRef.current = setTimeout(() => {
          setActivatedKey(null);
        }, 300);
        // The shortcut fires, so clear the overlay immediately.
        clearAll();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === primaryModifierKey) {
        clearAll();
      }
    };

    const handleBlur = () => {
      clearAll();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', handleBlur);
      clearAll();
    };
  }, [clearAll, primaryModifierKey]);

  return { isCommandHeld, activatedKey };
}
