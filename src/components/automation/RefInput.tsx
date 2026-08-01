/**
 * RefInput — A mini TipTap editor for automation block inputs.
 *
 * Supports @ mentions for referencing previous block outputs and constants.
 * Text and mention nodes are serialized back to a string value
 * where mentions become @blockId.path or @constant tokens.
 *
 * Mentions are "resurrected" — when loading a string value, known @tokens
 * are parsed back into mention chip nodes so they render correctly.
 */

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { useEffect, useRef, useMemo, useCallback } from 'react';
import { RefMention } from './mention/RefMentionExtension';
import { createRefMentionSuggestion } from './mention/refMentionSuggestion';
import type { AutomationBlock, BlockOutput, AutomationConstant } from '../../types/automation';

interface RefInputProps {
  value: string;
  onChange: (value: string) => void;
  blocksBefore: AutomationBlock[];
  blockOutputs: Record<string, BlockOutput>;
  constants: AutomationConstant[];
  placeholder?: string;
}

/**
 * Serialize TipTap doc to a string, converting mention nodes to @blockId.path tokens.
 */
function serializeDoc(doc: any): string {
  if (!doc?.content) return '';
  const parts: string[] = [];

  for (const node of doc.content) {
    if (node.type === 'paragraph' || node.type === 'doc') {
      if (node.content) {
        for (const child of node.content) {
          if (child.type === 'text') {
            parts.push(child.text || '');
          } else if (child.type === 'refMention') {
            parts.push(child.attrs?.id || '');
          }
        }
      }
    } else if (node.type === 'text') {
      parts.push(node.text || '');
    } else if (node.type === 'refMention') {
      parts.push(node.attrs?.id || '');
    }
  }

  return parts.join('');
}

/**
 * Parse a serialized string back into TipTap JSON, resurrecting @tokens
 * into mention nodes. Known constants (like @workspace) and block references
 * (like @block_abc123.path) become mention chips; everything else is plain text.
 */
function parseValueToDoc(
  value: string,
  constants: AutomationConstant[],
  blocksBefore: AutomationBlock[]
): any {
  if (!value) {
    return { type: 'doc', content: [{ type: 'paragraph', content: [] }] };
  }

  const content: any[] = [];
  const constantIds = new Set(constants.map(c => c.id));
  const blockIdSet = new Set(blocksBefore.map(b => b.id));

  let remaining = value;

  while (remaining.length > 0) {
    const atIndex = remaining.indexOf('@');
    if (atIndex === -1) {
      content.push({ type: 'text', text: remaining });
      break;
    }

    // Add text before @
    if (atIndex > 0) {
      content.push({ type: 'text', text: remaining.slice(0, atIndex) });
    }

    remaining = remaining.slice(atIndex);
    let matched = false;

    // Try to match a constant (e.g. @workspace)
    // Sort by length descending so longer constants match first
    const sortedConstants = [...constantIds].sort((a, b) => b.length - a.length);
    for (const cId of sortedConstants) {
      if (remaining.startsWith(cId) &&
          (remaining.length === cId.length || !/[a-zA-Z0-9_]/.test(remaining[cId.length]))) {
        const c = constants.find(cn => cn.id === cId)!;
        content.push({
          type: 'refMention',
          attrs: {
            id: c.id,
            label: c.label,
            blockId: '__constants__',
            path: '',
            resolvedValue: c.value,
          },
        });
        remaining = remaining.slice(cId.length);
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Try to match a block reference: @block_[a-z0-9]+(optional path)
      const blockMatch = remaining.match(/^@(block_[a-z0-9]+)((?:\.[a-zA-Z_]\w*|\[\d+])*)/);
      if (blockMatch && blockIdSet.has(blockMatch[1])) {
        const blockId = blockMatch[1];
        const pathStr = blockMatch[2] || '';
        const block = blocksBefore.find(b => b.id === blockId);
        const fullId = `@${blockId}${pathStr}`;
        const subPath = pathStr ? pathStr.slice(1) : '';
        content.push({
          type: 'refMention',
          attrs: {
            id: fullId,
            label: block ? `${block.label}${subPath ? ' → ' + subPath : ''}` : fullId,
            blockId,
            path: subPath,
          },
        });
        remaining = remaining.slice(fullId.length);
        matched = true;
      }
    }

    if (!matched) {
      // No match — treat @ as plain text
      content.push({ type: 'text', text: '@' });
      remaining = remaining.slice(1);
    }
  }

  return {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: content.length > 0 ? content : [],
    }],
  };
}

