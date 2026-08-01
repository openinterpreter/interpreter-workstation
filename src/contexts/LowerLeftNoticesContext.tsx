import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export interface LowerLeftNoticeEntry {
  id: string;
  content: ReactNode;
  createdAt: number;
}

interface LowerLeftNoticesContextType {
  notices: LowerLeftNoticeEntry[];
  upsertNotice: (entry: LowerLeftNoticeEntry) => void;
  removeNotice: (id: string) => void;
}

const LowerLeftNoticesContext = createContext<LowerLeftNoticesContextType | null>(null);

export function useLowerLeftNotices() {
  const context = useContext(LowerLeftNoticesContext);
  if (!context) {
    throw new Error('useLowerLeftNotices must be used within a LowerLeftNoticeProvider');
  }
  return context;
}

export function useLowerLeftNotice(id: string, content: ReactNode | null) {
  const { upsertNotice, removeNotice } = useLowerLeftNotices();
  const createdAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!content) {
      createdAtRef.current = null;
      removeNotice(id);
      return;
    }

    if (createdAtRef.current === null) {
      createdAtRef.current = Date.now();
    }

    upsertNotice({
      id,
      content,
      createdAt: createdAtRef.current,
    });
  }, [content, id, removeNotice, upsertNotice]);

  useEffect(() => () => {
    removeNotice(id);
    createdAtRef.current = null;
  }, [id, removeNotice]);
}

export function LowerLeftNoticeProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<LowerLeftNoticeEntry[]>([]);

  const upsertNotice = useCallback((entry: LowerLeftNoticeEntry) => {
    setNotices((previous) => {
      const index = previous.findIndex((notice) => notice.id === entry.id);
      if (index === -1) {
        return [...previous, entry];
      }

      const next = [...previous];
      next[index] = { ...entry, createdAt: previous[index].createdAt };
      return next;
    });
  }, []);

  const removeNotice = useCallback((id: string) => {
    setNotices((previous) => previous.filter((notice) => notice.id !== id));
  }, []);

  const value = useMemo(() => ({
    notices,
    upsertNotice,
    removeNotice,
  }), [notices, removeNotice, upsertNotice]);

  return (
    <LowerLeftNoticesContext.Provider value={value}>
      {children}
    </LowerLeftNoticesContext.Provider>
  );
}
