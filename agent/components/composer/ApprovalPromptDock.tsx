import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Circle, Loader2 } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { approvals as approvalsIpc, settings as settingsIpc } from '../../../src/ipc';
import { useLayout } from '../../../src/hooks/useLayout';
import { buildApprovalQueueItems, filterApprovalQueueItems } from '../../../src/lib/approvals/approvalQueue';
import {
  ApprovalSupportContent,
  PermissionCardDraftFields,
  initialPermissionCardDraftValues,
  normalizeApprovalCopy,
  normalizeApprovalOptionCopy,
  permissionCardDraftAnswers,
} from '../../../src/components/approvals/ApprovalSupportContent';
import { Button } from '../../../src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../src/components/ui/tooltip';
import type { Question, QuestionRequest, QuestionResponse, QuestionResult } from '../../../shared/types/approval';

interface QuestionSettings {
  enabled: boolean;
  seconds: number;
}

const DEFAULT_TIMEOUT_SECONDS = 15;
const DOCK_EASE = [0.22, 1, 0.36, 1] as const;

function dockTransition(reduced: boolean) {
  return reduced
    ? { duration: 0 }
    : {
      type: 'spring' as const,
      stiffness: 170,
      damping: 26,
      mass: 1.02,
    };
}

function ownerAccentStyle(ownerColor: string | undefined) {
  return ownerColor ? { boxShadow: `inset 3px 0 0 ${ownerColor}` } : undefined;
}

function getTitle(approval: QuestionRequest): string {
  if (typeof approval.context?.message === 'string' && approval.context.message.trim()) {
    return normalizeApprovalCopy(approval.context.message);
  }

  if (typeof approval.context?.description === 'string' && approval.context.description.trim()) {
    return normalizeApprovalCopy(approval.context.description);
  }

  const first = approval.questions?.[0];
  if (approval.isSimpleApproval) {
    return 'Permission required';
  }
  if (first?.header) {
    return first.header;
  }
  if (approval.questions.length > 1) {
    return `${approval.questions.length} questions`;
  }
  return 'Choose an option';
}

function getCaption(approval: QuestionRequest): string {
  void approval;
  return '';
}

function supportsSessionApproval(approval: QuestionRequest): boolean {
  return approval.context?.sessionAware === true;
}

function getApprovalAppIcon(approval: QuestionRequest): { src: string; label: string } | null {
  const src = typeof approval.context?.appIconDataUrl === 'string'
    ? approval.context.appIconDataUrl.trim()
    : '';
  if (!src.startsWith('data:image/')) {
    return null;
  }
  const label = typeof approval.context?.appIconLabel === 'string' && approval.context.appIconLabel.trim()
    ? approval.context.appIconLabel.trim()
    : 'Target app';
  return { src, label };
}

function getQuickActionQuestion(request: QuestionRequest): Question | null {
  const questions = request.questions ?? [];
  if (questions.length !== 1) {
    return null;
  }

  const [question] = questions;
  if (
    !question
    || question.multiSelect
    || question.allowOther
    || question.optional
    || question.options.length === 0
  ) {
    return null;
  }

  return question;
}

function getQuickActionButtonVariant(value: string, recommended: boolean | undefined): 'default' | 'secondary' | 'utility' {
  if (recommended) {
    return 'default';
  }

  const normalized = value.toLowerCase();
  if (normalized.includes('deny') || normalized.includes('decline') || normalized.includes('cancel')) {
    return 'utility';
  }

  return 'secondary';
}

function ApprovalActionButton(props: {
  label: string;
  description?: string;
  variant: 'default' | 'secondary' | 'utility';
  disabled?: boolean;
  busyLabel: string;
  busy: boolean;
  onClick: () => void;
}) {
  const buttonClassName = "h-auto max-w-full min-h-[var(--oa-control-h-md)] justify-start whitespace-normal px-4 py-2.5 text-left leading-5 [overflow-wrap:anywhere]";
  const button = (
    <Button
      type="button"
      variant={props.variant}
      size="default"
      className={`rounded-[14px] ${buttonClassName}`}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.busy ? props.busyLabel : props.label}
    </Button>
  );

  if (!props.description?.trim()) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {button}
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm whitespace-normal leading-5">
        {props.description.trim()}
      </TooltipContent>
    </Tooltip>
  );
}