export function RefInput({ value, onChange, blocksBefore, blockOutputs, constants, placeholder }: RefInputProps) {
  "use no memo";

  const blocksBeforeRef = useRef(blocksBefore);
  blocksBeforeRef.current = blocksBefore;
  const blockOutputsRef = useRef(blockOutputs);
  blockOutputsRef.current = blockOutputs;
  const constantsRef = useRef(constants);
  constantsRef.current = constants;

  const suggestion = useMemo(() => createRefMentionSuggestion(
    () => blocksBeforeRef.current,
    () => blockOutputsRef.current,
    () => constantsRef.current
  ), []);

  const isUpdatingRef = useRef(false);

  const handleUpdate = useCallback(({ editor }: any) => {
    if (isUpdatingRef.current) return;
    const text = serializeDoc(editor.getJSON());
    onChange(text);
  }, [onChange]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        bold: false,
        italic: false,
        strike: false,
        code: false,
        codeBlock: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        heading: false,
        horizontalRule: false,
        paragraph: {},
        hardBreak: false,
      }),
      Placeholder.configure({ placeholder: placeholder || '' }),
      RefMention.configure({ suggestion }),
    ],
    content: parseValueToDoc(value, constants, blocksBefore),
    editable: true,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'outline-none text-ui-sm min-h-[28px] px-2 py-1',
        spellcheck: 'false',
      },
      handleKeyDown: (_view: any, event: KeyboardEvent) => {
        // Prevent Enter from creating new paragraphs — single-line input
        // But allow Enter through when the suggestion popup is visible so it can select an item
        if (event.key === 'Enter' && !event.shiftKey) {
          const popup = document.querySelector('[data-ref-mention-popup]');
          if (popup && (popup as HTMLElement).style.display !== 'none') {
            return false; // Let the suggestion plugin handle Enter
          }
          return true;
        }
        return false;
      },
      handleDrop: (_view: any, event: DragEvent) => {
        const constantData = event.dataTransfer?.getData('application/automation-constant');
        if (constantData) {
          event.preventDefault();
          event.stopPropagation();
          return true; // Handled by the wrapper's onDrop
        }
        return false;
      },
    },
    onUpdate: handleUpdate,
  });

  // Handle constant drops — insert as a mention node
  const handleDrop = useCallback((e: React.DragEvent) => {
    const constantData = e.dataTransfer.getData('application/automation-constant');
    if (!constantData || !editor) return;
    e.preventDefault();
    e.stopPropagation();

    try {
      const { id, label, resolvedValue } = JSON.parse(constantData);
      editor.chain().focus().insertContent([
        {
          type: 'refMention',
          attrs: { id, label, blockId: '__constants__', path: '', resolvedValue: resolvedValue || null },
        },
      ]).run();
    } catch {}
  }, [editor]);

  // Sync external value changes into editor (with resurrection)
  useEffect(() => {
    if (!editor) return;
    const currentText = serializeDoc(editor.getJSON());
    if (currentText !== value) {
      isUpdatingRef.current = true;
      editor.commands.setContent(
        parseValueToDoc(value, constantsRef.current, blocksBeforeRef.current)
      );
      isUpdatingRef.current = false;
    }
  }, [value, editor]);

  return (
    <div
      className="rounded bg-background text-foreground"
      style={{ border: 'var(--border-width) solid var(--border)' }}
      onDrop={handleDrop}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/automation-constant')) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      <EditorContent editor={editor} />
    </div>
  );
}
