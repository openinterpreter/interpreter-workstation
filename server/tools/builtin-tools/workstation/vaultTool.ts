import type { BuiltinToolDefinition } from '../../builtinTools';
import {
  buildVaultLintReport,
  buildVaultTagSummaries,
  getVaultNoteContext,
  getVaultSnapshot,
  resolveVaultWikilinkPath,
  searchVaultNotes,
} from '../../../utils/vaultIndex';
import type {
  VaultLintReport,
  VaultNoteContext,
  VaultNoteRecord,
  VaultResolvedLink,
  VaultSearchResult,
  VaultSnapshot,
} from '../../../../shared/types/vault';
import {
  checkFileAccessPermissionAsync,
  getFileAccessDeniedMessage,
  resolvePathWithWorkspace,
} from '../../../utils/permissions';
import { getCurrentWorkspace } from '../../../utils/workspace';

type VaultAction =
  | 'snapshot'
  | 'note_context'
  | 'search_notes'
  | 'list_tags'
  | 'notes_with_tag'
  | 'lint'
  | 'resolve_link';

function getWorkspacePath(context?: { workspace?: string }): string | null {
  return context?.workspace ?? getCurrentWorkspace();
}

async function canReadPath(agentId: string | undefined, filePath: string, workspacePath: string): Promise<boolean> {
  if (!agentId) {
    return true;
  }

  return checkFileAccessPermissionAsync(agentId, filePath, 'read', workspacePath);
}

async function filterAccessibleSnapshot(snapshot: VaultSnapshot, agentId: string | undefined): Promise<VaultSnapshot> {
  if (!agentId) {
    return snapshot;
  }

  const accessibility = await Promise.all(
    snapshot.notes.map(async (note) => ({
      path: note.path,
      allowed: await canReadPath(agentId, note.path, snapshot.workspacePath),
    })),
  );

  const allowedPaths = new Set(
    accessibility
      .filter((entry) => entry.allowed)
      .map((entry) => entry.path),
  );

  const filteredNotes: VaultNoteRecord[] = snapshot.notes
    .filter((note) => allowedPaths.has(note.path))
    .map((note) => ({
      ...note,
      outgoingLinks: note.outgoingLinks.filter((link: VaultResolvedLink) => allowedPaths.has(link.resolvedPath)),
      backlinks: note.backlinks.filter((backlink) => allowedPaths.has(backlink.path)),
    }));

  const tagCount = new Set(filteredNotes.flatMap((note) => note.tags)).size;

  return {
    workspacePath: snapshot.workspacePath,
    builtAt: snapshot.builtAt,
    noteCount: filteredNotes.length,
    tagCount,
    notes: filteredNotes,
  };
}