function getDefaultAnswer(question: Question): string | string[] | undefined {
  if (question.default !== undefined) {
    return question.default;
  }

  if (question.options.length === 0) {
    return undefined;
  }

  const picked = question.options.find((option) => option.recommended) ?? question.options[0];
  if (!picked) {
    return undefined;
  }

  return question.multiSelect ? [picked.value] : picked.value;
}

function buildQuestionDefaults(questions: Question[]): QuestionResponse {
  const result: QuestionResponse = {};

  questions.forEach((question, index) => {
    const value = getDefaultAnswer(question);
    if (value !== undefined) {
      result[String(index)] = value;
    }
  });

  return result;
}

function mergeQuestionAnswers(
  base: QuestionResponse,
  selected: Record<number, boolean>,
  values: Record<number, string>,
): QuestionResponse {
  const result: QuestionResponse = { ...base };

  Object.entries(selected).forEach(([key, enabled]) => {
    if (!enabled) {
      return;
    }

    const index = Number(key);
    const value = values[index]?.trim();
    if (!value) {
      return;
    }

    result[String(index)] = value;
  });

  return result;
}

export function QuestionPrompt(props: {
  request: QuestionRequest;
  pendingCount: number;
  settings: QuestionSettings;
  busy: boolean;
  ownerColor?: string;
  onRespond: (result: QuestionResult) => Promise<void>;
}) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const questions = props.request.questions ?? [];
  const [answers, setAnswers] = useState<QuestionResponse>({});
  const [otherValues, setOtherValues] = useState<Record<number, string>>({});
  const [otherSelected, setOtherSelected] = useState<Record<number, boolean>>({});
  const [index, setIndex] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);

  useEffect(() => {
    setAnswers({});
    setOtherValues({});
    setOtherSelected({});
    setIndex(0);
    setTimeRemaining(null);
  }, [props.request.id]);

  const current = questions[index];
  const optional = Boolean(current?.optional);
  const last = index === questions.length - 1;

  const canAdvance = useCallback(() => {
    if (!current) {
      return false;
    }

    const answer = answers[String(index)];
    const hasOther = Boolean(otherSelected[index] && otherValues[index]?.trim());

    if (Array.isArray(answer)) {
      return answer.length > 0 || hasOther || optional;
    }

    return Boolean((typeof answer === 'string' && answer.length > 0) || hasOther || optional);
  }, [answers, current, index, optional, otherSelected, otherValues]);

  const handleOptionSelect = useCallback((value: string) => {
    if (!current) {
      return;
    }

    setTimeRemaining(null);
    setAnswers((previous) => {
      const key = String(index);
      if (current.multiSelect) {
        const next = Array.isArray(previous[key]) ? previous[key] : [];
        const exists = next.includes(value);
        return {
          ...previous,
          [key]: exists ? next.filter((item) => item !== value) : [...next, value],
        };
      }

      return {
        ...previous,
        [key]: value,
      };
    });
  }, [current, index]);

  const handleSkip = useCallback(async () => {
    await props.onRespond({
      answers: buildQuestionDefaults(questions),
      skipped: true,
    });
  }, [props, questions]);

  const handleSubmit = useCallback(async () => {
    await props.onRespond({
      answers: mergeQuestionAnswers(answers, otherSelected, otherValues),
    });
  }, [answers, otherSelected, otherValues, props]);

  useEffect(() => {
    if (!current || !optional || !props.settings.enabled) {
      setTimeRemaining(null);
      return;
    }

    setTimeRemaining(props.settings.seconds || DEFAULT_TIMEOUT_SECONDS);
  }, [current, optional, props.settings.enabled, props.settings.seconds]);

  useEffect(() => {
    if (timeRemaining === null || timeRemaining <= 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setTimeRemaining((value) => {
        if (value === null) {
          return null;
        }

        if (value <= 1) {
          window.clearInterval(timer);
          return 0;
        }

        return value - 1;
      });
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [timeRemaining]);

  useEffect(() => {
    if (timeRemaining !== 0 || !current || props.busy) {
      return;
    }

    const key = String(index);
    const fallback = answers[key] ?? getDefaultAnswer(current);
    const next = fallback === undefined ? answers : { ...answers, [key]: fallback };

    if (!last) {
      setAnswers(next);
      setIndex((value) => Math.min(value + 1, questions.length - 1));
      return;
    }

    void props.onRespond({
      answers: mergeQuestionAnswers(next, otherSelected, otherValues),
      timedOut: true,
      timeoutSeconds: props.settings.seconds || DEFAULT_TIMEOUT_SECONDS,
    });
  }, [
    answers,
    current,
    index,
    last,
    otherSelected,
    otherValues,
    props.busy,
    props.onRespond,
    props.settings.seconds,
    questions.length,
    timeRemaining,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!current || props.busy) {
        return;
      }

      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      const key = Number.parseInt(event.key, 10);
      if (Number.isInteger(key) && key >= 1 && key <= 9) {
        const option = current.options[key - 1];
        if (!option) {
          return;
        }

        event.preventDefault();
        handleOptionSelect(option.value);
        return;
      }

      if (event.key === 'Enter' && canAdvance()) {
        event.preventDefault();
        if (last) {
          void handleSubmit();
          return;
        }

        setIndex((value) => Math.min(value + 1, questions.length - 1));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [canAdvance, current, handleOptionSelect, handleSubmit, last, props.busy, questions.length]);

  if (!current) {
    return null;
  }

  const selected = answers[String(index)];
  const picked = (value: string) => (
    Array.isArray(selected) ? selected.includes(value) : selected === value
  );
  const stepTransition = reduced ? { duration: 0 } : { duration: 0.24, ease: DOCK_EASE };

  return (
    <motion.div
      layout
      transition={dockTransition(Boolean(reduced))}
      className="oa-dock-prompt"
      data-component="dock-prompt"
      data-kind="question"
      style={ownerAccentStyle(props.ownerColor)}
    >
      <div data-dock-surface="shell" data-slot="question-body">
        <div className="oa-question-body">
          <div className="oa-dock-header" data-slot="question-header">
            <div>
              <div className="oa-dock-title" data-slot="question-header-title">{getTitle(props.request)}</div>
              {props.pendingCount > 1 ? (
                <div className="oa-dock-caption">{props.pendingCount} requests waiting</div>
              ) : null}
            </div>
            <div className="oa-question-progress" data-slot="question-progress">
              {questions.map((question, questionIndex) => {
                const value = answers[String(questionIndex)];
                const answered = Array.isArray(value) ? value.length > 0 : Boolean(value);

                return (
                  <button
                    key={`${question.header ?? 'q'}-${questionIndex}`}
                    type="button"
                    className="oa-question-segment"
                    data-slot="question-progress-segment"
                    data-active={questionIndex === index ? 'true' : 'false'}
                    data-answered={answered ? 'true' : 'false'}
                    disabled={props.busy}
                    onClick={() => {
                      setIndex(questionIndex);
                      setTimeRemaining(null);
                    }}
                  />
                );
              })}
            </div>
          </div>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={`${props.request.id}-${index}`}
              initial={reduced ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? undefined : { opacity: 0, y: -8 }}
              transition={stepTransition}
              className="space-y-4"
            >
              {current.header ? (
                <div className="oa-question-header">{current.header}</div>
              ) : null}
              <div className="oa-question-text">{current.question}</div>
              <div className="oa-question-hint">
                {current.multiSelect ? 'Select one or more options.' : 'Select one option.'}
                {optional && props.settings.enabled && timeRemaining !== null ? ` Auto-selecting in ${timeRemaining}s.` : ''}
              </div>

              <div className="oa-question-options">
                {current.options.map((option, optionIndex) => {
                  const displayOption = normalizeApprovalOptionCopy(props.request, option);
                  const active = picked(option.value);

                  return (
                    <button
                      key={`${option.value}-${optionIndex}`}
                      type="button"
                      className="oa-question-option"
                      data-slot="question-option"
                      data-picked={active ? 'true' : 'false'}
                      disabled={props.busy}
                      onClick={() => handleOptionSelect(option.value)}
                    >
                      <span
                        className="oa-question-check"
                        data-slot="question-option-check"
                        data-picked={active ? 'true' : 'false'}
                        data-type={current.multiSelect ? 'checkbox' : 'radio'}
                      >
                        {current.multiSelect ? (
                          <Check className="size-3" />
                        ) : (
                          <Circle className="size-2.5 fill-current stroke-none" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block text-[14px] font-medium text-[var(--oa-text-strong)]">
                          {displayOption.label}
                        </span>
                        {displayOption.description ? (
                          <span className="mt-0.5 block text-[13px] leading-5 text-[var(--oa-text-muted)]">
                            {displayOption.description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}

                {current.allowOther ? (
                  <label className="oa-question-other">
                    <input
                      type="checkbox"
                      checked={Boolean(otherSelected[index])}
                      onChange={(event) => {
                        setTimeRemaining(null);
                        setOtherSelected((previous) => ({
                          ...previous,
                          [index]: event.target.checked,
                        }));
                      }}
                    />
                    <span>{t('common.other')}</span>
                  </label>
                ) : null}

                {current.allowOther && otherSelected[index] ? (
                  <input
                    value={otherValues[index] ?? ''}
                    onChange={(event) => {
                      setTimeRemaining(null);
                      setOtherValues((previous) => ({
                        ...previous,
                        [index]: event.target.value,
                      }));
                    }}
                    placeholder={t('approvals.enterCustomAnswer')}
                    className="oa-question-input"
                    disabled={props.busy}
                  />
                ) : null}
              </div>
            </motion.div>
          </AnimatePresence>

          <ApprovalSupportContent approval={props.request} />
        </div>
      </div>

      <div className="oa-dock-actions" data-dock-surface="tray" data-slot="question-footer">
        <Button
          type="button"
          variant="utility"
          size="sm"
          disabled={props.busy}
          onClick={() => {
            void handleSkip();
          }}
        >
          {t('common.skip')}
        </Button>
        <div className="flex items-center gap-2">
          {!last ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={props.busy || !canAdvance()}
              onClick={() => {
                setIndex((value) => Math.min(value + 1, questions.length - 1));
                setTimeRemaining(null);
              }}
            >
              {t('common.next')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={props.busy || !canAdvance()}
            onClick={() => {
              void handleSubmit();
            }}
          >
            {props.busy ? <Loader2 className="size-3.5 animate-spin" /> : t('common.submit')}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

function PermissionPrompt(props: {
  approval: QuestionRequest;
  pendingCount: number;
  busy: boolean;
  ownerColor?: string;
  onApprove: (mode: 'once' | 'session', extraAnswers?: QuestionResponse) => Promise<void>;
  onDeny: () => Promise<void>;
}) {
  const reduced = useReducedMotion();
  const appIcon = getApprovalAppIcon(props.approval);
  const [permissionCardDraft, setPermissionCardDraft] = useState(() => (
    initialPermissionCardDraftValues(props.approval.context?.permissionCard)
  ));
  const extraAnswers = Object.keys(permissionCardDraft).length > 0
    ? permissionCardDraftAnswers(permissionCardDraft)
    : undefined;
  const approve = (mode: 'once' | 'session') => {
    if (extraAnswers) {
      void props.onApprove(mode, extraAnswers);
      return;
    }
    void props.onApprove(mode);
  };

  return (
    <motion.div
      layout
      transition={dockTransition(Boolean(reduced))}
      className="oa-dock-prompt"
      data-component="dock-prompt"
      data-kind="permission"
      style={ownerAccentStyle(props.ownerColor)}
    >
      <div data-dock-surface="shell" data-slot="permission-body">
        <div className="oa-permission-body">
          <div className="oa-permission-head" data-slot="permission-header">
            {appIcon ? (
              <div className="oa-approval-app-icon">
                <img src={appIcon.src} alt={`${appIcon.label} app icon`} />
              </div>
            ) : null}
            <div className="min-w-0 flex-1">
              <div className="oa-dock-title" data-slot="permission-header-title">
                {props.busy ? <Loader2 className="mr-2 inline-flex size-3.5 animate-spin align-[-2px]" /> : null}
                {getTitle(props.approval)}
              </div>
              {props.pendingCount > 1 ? (
                <div className="oa-dock-caption">{props.pendingCount} requests waiting</div>
              ) : null}
              {getCaption(props.approval) ? (
                <div className="oa-dock-caption">{getCaption(props.approval)}</div>
              ) : null}
            </div>
          </div>

          <ApprovalSupportContent approval={props.approval} />
          <PermissionCardDraftFields
            card={props.approval.context?.permissionCard}
            values={permissionCardDraft}
            onChange={setPermissionCardDraft}
            disabled={props.busy}
          />
        </div>
      </div>

      <div className="oa-dock-actions" data-dock-surface="tray" data-slot="permission-footer">
        <Button
          type="button"
          variant="utility"
          size="sm"
          disabled={props.busy}
          onClick={() => {
            void props.onDeny();
          }}
        >
          Don&apos;t allow
        </Button>
        <div className="flex flex-wrap items-start gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-auto max-w-full min-h-[var(--oa-control-h-sm)] justify-start whitespace-normal py-2 text-left leading-5 [overflow-wrap:anywhere]"
            disabled={props.busy}
            onClick={() => {
              approve('once');
            }}
          >
            Allow once
          </Button>
          {supportsSessionApproval(props.approval) ? (
            <Button
              type="button"
              variant="default"
              size="sm"
              className="h-auto max-w-full min-h-[var(--oa-control-h-sm)] justify-start whitespace-normal py-2 text-left leading-5 [overflow-wrap:anywhere]"
              disabled={props.busy}
              onClick={() => {
                approve('session');
              }}
            >
              Allow for this session
            </Button>
          ) : null}
        </div>
      </div>
    </motion.div>
  );
}

function QuickActionPrompt(props: {
  request: QuestionRequest;
  pendingCount: number;
  busy: boolean;
  ownerColor?: string;
  onRespond: (result: QuestionResult) => Promise<void>;
}) {
  const reduced = useReducedMotion();
  const question = getQuickActionQuestion(props.request);

  if (!question) {
    return null;
  }

  return (
    <motion.div
      layout
      transition={dockTransition(Boolean(reduced))}
      className="oa-dock-prompt"
      data-component="dock-prompt"
      data-kind="quick-action"
      style={ownerAccentStyle(props.ownerColor)}
    >
      <div data-dock-surface="shell" data-slot="quick-action-body">
        <div className="oa-permission-body">
          <div className="oa-permission-head" data-slot="quick-action-header">
            <div className="min-w-0 flex-1">
              <div className="oa-dock-title" data-slot="quick-action-header-title">
                {getTitle(props.request)}
              </div>
              {props.pendingCount > 1 ? (
                <div className="oa-dock-caption">{props.pendingCount} requests waiting</div>
              ) : null}
            </div>
          </div>

          <ApprovalSupportContent approval={props.request} />
        </div>
      </div>

      <div className="oa-dock-actions" data-dock-surface="tray" data-slot="quick-action-footer">
        <div className="flex flex-wrap gap-2">
          {question.options.map((option) => {
            const displayOption = normalizeApprovalOptionCopy(props.request, option);
            return (
            <ApprovalActionButton
              key={option.value}
              label={displayOption.label}
              description={displayOption.description}
              variant={getQuickActionButtonVariant(option.value, option.recommended)}
              disabled={props.busy}
              busy={props.busy}
              busyLabel="Working..."
              onClick={() => {
                void props.onRespond({ answers: { '0': option.value } });
              }}
            />
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}

export function ApprovalPromptDock(props: {
  agentId?: string;
}) {
  "use no memo";

  const reduced = useReducedMotion();
  const { state } = useLayout();
  const [approvals, setApprovals] = useState<QuestionRequest[]>([]);
  const [settings, setSettings] = useState<QuestionSettings>({
    enabled: true,
    seconds: DEFAULT_TIMEOUT_SECONDS,
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    approvalsIpc.get({})
      .then((response: { approvals: QuestionRequest[] }) => {
        if (!cancelled) {
          setApprovals(response.approvals);
        }
      })
      .catch(() => {});

    settingsIpc.get()
      .then((config: { questionAutoTimeoutEnabled?: boolean; questionAutoTimeoutSeconds?: number }) => {
        if (!cancelled) {
          setSettings({
            enabled: config.questionAutoTimeoutEnabled ?? true,
            seconds: config.questionAutoTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
          });
        }
      })
      .catch(() => {});

    const unsubscribe = approvalsIpc.onListChanged((event: { approvals: QuestionRequest[] }) => {
      setApprovals(event.approvals);
      setError(null);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const visibleItems = useMemo(() => {
    const items = buildApprovalQueueItems(approvals, state.tabs);
    return filterApprovalQueueItems(items, props.agentId);
  }, [approvals, props.agentId, state.tabs]);

  const visible = visibleItems.map((item) => item.approval);
  const activeItem = visibleItems[0];
  const active = activeItem?.approval;
  const ownerColor = activeItem?.owner.color;
  const quickActionQuestion = active ? getQuickActionQuestion(active) : null;

  const respond = useCallback(async (requestId: string, result: QuestionResult) => {
    setBusyId(requestId);
    setError(null);

    let nextError: string | null = null;
    let response: Awaited<ReturnType<typeof approvalsIpc.respond>> | null = null;
    try {
      response = await approvalsIpc.respond({ id: requestId, result });
    } catch (errorValue) {
      nextError = errorValue instanceof Error ? errorValue.message : 'Unable to resolve approval.';
    }
    if (response && !response.success) {
      nextError = response.error ?? 'Unable to resolve approval.';
    }
    setError(nextError);
    setBusyId((value) => (value === requestId ? null : value));
  }, []);

  const deny = useCallback(async (requestId: string) => {
    setBusyId(requestId);
    setError(null);

    let nextError: string | null = null;
    let response: Awaited<ReturnType<typeof approvalsIpc.deny>> | null = null;
    try {
      response = await approvalsIpc.deny({ id: requestId });
    } catch (errorValue) {
      nextError = errorValue instanceof Error ? errorValue.message : 'Unable to deny approval.';
    }
    if (response && !response.success) {
      nextError = response.error ?? 'Unable to deny approval.';
    }
    setError(nextError);
    setBusyId((value) => (value === requestId ? null : value));
  }, []);

  return (
    <AnimatePresence initial={false}>
      {active ? (
        <motion.div
          key={active.id}
          layout
          initial={reduced ? false : { opacity: 0, y: 18, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduced ? undefined : { opacity: 0, y: 12, scale: 0.985 }}
          transition={dockTransition(Boolean(reduced))}
          className="oa-dock-shell"
        >
          {error ? <div className="oa-dock-error">{error}</div> : null}
          {active.isSimpleApproval ? (
            <PermissionPrompt
              approval={active}
              pendingCount={visible.length}
              busy={busyId === active.id}
              ownerColor={ownerColor}
              onDeny={() => deny(active.id)}
              onApprove={(mode, extraAnswers) => respond(active.id, {
                answers: { '0': 'approve', ...(extraAnswers ?? {}) },
                approvalMode: mode,
              })}
            />
          ) : quickActionQuestion ? (
            <QuickActionPrompt
              request={active}
              pendingCount={visible.length}
              busy={busyId === active.id}
              ownerColor={ownerColor}
              onRespond={(result) => respond(active.id, result)}
            />
          ) : (
            <QuestionPrompt
              request={active}
              pendingCount={visible.length}
              settings={settings}
              busy={busyId === active.id}
              ownerColor={ownerColor}
              onRespond={(result) => respond(active.id, result)}
            />
          )}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
