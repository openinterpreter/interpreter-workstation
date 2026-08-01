import React, { createContext, useContext, useMemo } from 'react';
import { useCommandKeyHeld } from '../hooks/useCommandKeyHeld';

interface CommandOverlayState {
  isCommandHeld: boolean;
  activatedKey: string | null;
}

const CommandOverlayContext = createContext<CommandOverlayState>({
  isCommandHeld: false,
  activatedKey: null,
});

export function CommandOverlayProvider({ children }: { children: React.ReactNode }) {
  const { isCommandHeld, activatedKey } = useCommandKeyHeld();

  const value = useMemo(() => ({ isCommandHeld, activatedKey }), [isCommandHeld, activatedKey]);

  return (
    <CommandOverlayContext.Provider value={value}>
      {children}
    </CommandOverlayContext.Provider>
  );
}

export function useCommandOverlay() {
  return useContext(CommandOverlayContext);
}
