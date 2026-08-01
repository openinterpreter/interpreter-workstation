import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { UnlinkedMentionCandidate } from '../utils/unlinkedMentions';
import { findUnlinkedMentionsInText } from '../utils/unlinkedMentions';

export const UNLINKED_MENTION_PLUGIN_KEY = new PluginKey<DecorationSet>('unlinkedMentionSuggestions');

export function buildUnlinkedMentionDecorationAttributes(
  match: ReturnType<typeof findUnlinkedMentionsInText>[number],
  range: { from: number; to: number },
) {
  return {
    class: 'oa-unlinked-mention',
    'data-unlinked-mention': 'true',
    'data-ignore-key': match.ignoreKey,
    'data-target-path': match.targetPath,
    'data-target-label': match.targetLabel,
    'data-target-relative-path': match.targetRelativePath,
    'data-target-wikilink': match.targetWikilink,
    'data-from': String(range.from),
    'data-to': String(range.to),
    tabindex: '0',
    role: 'button',
    'aria-label': `Link mention to ${match.targetLabel}`,
  };
}

function buildDecorations(params: {
  doc: ProseMirrorNode;
  getCandidates: () => UnlinkedMentionCandidate[];
  getIgnoredKeys: () => ReadonlySet<string>;
}): DecorationSet {
  const decorations: Decoration[] = [];
  const candidates = params.getCandidates();
  const ignoredKeys = params.getIgnoredKeys();

  params.doc.descendants((node, position, parent) => {
    if (!node.isText || !node.text) {
      return true;
    }

    if (parent?.type.name === 'codeBlock') {
      return true;
    }

    if (node.marks.some((mark) => mark.type.name === 'link' || mark.type.name === 'code')) {
      return true;
    }

    const matches = findUnlinkedMentionsInText(node.text, candidates, ignoredKeys);
    for (const match of matches) {
      const range = {
        from: position + match.from,
        to: position + match.to,
      };
      decorations.push(
        Decoration.inline(
          range.from,
          range.to,
          buildUnlinkedMentionDecorationAttributes(match, range),
        ),
      );
    }

    return true;
  });

  return DecorationSet.create(params.doc, decorations);
}

export const UnlinkedMentionSuggestions = Extension.create<{
  getCandidates: () => UnlinkedMentionCandidate[];
  getIgnoredKeys: () => ReadonlySet<string>;
}>({
  name: 'unlinkedMentionSuggestions',

  addOptions() {
    return {
      getCandidates: () => [],
      getIgnoredKeys: () => new Set<string>(),
    };
  },

  addStorage() {
    return {
      refresh: () => {},
    };
  },

  addProseMirrorPlugins() {
    const build = (doc: ProseMirrorNode) => buildDecorations({
      doc,
      getCandidates: this.options.getCandidates,
      getIgnoredKeys: this.options.getIgnoredKeys,
    });

    this.storage.refresh = () => {
      const view = this.editor?.view;
      if (!view) {
        return;
      }
      view.dispatch(view.state.tr.setMeta(UNLINKED_MENTION_PLUGIN_KEY, 'refresh'));
    };

    return [
      new Plugin({
        key: UNLINKED_MENTION_PLUGIN_KEY,
        state: {
          init: (_, state) => build(state.doc),
          apply: (transaction, oldState, _previousState, newState) => {
            if (transaction.docChanged || transaction.getMeta(UNLINKED_MENTION_PLUGIN_KEY) === 'refresh') {
              return build(newState.doc);
            }

            return oldState.map(transaction.mapping, transaction.doc);
          },
        },
        props: {
          decorations: (state) => UNLINKED_MENTION_PLUGIN_KEY.getState(state),
        },
      }),
    ];
  },
});
