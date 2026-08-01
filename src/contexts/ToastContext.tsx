import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { AppToast, type ToastVariant } from '../components/ui/AppToast';
import { useLowerLeftNotices } from './LowerLeftNoticesContext';
import { logUserVisibleError } from '../utils/userVisibleErrorLog';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  autoDismissMs?: number;
  actions?: ToastAction[];
  createdAt: number;
}

interface ToastContextType {
  showToast: (message: string, variant: ToastVariant, autoDismissMs?: number, actions?: ToastAction[]) => string;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

const MAX_VISIBLE = 3;

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { upsertNotice, removeNotice } = useLowerLeftNotices();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const visibleToastIdsRef = useRef<Set<string>>(new Set());

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
    removeNotice(id);
  }, [removeNotice]);

  useEffect(() => {
    const nextVisibleIds = new Set(toasts.map((toast) => toast.id));

    visibleToastIdsRef.current.forEach((id) => {
      if (!nextVisibleIds.has(id)) {
        removeNotice(id);
      }
    });

    toasts.forEach((toast) => {
      upsertNotice({
        id: toast.id,
        createdAt: toast.createdAt,
        content: (
          <AppToast
            key={toast.id}
            message={toast.message}
            variant={toast.variant}
            autoDismissMs={toast.autoDismissMs}
            actions={toast.actions}
            onDismiss={() => dismissToast(toast.id)}
          />
        ),
      });
    });

    visibleToastIdsRef.current = nextVisibleIds;
  }, [dismissToast, removeNotice, upsertNotice, toasts]);

  const showToast = useCallback((message: string, variant: ToastVariant, autoDismissMs?: number, actions?: ToastAction[]) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const createdAt = Date.now();

    if (variant === 'error') {
      logUserVisibleError('toast', {
        id,
        message,
        autoDismissMs: autoDismissMs ?? null,
        actions: actions?.map((action) => action.label) ?? null,
      });
    }

    setToasts(prev => {
      const next = [...prev, { id, message, variant, autoDismissMs, actions, createdAt }];
      return next.slice(-MAX_VISIBLE);
    });
    return id;
  }, []);

  return (
    <ToastContext.Provider value={{ showToast, dismissToast }}>
      {children}
    </ToastContext.Provider>
  );
}