function summarizeSnapshot(snapshot: VaultSnapshot, includeNotes: boolean): unknown {
  if (includeNotes) {
    return snapshot;
  }

  return {
    workspacePath: snapshot.workspacePath,
    builtAt: snapshot.builtAt,
    noteCount: snapshot.noteCount,
    tagCount: snapshot.tagCount,
  };
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function filterSearchResults(
  results: VaultSearchResult[],
  workspacePath: string,
  agentId: string | undefined,
): Promise<VaultSearchResult[]> {
  if (!agentId) {
    return results;
  }

  const accessibility = await Promise.all(
    results.map(async (result) => ({
      result,
      allowed: await canReadPath(agentId, result.path, workspacePath),
    })),
  );

  return accessibility
    .filter((entry) => entry.allowed)
    .map((entry) => entry.result);
}

async function filterNoteContext(
  context: VaultNoteContext,
  agentId: string | undefined,
): Promise<VaultNoteContext> {
  if (
    !agentId
    || !context.note
    || await canReadPath(agentId, context.note.path, context.workspacePath)
  ) {
    return context;
  }

  return {
    workspacePath: context.workspacePath,
    builtAt: context.builtAt,
    noteCount: context.noteCount,
    tagCount: context.tagCount,
    note: null,
  };
}

export const vaultTool: BuiltinToolDefinition = {
  name: 'interpreter_vault',
  description:
    'Inspect the current workspace note graph for wiki workflows. Use this for note search, note context, tags, link resolution, and structural wiki linting before reading or editing many markdown files by hand.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['snapshot', 'note_context', 'search_notes', 'list_tags', 'notes_with_tag', 'lint', 'resolve_link'],
        description:
          'Vault operation to run. snapshot = note-graph summary, note_context = one note with backlinks/links/broken refs, search_notes = rank notes by title/alias/tag, list_tags = all tags with counts, notes_with_tag = notes for one tag, lint = structural wiki health report, resolve_link = resolve a wikilink target to a note path.',
      },
      filePath: {
        type: 'string',
        description:
          'Path to a markdown note for action=note_context. Accepts workspace-relative or absolute paths.',
      },
      query: {
        type: 'string',
        description:
          'Search query for action=search_notes. Supports plain note queries and tag lookups like "tag:research".',
      },
      tag: {
        type: 'string',
        description:
          'Tag name for action=notes_with_tag. Leading # is optional.',
      },
      target: {
        type: 'string',
        description:
          'Wikilink target for action=resolve_link, such as "Page Name" or "folder/page".',
      },
      limit: {
        type: 'number',
        description:
          'Optional result limit for search_notes or list_tags. Default search limit is 20.',
      },
      includeNotes: {
        type: 'boolean',
        description:
          'For action=snapshot only. When true, include every indexed note. Otherwise return only workspace/count metadata.',
      },
    },
    required: ['action'],
  },
  annotations: {
    readOnlyHint: true,
  },
  handler: async (args, context) => {
    const { action } = args as { action?: VaultAction };
    const workspacePath = getWorkspacePath(context);

    if (!workspacePath) {
      return {
        content: [{ type: 'text', text: 'No workspace is open. Open a workspace before using interpreter_vault.' }],
        isError: true,
      };
    }

    if (context?.agentId && !(await canReadPath(context.agentId, workspacePath, workspacePath))) {
      return {
        content: [{ type: 'text', text: getFileAccessDeniedMessage(context.agentId, workspacePath, 'read', workspacePath) }],
        isError: true,
      };
    }

    try {
      if (action === 'snapshot') {
        const includeNotes = Boolean((args as { includeNotes?: boolean }).includeNotes);
        const snapshot = await filterAccessibleSnapshot(await getVaultSnapshot(workspacePath), context?.agentId);
        return {
          content: [{ type: 'text', text: formatJson(summarizeSnapshot(snapshot, includeNotes)) }],
          isError: false,
        };
      }

      if (action === 'note_context') {
        const filePathArg = (args as { filePath?: string }).filePath;
        if (!filePathArg) {
          return {
            content: [{ type: 'text', text: 'The "filePath" parameter is required for action=note_context.' }],
            isError: true,
          };
        }

        const resolvedPath = resolvePathWithWorkspace(filePathArg, workspacePath);
        if (context?.agentId && !(await canReadPath(context.agentId, resolvedPath, workspacePath))) {
          return {
            content: [{ type: 'text', text: getFileAccessDeniedMessage(context.agentId, resolvedPath, 'read', workspacePath) }],
            isError: true,
          };
        }

        const noteContext = await filterNoteContext(await getVaultNoteContext(resolvedPath, workspacePath), context?.agentId);
        return {
          content: [{ type: 'text', text: formatJson(noteContext) }],
          isError: false,
        };
      }

      if (action === 'search_notes') {
        const query = String((args as { query?: string }).query ?? '').trim();
        if (!query) {
          return {
            content: [{ type: 'text', text: 'The "query" parameter is required for action=search_notes.' }],
            isError: true,
          };
        }

        const limit = typeof (args as { limit?: number }).limit === 'number'
          ? (args as { limit?: number }).limit
          : undefined;
        const results = await searchVaultNotes(query, { workspacePath, limit });
        return {
          content: [{
            type: 'text',
            text: formatJson({
              workspacePath,
              query,
              results: await filterSearchResults(results.results, workspacePath, context?.agentId),
            }),
          }],
          isError: false,
        };
      }

      if (action === 'list_tags') {
        const limit = typeof (args as { limit?: number }).limit === 'number'
          ? (args as { limit?: number }).limit
          : undefined;
        const snapshot = await filterAccessibleSnapshot(await getVaultSnapshot(workspacePath), context?.agentId);
        const tags = buildVaultTagSummaries(snapshot, { limit });
        return {
          content: [{ type: 'text', text: formatJson(tags) }],
          isError: false,
        };
      }

      if (action === 'notes_with_tag') {
        const rawTag = String((args as { tag?: string }).tag ?? '').trim().replace(/^#+/, '');
        if (!rawTag) {
          return {
            content: [{ type: 'text', text: 'The "tag" parameter is required for action=notes_with_tag.' }],
            isError: true,
          };
        }

        const snapshot = await filterAccessibleSnapshot(await getVaultSnapshot(workspacePath), context?.agentId);
        const tagSummary = buildVaultTagSummaries(snapshot, { limit: 1000 }).tags.find(
          (entry) => entry.tag.toLowerCase() === rawTag.toLowerCase(),
        );
        return {
          content: [{
            type: 'text',
            text: formatJson({
              workspacePath,
              tag: rawTag,
              noteCount: tagSummary?.noteCount ?? 0,
              notes: tagSummary?.notes ?? [],
            }),
          }],
          isError: false,
        };
      }

      if (action === 'lint') {
        const snapshot = await filterAccessibleSnapshot(await getVaultSnapshot(workspacePath), context?.agentId);
        const report: VaultLintReport = buildVaultLintReport(snapshot);
        return {
          content: [{ type: 'text', text: formatJson(report) }],
          isError: false,
        };
      }

      if (action === 'resolve_link') {
        const target = String((args as { target?: string }).target ?? '').trim();
        if (!target) {
          return {
            content: [{ type: 'text', text: 'The "target" parameter is required for action=resolve_link.' }],
            isError: true,
          };
        }

        const resolvedPath = await resolveVaultWikilinkPath(target, workspacePath);
        if (!resolvedPath) {
          return {
            content: [{ type: 'text', text: formatJson({ workspacePath, target, resolvedPath: null }) }],
            isError: false,
          };
        }

        if (context?.agentId && !(await canReadPath(context.agentId, resolvedPath, workspacePath))) {
          return {
            content: [{ type: 'text', text: getFileAccessDeniedMessage(context.agentId, resolvedPath, 'read', workspacePath) }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: formatJson({ workspacePath, target, resolvedPath }) }],
          isError: false,
        };
      }

      return {
        content: [{ type: 'text', text: `Unknown action "${String(action)}".` }],
        isError: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to inspect vault: ${message}` }],
        isError: true,
      };
    }
  },
};
