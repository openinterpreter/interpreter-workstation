import { useEffect, useState, useCallback, useRef } from 'react';
import { readFile, writeFile } from '../api';
import { EDITOR_CONTENT_ID } from '../../shared/element-ids';
import { Textarea } from './ui/textarea';
import { SaveStatus, SaveStatusState } from './ui/save-status';
import { openFeedbackPopover } from '../utils/feedback';
import { EditorShell, EditorToolbar } from './EditorShell';
import { useFileRefresh } from '../hooks/useFileRefresh';

interface TextEditorProps {
  filePath: string;
}

const LOADING_DELAY_MS = 150;

export function TextEditor({ filePath }: TextEditorProps) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [showLoading, setShowLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatusState>('saved');
  const [saveTimeout, setSaveTimeout] = useState<number | null>(null);
  const loadingTimerRef = useRef<number | null>(null);
  const contentRef = useRef('');
  const lastSavedContentRef = useRef('');
  const saveStatusRef = useRef<SaveStatusState>('saved');
  const isUserSavingRef = useRef(false);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(() => {
    saveStatusRef.current = saveStatus;
  }, [saveStatus]);

  useEffect(() => {
    return () => {
      if (saveTimeout !== null) {
        clearTimeout(saveTimeout);
      }
      if (loadingTimerRef.current !== null) {
        clearTimeout(loadingTimerRef.current);
      }
    };
  }, [saveTimeout]);

  const loadFile = useCallback(async () => {
    try {
      setLoading(true);
      setShowLoading(false);
      setError(null);

      if (loadingTimerRef.current !== null) {
        clearTimeout(loadingTimerRef.current);
      }
      loadingTimerRef.current = window.setTimeout(() => {
        setShowLoading(true);
      }, LOADING_DELAY_MS);

      const { content: fileContent } = await readFile(filePath);
      lastSavedContentRef.current = fileContent;
      setContent(fileContent);
      setSaveStatus('saved');
    } catch (err: any) {
      console.error('Failed to load file:', err);
      setError(err.message);
    }

    if (loadingTimerRef.current !== null) {
      clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }
    setLoading(false);
    setShowLoading(false);
  }, [filePath]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  const saveContent = useCallback(async (newContent: string) => {
    const previousSavedContent = lastSavedContentRef.current;
    try {
      setSaveStatus('saving');
      isUserSavingRef.current = true;
      lastSavedContentRef.current = newContent;
      await writeFile(filePath, newContent);
      setSaveStatus('saved');
    } catch (err: any) {
      lastSavedContentRef.current = previousSavedContent;
      console.error('Failed to save file:', err);
      setError(err.message);
      setSaveStatus('unsaved');
    }

    isUserSavingRef.current = false;
  }, [filePath]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value;
    setContent(newContent);
    setSaveStatus('unsaved');

    // Clear existing timeout
    if (saveTimeout !== null) {
      clearTimeout(saveTimeout);
    }

    // Set new timeout to save after 1 second
    const timeout = window.setTimeout(() => {
      saveContent(newContent);
    }, 1000);

    setSaveTimeout(timeout);
  };

  useFileRefresh(filePath, async () => {
    if (isUserSavingRef.current || saveStatusRef.current === 'unsaved') {
      return;
    }

    let fileContent: string | null = null;
    try {
      const result = await readFile(filePath);
      fileContent = result.content;
    } catch (err: any) {
      console.error('Failed to refresh file:', err);
      setError(err.message);
    }

    if (fileContent === null) {
      return;
    }

    if (fileContent === lastSavedContentRef.current || fileContent === contentRef.current) {
      lastSavedContentRef.current = fileContent;
      return;
    }

    lastSavedContentRef.current = fileContent;
    setContent(fileContent);
    setSaveStatus('saved');
  });

  if (loading && showLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        Loading file...
      </div>
    );
  }

  if (loading && !showLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-2" style={{ borderBottom: 'var(--border-width) solid var(--border)' }} />
        <div className="flex-1 bg-background" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3">
          <div className="text-muted-foreground">Unable to load this file</div>
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={() => loadFile()}
              className="px-3 py-1.5 text-ui-base rounded-control bg-muted hover:bg-muted/80 text-foreground transition-colors"
            >
              Try again
            </button>
            <button
              onClick={() => openFeedbackPopover()}
              className="px-3 py-1.5 text-ui-base rounded-control bg-muted hover:bg-muted/80 text-foreground transition-colors"
            >
              Report bug
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <EditorShell>
      <EditorToolbar className="px-4">
        <SaveStatus status={saveStatus} />
      </EditorToolbar>
      <Textarea
        value={content}
        onChange={handleChange}
        className="flex-1 p-4 bg-transparent text-foreground font-mono text-ui-base resize-none rounded-control border-0"
        data-testid={EDITOR_CONTENT_ID}
        spellCheck={false}
      />
    </EditorShell>
  );
}
