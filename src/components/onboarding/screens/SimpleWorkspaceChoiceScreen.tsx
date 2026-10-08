import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { openFolderDialog, pathBasename, workspace as workspaceIpc } from '@/ipc';
import { OnboardingHeading, OnboardingScreenShell, OnboardingSection } from '../components/OnboardingScreenShell';
import { useOnboarding } from '../OnboardingContext';

export function SimpleWorkspaceChoiceScreen({ onFinish }: { onFinish: () => void | Promise<void> }) {
  const { currentStep, setFooterConfig } = useOnboarding();
  const stepRef = useRef(currentStep);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void workspaceIpc.getSimple()
      .then((result: { workspacePath: string }) => setWorkspacePath(result.workspacePath))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not load the Simple workspace.'));
  }, []);

  const chooseFolder = useCallback(async () => {
    const result = await openFolderDialog();
    const path = result.filePaths[0];
    if (!result.canceled && path) setWorkspacePath(path);
  }, []);

  const finish = useCallback(async () => {
    if (!workspacePath || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await workspaceIpc.setSimple({ workspacePath });
      setWorkspacePath(result.workspacePath);
      await onFinish();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not use this folder.');
    } finally {
      setPending(false);
    }
  }, [onFinish, pending, workspacePath]);

  useEffect(() => {
    setFooterConfig({
      step: stepRef.current,
      continueLabel: 'Continue',
      continueDisabled: !workspacePath || pending,
      continueLoading: pending,
      continueAction: () => void finish(),
    });
  }, [finish, pending, setFooterConfig, workspacePath]);

  return (
    <OnboardingScreenShell size="medium" align="center" contentClassName="max-w-[520px]">
      <div className="space-y-6">
        <OnboardingHeading
          title="Choose where Interpreter works"
          description="This private control folder holds Interpreter's durable guidance and conversation context. Interface projects stay in their own folders beside it, never nested inside it. You can change this later in Settings."
        />
        <OnboardingSection tone="muted" padding="md" className="rounded-[20px]">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-[var(--oa-bg-app)]">
              <FolderOpen className="size-4 text-[var(--oa-text-muted)]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-ui-base font-medium text-[var(--oa-text-strong)]">
                {workspacePath ? pathBasename(workspacePath) || 'Interpreter' : 'Loading…'}
              </p>
              <p className="mt-0.5 truncate text-ui-sm text-[var(--oa-text-muted)]" title={workspacePath ?? undefined}>
                {workspacePath ?? 'Preparing the default Documents/Interpreter control folder'}
              </p>
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={() => void chooseFolder()}
              className="shrink-0 rounded-full border border-[var(--oa-border)] px-3 py-2 text-ui-sm font-medium text-[var(--oa-text-strong)] hover:bg-[var(--oa-bg-hover)] disabled:opacity-50"
            >
              Choose folder
            </button>
          </div>
          {error ? <p role="alert" className="mt-3 text-ui-sm text-destructive">{error}</p> : null}
        </OnboardingSection>
      </div>
    </OnboardingScreenShell>
  );
}
