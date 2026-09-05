import { getRuntimeSystemInfo, showContextMenu, showItemInFolder, type ContextMenuItem } from '@/ipc';
import { getRevealInFileManagerLabel } from './workspacePickerMenu';
import { canUseHostNativeFileManager } from '../remote/workstationConnection';

export async function showFileReferenceContextMenu(
  filePath: string,
  menu: string,
): Promise<void> {
  const items: ContextMenuItem[] = [{ label: 'Copy Path', action: 'copy-path' }];
  if (canUseHostNativeFileManager()) {
    items.push({ label: getRevealInFileManagerLabel(getRuntimeSystemInfo().platform), action: 'reveal' });
  }

  const action = await showContextMenu(items, menu);

  if (action === 'copy-path') {
    await navigator.clipboard.writeText(filePath);
  } else if (action === 'reveal') {
    await showItemInFolder(filePath);
  }
}
