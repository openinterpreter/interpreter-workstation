/**
 * useSelectionTracking Hook
 *
 * Tracks text selections across the document (code editors, PDFs, textareas).
 * Self-contained — no layout dependencies.
 */

import { useState, useEffect, useRef } from 'react';
import type { Selection } from '../../shared/types/workstation';

export function useSelectionTracking() {
  const [currentSelection, setCurrentSelection] = useState<Selection | null>(null);
  const currentSelectionRef = useRef(currentSelection);

  useEffect(() => { currentSelectionRef.current = currentSelection; }, [currentSelection]);

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const MAX_SELECTION_LENGTH = 10 * 1024;

    const findFilePathFromElement = (element: Element | null): string | null => {
      while (element) {
        const filePath = element.getAttribute('data-file-path');
        if (filePath) return filePath;
        element = element.parentElement;
      }
      return null;
    };

    const countLinesBefore = (text: string, position: number): number => {
      return (text.substring(0, position).match(/\n/g) || []).length + 1;
    };

    const handleDocumentSelection = () => {
      if (debounceTimer) cancelAnimationFrame(debounceTimer as unknown as number);
      debounceTimer = requestAnimationFrame(() => {
        const selection = window.getSelection();
        const isInComposer = (node: Node | null): boolean => {
          if (!node) return false;
          const el = node instanceof Element ? node : node.parentElement;
          return !!el?.closest('[data-testid="main-composer-input"]');
        };

        if (!selection || selection.isCollapsed) {
          if (!isInComposer(selection?.anchorNode ?? null)) setCurrentSelection(null);
          return;
        }

        const text = selection.toString();
        if (!text.trim()) { setCurrentSelection(null); return; }
        if (isInComposer(selection.anchorNode)) return;

        const truncatedText = text.length > MAX_SELECTION_LENGTH
          ? text.substring(0, MAX_SELECTION_LENGTH) + '...[truncated]' : text;

        const anchorNode = selection.anchorNode;
        const anchorElement = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement;

        const pdfViewer = anchorElement?.closest('.pdf-viewer, [data-pdf-viewer]');
        if (pdfViewer) {
          const filePath = findFilePathFromElement(pdfViewer);
          const pageEl = anchorElement?.closest('[data-page-number]');
          const page = pageEl ? parseInt(pageEl.getAttribute('data-page-number') || '1', 10) : 1;
          setCurrentSelection({ type: 'text', text: truncatedText, source: filePath ? { type: 'pdf', path: filePath, page } : { type: 'unknown' } });
          return;
        }

        const editorArea = anchorElement?.closest('[data-file-path]');
        if (editorArea) {
          const filePath = editorArea.getAttribute('data-file-path');
          if (filePath) {
            const editorContent = editorArea.textContent || '';
            const range = selection.getRangeAt(0);
            const pre = range.cloneRange(); pre.selectNodeContents(editorArea); pre.setEnd(range.startContainer, range.startOffset);
            const end = range.cloneRange(); end.selectNodeContents(editorArea); end.setEnd(range.endContainer, range.endOffset);
            setCurrentSelection({ type: 'text', text: truncatedText, source: { type: 'file', path: filePath, startLine: countLinesBefore(editorContent, pre.toString().length), endLine: countLinesBefore(editorContent, end.toString().length) } });
            return;
          }
        }

        setCurrentSelection({ type: 'text', text: truncatedText, source: { type: 'unknown' } });
      }) as unknown as ReturnType<typeof setTimeout>;
    };

    const handleTextareaEvents = (e: Event) => {
      const target = e.target as HTMLTextAreaElement | HTMLInputElement;
      if (!(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) return;
      if ((target.getAttribute('data-testid') || '').includes('rename')) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const { selectionStart, selectionEnd, value } = target;
        if (selectionStart === null || selectionEnd === null || selectionStart === selectionEnd) { setCurrentSelection(null); return; }
        const text = value.substring(selectionStart, selectionEnd);
        if (!text.trim()) { setCurrentSelection(null); return; }
        const truncatedText = text.length > MAX_SELECTION_LENGTH ? text.substring(0, MAX_SELECTION_LENGTH) + '...[truncated]' : text;
        const filePath = findFilePathFromElement(target);
        if (filePath) {
          setCurrentSelection({ type: 'text', text: truncatedText, source: { type: 'file', path: filePath, startLine: countLinesBefore(value, selectionStart), endLine: countLinesBefore(value, selectionEnd) } });
        } else {
          setCurrentSelection({ type: 'text', text: truncatedText, source: { type: 'unknown' } });
        }
      }, 100);
    };

    let isMouseDown = false;
    const handleMouseDown = () => { isMouseDown = true; };
    const handleMouseUp = () => { isMouseDown = false; handleDocumentSelection(); };
    const handleMouseMove = () => { if (isMouseDown) handleDocumentSelection(); };
    const handleKeyDown = (e: KeyboardEvent) => { if (e.shiftKey && (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End')) handleDocumentSelection(); };

    document.addEventListener('selectionchange', handleDocumentSelection);
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleDocumentSelection);
    document.addEventListener('select', handleTextareaEvents);

    return () => {
      if (debounceTimer) cancelAnimationFrame(debounceTimer as unknown as number);
      document.removeEventListener('selectionchange', handleDocumentSelection);
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleDocumentSelection);
      document.removeEventListener('select', handleTextareaEvents);
    };
  }, []);

  return { currentSelection, currentSelectionRef };
}
