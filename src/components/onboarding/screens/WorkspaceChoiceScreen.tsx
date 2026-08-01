/**
 * WorkspaceChoiceScreen
 *
 * Pick the workspace Interpreter will open on startup.
 * Users can start with the sample workspace, choose a detected notes workspace,
 * or point the app at any folder on disk.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Circle, FileText, FolderOpen, LoaderCircle, Notebook, Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import { workspace as workspaceIpc, openFolderDialog, pathBasename } from '@/ipc';
import { detectNoteWorkspaces, type DetectedNoteWorkspace } from '../../../api';
import { NOTE_WORKSPACE_SOURCE_KIND_LABELS } from '../../../utils/workspacePickerMenu';
import {
  buildDetectedWorkspaceSections,
  shouldConstrainDetectedWorkspaceList,
} from '../../../utils/workspaceChoice';
import { usePressState } from '../../ui/usePressState';
import { OnboardingHeading, OnboardingScreenShell, OnboardingSection } from '../components/OnboardingScreenShell';
import { useOnboarding } from '../OnboardingContext';

interface WorkspaceChoiceScreenProps {
  onFinish: () => void;
  align?: 'center' | 'top';
}

type Choice =
  | { kind: 'sample' }
  | { kind: 'detected'; path: string }
  | { kind: 'folder'; path: string };

export function WorkspaceChoiceScreen({
  onFinish,
  align = 'top',
}: WorkspaceChoiceScreenProps) {
  "use no memo";

  const { t } = useTranslation();
  const { currentStep, setFooterConfig } = useOnboarding();
  const stepRef = useRef(currentStep);
  const isSubmittingRef = useRef(false);
  const [noteWorkspaces, setNoteWorkspaces] = useState<DetectedNoteWorkspace[]>([]);
  const [selectedChoice, setSelectedChoice] = useState<Choice>({ kind: 'sample' });
  const [pickedFolderPath, setPickedFolderPath] = useState<string | null>(null);
  const [hasScanned, setHasScanned] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanFailed, setScanFailed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleScanNoteWorkspaces = useCallback(async () => {
    if (scanning || isSubmittingRef.current) {
      return;
    }

    setScanning(true);
    setScanFailed(false);
    try {
      const data = await detectNoteWorkspaces();
      setNoteWorkspaces(data.workspaces);
      setHasScanned(true);
    } catch (error) {
      console.error('[WorkspaceChoiceScreen] Failed to scan note workspaces:', error);
      setNoteWorkspaces([]);
      setHasScanned(true);
      setScanFailed(true);
    } finally {
      setScanning(false);
    }
  }, [scanning]);

  const handlePickFolder = useCallback(async () => {
    if (isSubmittingRef.current) {
      return;
    }

    const result = await openFolderDialog();
    if (result.canceled || result.filePaths.length === 0) {
      return;
    }

    const workspacePath = result.filePaths[0];
    setPickedFolderPath(workspacePath);
    setSelectedChoice({ kind: 'folder', path: workspacePath });
  }, []);

  const commitChoice = useCallback(async () => {
    if (isSubmittingRef.current) {
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      if (selectedChoice.kind === 'sample') {
        const result = await workspaceIpc.createSample();
        if (!result.success) {
          return;
        }
      } else {
        const result = await workspaceIpc.set({ workspacePath: selectedChoice.path });
        if (!result.success) {
          return;
        }
      }
    } catch (error) {
      console.error('[WorkspaceChoiceScreen] Failed to set workspace:', error);
      return;
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }

    onFinish();
  }, [onFinish, selectedChoice]);
  const continueLabel = t('onboarding.nav.continue', 'Continue');

  useEffect(() => {
    setFooterConfig({
      step: stepRef.current,
      continueLabel,
      continueDisabled: isSubmitting,
      continueLoading: isSubmitting,
      continueAction: () => {
        void commitChoice();
      },
    });
  }, [commitChoice, continueLabel, isSubmitting, setFooterConfig]);

  const pickedFolderName = pickedFolderPath
    ? pathBasename(pickedFolderPath) || pickedFolderPath
    : null;

  const detectedSections = useMemo(
    () => buildDetectedWorkspaceSections(noteWorkspaces),
    [noteWorkspaces],
  );
  const constrainDetectedList = shouldConstrainDetectedWorkspaceList(noteWorkspaces.length);

  return (
    <OnboardingScreenShell
      size="medium"
      align={align}
      className={align === 'center' ? 'overflow-auto py-4 sm:py-6' : 'overflow-auto py-8 sm:py-10'}
      contentClassName="max-w-[640px]"
    >
      <div className="space-y-6">
        <OnboardingHeading
          title={t('onboarding.workspaceChoice.title')}
          description={t('onboarding.workspaceChoice.description')}
          className="space-y-3"
          descriptionClassName="max-w-[34rem]"
        />

        <div className="space-y-4" role="radiogroup" aria-label={t('onboarding.workspaceChoice.groupLabel')}>
          <WorkspaceChoiceCard
            icon={<FileText className="size-4" />}
            title={t('onboarding.workspaceChoice.sampleTitle')}
            description={t('onboarding.workspaceChoice.sampleDescription')}
            badge={t('onboarding.workspaceChoice.sampleBadge')}
            selected={selectedChoice.kind === 'sample'}
            disabled={isSubmitting}
            onClick={() => setSelectedChoice({ kind: 'sample' })}
          />

          <OnboardingSection tone="muted" padding="sm" className="space-y-3 rounded-[20px]">
            <div className="flex items-start gap-3 px-1">
              <div className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-[color-mix(in_oklch,var(--oa-bg-subtle)_48%,transparent)] text-[var(--oa-text-muted)]">
                {scanning ? <LoaderCircle className="size-4 animate-spin" /> : <Search className="size-4" />}
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-[14px] font-medium leading-6 text-[var(--oa-text-strong)]">
                  {hasScanned ? t('onboarding.workspaceChoice.detectedTitle') : t('onboarding.workspaceChoice.scanTitle')}
                </p>
                <p className="text-[13px] leading-5 text-[var(--oa-text-muted)]">
                  {scanFailed
                    ? t('onboarding.workspaceChoice.scanFailed')
                    : scanning
                      ? t('onboarding.workspaceChoice.scanning')
                      : hasScanned
                        ? noteWorkspaces.length > 0
                          ? t('onboarding.workspaceChoice.detectedDescription', { count: noteWorkspaces.length })
                          : t('onboarding.workspaceChoice.noDetectedWorkspaces')
                        : t('onboarding.workspaceChoice.scanDescription')}
                </p>
              </div>
              <button
                type="button"
                disabled={scanning || isSubmitting}
                onClick={() => {
                  void handleScanNoteWorkspaces();
                }}
                className="shrink-0 rounded-[12px] border-solid bg-[var(--oa-bg-app)] px-3 py-2 text-ui-sm font-medium text-[var(--oa-text-strong)] transition-[background-color,border-color,opacity] duration-150 hover:bg-[var(--oa-bg-hover)] disabled:opacity-60 [border-width:var(--border-width)]"
              >
                {scanning
                  ? t('onboarding.workspaceChoice.scanButtonScanning')
                  : hasScanned
                    ? t('onboarding.workspaceChoice.scanButtonAgain')
                    : t('onboarding.workspaceChoice.scanButton')}
              </button>
            </div>

            {noteWorkspaces.length > 0 && (
              <div
                className={cn(
                  'space-y-4',
                  constrainDetectedList && 'max-h-[min(20rem,38vh)] overflow-y-auto pr-1 [scrollbar-gutter:stable]',
                )}
              >
                {detectedSections.map((section) => (
                  <div key={section.source} className="space-y-2.5">
                    <p className="px-1 text-ui-sm font-medium text-[var(--oa-text-muted)]">
                      {section.title}
                    </p>
                    <div className="space-y-2">
                      {section.workspaces.map((workspace) => {
                        const isSelected =
                          selectedChoice.kind === 'detected' && selectedChoice.path === workspace.path;

                        return (
                          <WorkspaceChoiceCard
                            key={workspace.path}
                            icon={<Notebook className="size-4" />}
                            title={workspace.name}
                            description={`${NOTE_WORKSPACE_SOURCE_KIND_LABELS[workspace.source]} · ${workspace.path}`}
                            selected={isSelected}
                            disabled={isSubmitting}
                            onClick={() => setSelectedChoice({ kind: 'detected', path: workspace.path })}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </OnboardingSection>

          <WorkspaceChoiceCard
            icon={<FolderOpen className="size-4" />}
            title={pickedFolderName || t('onboarding.workspaceChoice.openFolderTitle')}
            description={pickedFolderPath || t('onboarding.workspaceChoice.openFolderDescription')}
            badge={pickedFolderPath
              ? t('onboarding.workspaceChoice.openFolderSelectedBadge')
              : t('onboarding.workspaceChoice.openFolderBadge')}
            selected={selectedChoice.kind === 'folder'}
            disabled={isSubmitting}
            onClick={() => {
              void handlePickFolder();
            }}
          />
        </div>
      </div>
    </OnboardingScreenShell>
  );
}

function WorkspaceChoiceCard({
  icon,
  title,
  description,
  badge,
  selected,
  disabled = false,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  badge?: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const { pressed, pressProps } = usePressState<HTMLButtonElement>(false);

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      data-pressed={pressed ? 'true' : undefined}
      onPointerDown={pressProps.onPointerDown}
      onPointerUp={pressProps.onPointerUp}
      onPointerLeave={pressProps.onPointerLeave}
      onPointerCancel={pressProps.onPointerCancel}
      onKeyDown={pressProps.onKeyDown}
      onKeyUp={pressProps.onKeyUp}
      onBlur={pressProps.onBlur}
      className={cn(
        'flex w-full items-start gap-3 rounded-[16px] border-solid px-4 py-3.5 text-left transition-[background-color,border-color,box-shadow,transform] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] transform-gpu data-[pressed=true]:scale-[0.985] disabled:opacity-60 [border-width:var(--border-width)] motion-reduce:transform-none motion-reduce:duration-0',
        selected
          ? 'border-[color-mix(in_oklch,var(--oa-text-strong)_18%,var(--oa-border)_82%)] bg-[color-mix(in_oklch,var(--oa-bg-input)_72%,var(--oa-bg-subtle)_28%)] shadow-[0_12px_28px_-24px_var(--shadow-color)]'
          : 'border-[color-mix(in_oklch,var(--oa-border)_70%,transparent)] bg-[color-mix(in_oklch,var(--oa-bg-app)_94%,var(--oa-bg-subtle)_6%)] shadow-[0_8px_24px_-28px_var(--shadow-color)] hover:border-[var(--oa-border-strong)] hover:bg-[var(--oa-bg-hover)]',
      )}
    >
      <div
        className={cn(
          'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[12px] transition-colors duration-150',
          selected
            ? 'bg-[color-mix(in_oklch,var(--oa-bg-subtle)_72%,transparent)] text-[var(--oa-text-strong)]'
            : 'bg-[color-mix(in_oklch,var(--oa-bg-subtle)_38%,transparent)] text-[var(--oa-text-muted)]',
        )}
      >
        {icon}
      </div>

      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="truncate text-[14px] font-medium leading-6 text-[var(--oa-text-strong)]">
            {title}
          </div>
          {badge && (
            <span
              className={cn(
                'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                selected
                  ? 'bg-[color-mix(in_oklch,var(--oa-bg-subtle)_82%,transparent)] text-[var(--oa-text-strong)]'
                  : 'bg-[color-mix(in_oklch,var(--oa-bg-subtle)_58%,transparent)] text-[var(--oa-text-muted)]',
              )}
            >
              {badge}
            </span>
          )}
        </div>
        <p className="truncate text-[13px] leading-5 text-[var(--oa-text-muted)]">
          {description}
        </p>
      </div>

      <div className="mt-1 shrink-0" aria-hidden="true">
        {selected ? (
          <CheckCircle2 className="size-4 text-[var(--oa-text-strong)]" />
        ) : (
          <Circle className="size-4 text-[var(--oa-text-faint)]" />
        )}
      </div>
    </button>
  );
}
