import { useEffect, useState } from 'react';
import { openFolderDialog, uiSettings, workspace } from '@/ipc';
import { isWorkstationReadOnly } from '../../remote/workstationConnection';
import { SettingsRow } from './SettingsSection';

/** The same persisted experience preference is used in every app window. */
export function ExperienceSectionContent() {
  const [advanced, setAdvanced] = useState<boolean | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readOnly = isWorkstationReadOnly();

  useEffect(() => {
    let alive = true;
    void uiSettings.getAdvancedMode()
      .then(({ enabled }: { enabled: boolean }) => { if (alive) setAdvanced(enabled); })
      .catch(() => { if (alive) setError('Could not load the experience preference.'); });
    const unsubscribe = uiSettings.onAdvancedModeChanged(({ enabled }: { enabled: boolean }) => setAdvanced(enabled));
    return () => { alive = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    let alive = true;
    const simpleWorkspace = workspace as typeof workspace & { getSimple?: () => Promise<{ workspacePath: string }> };
    if (!simpleWorkspace.getSimple) return;
    void simpleWorkspace.getSimple().then(({ workspacePath: path }: { workspacePath: string }) => {
      if (alive) setWorkspacePath(path);
    }).catch(() => { if (alive) setError('Could not load the Simple workspace.'); });
    return () => { alive = false; };
  }, []);

  async function selectMode(nextAdvanced: boolean) {
    if (pending || readOnly || advanced === nextAdvanced) return;
    setPending(true);
    setError(null);
    try {
      const result = await uiSettings.setAdvancedMode(nextAdvanced);
      if (!result.success) throw new Error(result.error || 'Could not save the experience preference.');
      setAdvanced(nextAdvanced);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the experience preference.');
    } finally {
      setPending(false);
    }
  }

  async function chooseWorkspace() {
    if (pending || readOnly) return;
    setPending(true);
    setError(null);
    try {
      const result = await openFolderDialog();
      if (result.canceled || !result.filePaths[0]) return;
      const simpleWorkspace = workspace as typeof workspace & {
        setSimple?: (request: { workspacePath: string }) => Promise<{ workspacePath: string }>;
      };
      if (!simpleWorkspace.setSimple) throw new Error('Simple workspace is not available.');
      const saved = await simpleWorkspace.setSimple({ workspacePath: result.filePaths[0] });
      setWorkspacePath(saved.workspacePath);
      window.dispatchEvent(new Event('simple-workspace:changed'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not change the Simple workspace.');
    } finally {
      setPending(false);
    }
  }

  return <>
    <SettingsRow label="Experience" description="Simple opens your interface and one durable conversation. Advanced keeps the existing workspace, tabs, sidebars, and overlay controls.">
      <div role="group" aria-label="Experience" className="flex gap-1 rounded-lg bg-muted p-1">
        <button type="button" aria-pressed={advanced === false} disabled={readOnly || pending || advanced === null}
          onClick={() => void selectMode(false)} className={`rounded-md px-3 py-1.5 text-ui-sm ${advanced === false ? 'bg-background shadow-sm' : ''}`}>Simple</button>
        <button type="button" aria-pressed={advanced === true} disabled={readOnly || pending || advanced === null}
          onClick={() => void selectMode(true)} className={`rounded-md px-3 py-1.5 text-ui-sm ${advanced === true ? 'bg-background shadow-sm' : ''}`}>Advanced</button>
      </div>
    </SettingsRow>
    <SettingsRow label="Simple workspace" description="The interface and its state live on disk in this folder. Interpreter checks the selected path before using it.">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="max-w-[320px] truncate text-ui-sm" title={workspacePath ?? undefined}>{workspacePath ?? 'Loading…'}</span>
        <button type="button" disabled={readOnly || pending || !workspacePath} onClick={() => void chooseWorkspace()}
          className="rounded-md px-2 py-1 text-ui-sm hover:bg-hover" style={{ border: 'var(--border-width) solid var(--border)' }}>Choose folder</button>
      </div>
    </SettingsRow>
    {error && <p role="alert" className="py-2 text-ui-sm text-destructive">{error}</p>}
  </>;
}
