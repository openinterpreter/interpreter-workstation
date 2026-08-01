import { serializeLocalLinkHref } from './localLinkDetection';

export interface ExplorerAgentReferenceItem {
  path: string;
  name: string;
  type: 'file' | 'directory';
}

export function buildExplorerAgentSearchPrompt(query: string): string {
  return `Find ${JSON.stringify(query.trim())}.`;
}

export function buildExplorerAskAgentPrompt(items: ExplorerAgentReferenceItem[]): string {
  const seenPaths = new Set<string>();
  const serializedMentions = items
    .filter((item) => {
      if (!item.path || seenPaths.has(item.path)) {
        return false;
      }
      seenPaths.add(item.path);
      return true;
    })
    .map((item) => `[${item.name}](${serializeLocalLinkHref({
      path: item.path,
      itemType: item.type,
    })})`);

  return serializedMentions.length > 0 ? `${serializedMentions.join(' ')} ` : '';
}

export function shouldOfferExplorerAgentSearch(query: string, resultCount: number): boolean {
  return query.trim().length > 0 && resultCount === 0;
}
