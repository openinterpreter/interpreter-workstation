import type { FileTreeNode } from '../../src/components/explorer/types';

export type { FileTreeNode };

// NOTE(victor): react-arborist's isLeaf = !Array.isArray(children). Directories
// with children:undefined cannot expand. We must ensure all dirs have children:[]
export function markResolvedDirs(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.map(n => {
    if (n.type !== 'directory') {
      return { ...n, isResolved: false };
    }
    const wasLoaded = n.children !== undefined;
    return {
      ...n,
      children: wasLoaded ? markResolvedDirs(n.children!) : [],
      isResolved: wasLoaded,
    };
  });
}
