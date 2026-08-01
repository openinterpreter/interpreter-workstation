import { useEffect, useState } from 'react';
import { getActivitySignals, getWorkspaceType, type ActivitySignals, type WorkspaceTypeInfo } from '../api';
import { isMarketingDemoMode, getMarketingDemoWorkspacePath } from '../demo/marketingDemo';

export interface SuggestionSignals {
  workspace: WorkspaceTypeInfo | null;
  activity: ActivitySignals | null;
  hourOfDay: number;
  dayOfWeek: number;
  loading: boolean;
}

const EMPTY_SIGNALS: SuggestionSignals = {
  workspace: null,
  activity: null,
  hourOfDay: new Date().getHours(),
  dayOfWeek: new Date().getDay(),
  loading: true,
};

const MARKETING_DEMO_SIGNALS: SuggestionSignals = {
  workspace: {
    path: getMarketingDemoWorkspacePath(),
    kind: 'wiki',
    hasObsidianFolder: false,
    hasWikiStructure: true,
    hasIndexMd: true,
    hasLogMd: false,
    markdownFileCount: 2,
    pdfFileCount: 0,
    nonMarkdownFileCount: 2,
    sampled: false,
  },
  activity: {
    recentFiles: [],
    frequentFiles: [],
    frequentSkills: [],
    cardClicks: {},
    frequentActions: [],
    actionCounts: {},
  },
  hourOfDay: new Date().getHours(),
  dayOfWeek: new Date().getDay(),
  loading: false,
};

/**
 * Loads all deterministic signals used to build the new-tab suggestion grid:
 *   - Workspace classification and basic counts
 *   - Behavioral history (recent/frequent files, skills, actions, card clicks)
 *   - Clock context (hour of day, day of week)
 *
 * Refreshes on mount and whenever the supplied refresh key changes.
 */
export function useSuggestionSignals(refreshKey: string | number = 0): SuggestionSignals {
  const marketingDemoMode = isMarketingDemoMode();

  const [signals, setSignals] = useState<SuggestionSignals>(EMPTY_SIGNALS);

  useEffect(() => {
    if (marketingDemoMode) {
      return;
    }

    let cancelled = false;
    setSignals((prev) => ({ ...prev, loading: true }));

    Promise.all([
      getWorkspaceType().catch(() => null),
      getActivitySignals().catch(() => null),
    ]).then(([workspace, activity]) => {
      if (cancelled) return;
      const now = new Date();
      setSignals({
        workspace,
        activity,
        hourOfDay: now.getHours(),
        dayOfWeek: now.getDay(),
        loading: false,
      });
    });

    return () => { cancelled = true; };
  }, [marketingDemoMode, refreshKey]);

  return marketingDemoMode ? MARKETING_DEMO_SIGNALS : signals;
}
