/**
 * Agent Error Context
 *
 * Unified error handling for agent-related errors.
 * Delegates to the global toast system for display.
 */

import { createContext, useContext, useCallback, type ReactNode } from 'react';
import { useToast } from '../../src/contexts/ToastContext';

interface AgentErrorContextType {
  showError: (message: string) => void;
  clearAllErrors: () => void;
}

const AgentErrorContext = createContext<AgentErrorContextType | null>(null);

export function useAgentError() {
  const context = useContext(AgentErrorContext);
  if (!context) {
    throw new Error('useAgentError must be used within AgentErrorProvider');
  }
  return context;
}

interface AgentErrorProviderProps {
  children: ReactNode;
}

export function AgentErrorProvider({ children }: AgentErrorProviderProps) {
  const { showToast } = useToast();

  const showError = useCallback((message: string) => {
    showToast(message, 'error', 5000);
  }, [showToast]);

  const clearAllErrors = useCallback(() => {
    // Toasts are individually managed by ToastContext now
  }, []);

  return (
    <AgentErrorContext.Provider value={{ showError, clearAllErrors }}>
      {children}
    </AgentErrorContext.Provider>
  );
}
