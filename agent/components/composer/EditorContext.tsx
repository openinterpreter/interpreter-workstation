/**
 * EditorContext
 *
 * Provides access to the Tiptap editor instance across components.
 * Allows DndContext to insert mentions when files/folders/tabs are dropped.
 */

import React, { createContext, useContext } from 'react';
import { Editor } from '@tiptap/react';

interface EditorContextValue {
  editor: Editor | null;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function EditorProvider({ editor, children }: { editor: Editor | null; children: React.ReactNode }) {
  return <EditorContext.Provider value={{ editor }}>{children}</EditorContext.Provider>;
}

export function useEditorContext() {
  const context = useContext(EditorContext);
  if (!context) {
    return { editor: null };
  }
  return context;
}
