/**
 * Suggestion card factory.
 *
 * Turns deterministic signals (workspace contents, behavioral history, clock)
 * into a ranked list of CardSpec objects that the new-tab grid renders.
 *
 * The factory is the entire intelligence of the new tab: it reads usage
 * patterns and promotes buttons accordingly. No network calls, no LLM — all
 * local, offline, private.
 */

import type { WorkspaceTypeInfo, ActivitySignals, FileActivity, SkillActivity } from '../../../api';
import {
  buildWikiBootstrapPrompt,
  buildWikiConnectionsPrompt,
  buildWikiIngestPrompt,
  buildWikiLintPrompt,
  buildWikiQueryPrompt,
  shouldOfferBootstrapNudge,
} from './wikiPrompts';

export type CardActionType = 'prompt' | 'open-file' | 'insert-skill' | 'create-note';

export interface CardSkillRef { id: string; name: string; label: string; path: string; title: string; }

export interface CardSpec {
  /** Stable id used for click tracking and dedupe. */
  id: string;
  /** Visual layout hint. */
  kind: 'resume' | 'action' | 'skill' | 'static';
  /** Lucide icon name. */
  icon?: string;
  /** Primary label. */
  title: string;
  /** Secondary line (count, last-opened ago, file path hint). */
  subtitle?: string;
  /** What happens when clicked. */
  actionType: CardActionType;
  /** For actionType=prompt: text inserted into the composer. */
  prompt?: string;
  /** For actionType=open-file: absolute path. */
  filePath?: string;
  /** For actionType=insert-skill: skill metadata. */
  skill?: CardSkillRef;
  /** Ranking priority (higher wins). Also learned from click history. */
  priority: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(ts: number, now: number): string {
  const diffMs = Math.max(0, now - ts);
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function isMarkdown(filename: string): boolean {
  return /\.(md|markdown)$/i.test(filename);
}

function isPdf(filename: string): boolean {
  return /\.pdf$/i.test(filename);
}

function getClickBoost(cardId: string, cardClicks: Record<string, { count: number }> | undefined): number {
  if (!cardClicks) return 0;
  const entry = cardClicks[cardId];
  if (!entry) return 0;
  return Math.min(entry.count * 3, 30);
}

function todayMidnightMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isWithinHours(ts: number, hours: number): boolean {
  return Date.now() - ts < hours * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Card generators
// ---------------------------------------------------------------------------

function resumeCard(file: FileActivity, now: number, cardClicks: Record<string, { count: number }> | undefined): CardSpec {
  const id = `resume:${file.path}`;
  return {
    id,
    kind: 'resume',
    icon: 'FileText',
    title: `Continue ${file.name}`,
    subtitle: `edited ${timeAgo(file.lastOpened, now)}`,
    actionType: 'open-file',
    filePath: file.path,
    priority: 100 + getClickBoost(id, cardClicks),
  };
}

function frequentFileCard(file: FileActivity, cardClicks: Record<string, { count: number }> | undefined): CardSpec {
  const id = `frequent-file:${file.path}`;
  return {
    id,
    kind: 'action',
    icon: isMarkdown(file.name) ? 'FileText' : isPdf(file.name) ? 'FileDown' : 'File',
    title: `Open ${file.name}`,
    subtitle: `opened ${file.count} times`,
    actionType: 'open-file',
    filePath: file.path,
    priority: 60 + Math.min(file.count, 20) + getClickBoost(id, cardClicks),
  };
}

function skillCard(skill: SkillActivity, skillsByName: Map<string, CardSkillRef>, cardClicks: Record<string, { count: number }> | undefined): CardSpec | null {
  const ref = skillsByName.get(skill.skillId) || skillsByName.get(skill.name);
  if (!ref) return null;
  const id = `skill:${ref.id}`;
  return {
    id,
    kind: 'skill',
    icon: 'Sparkles',
    title: ref.label,
    subtitle: `used ${skill.count}×`,
    actionType: 'insert-skill',
    skill: ref,
    priority: 55 + Math.min(skill.count * 2, 30) + getClickBoost(id, cardClicks),
  };
}

// ---------------------------------------------------------------------------
// Workspace-type specific card sets
// ---------------------------------------------------------------------------

function wikiCards(workspace: WorkspaceTypeInfo, cardClicks: Record<string, { count: number }> | undefined): CardSpec[] {
  const cards: CardSpec[] = [];
  const mdCount = workspace.markdownFileCount;

  cards.push({
    id: 'wiki:ingest-url',
    kind: 'action',
    icon: 'FileDown',
    title: 'Ingest a URL into my wiki',
    subtitle: 'one source at a time',
    actionType: 'prompt',
    prompt: buildWikiIngestPrompt(),
    priority: 80 + getClickBoost('wiki:ingest-url', cardClicks),
  });

  if (shouldOfferBootstrapNudge(workspace)) {
    cards.push({
      id: 'wiki:bootstrap-structure',
      kind: 'action',
      icon: 'Notebook',
      title: 'Set up wiki structure',
      subtitle: 'bootstrap before the first ingest',
      actionType: 'prompt',
      prompt: buildWikiBootstrapPrompt('workspace'),
      priority: 78 + getClickBoost('wiki:bootstrap-structure', cardClicks),
    });
  }

  cards.push({
    id: 'wiki:ask',
    kind: 'action',
    icon: 'Search',
    title: 'Ask my wiki',
    subtitle: mdCount > 0 ? `across ${mdCount} pages` : 'query with citations',
    actionType: 'prompt',
    prompt: buildWikiQueryPrompt(),
    priority: 75 + getClickBoost('wiki:ask', cardClicks),
  });

  cards.push({
    id: 'wiki:whats-missing',
    kind: 'action',
    icon: 'ShieldCheck',
    title: "What's missing from my wiki?",
    subtitle: 'orphans, dangling links, gaps',
    actionType: 'prompt',
    prompt: buildWikiLintPrompt(),
    priority: 65 + getClickBoost('wiki:whats-missing', cardClicks),
  });

  cards.push({
    id: 'wiki:find-connections',
    kind: 'action',
    icon: 'Workflow',
    title: 'Find connections',
    subtitle: 'cross-page synthesis',
    actionType: 'prompt',
    prompt: buildWikiConnectionsPrompt(),
    priority: 55 + getClickBoost('wiki:find-connections', cardClicks),
  });

  return cards;
}

function markdownCards(workspace: WorkspaceTypeInfo, cardClicks: Record<string, { count: number }> | undefined): CardSpec[] {
  const cards: CardSpec[] = [];
  const mdCount = workspace.markdownFileCount;

  cards.push({
    id: 'md:summarize-recent',
    kind: 'action',
    icon: 'FileSearch',
    title: mdCount > 0 ? `Summarize my ${mdCount} notes` : 'Summarize my notes',
    subtitle: 'themes and connections',
    actionType: 'prompt',
    prompt: 'Look at the .md files most recently modified in my workspace. For each, give me a 1–2 sentence summary, then tell me what themes tie them together and what I seem to be working toward.\n',
    priority: 75 + getClickBoost('md:summarize-recent', cardClicks),
  });

  cards.push({
    id: 'md:find-topic',
    kind: 'action',
    icon: 'Search',
    title: 'What did I write about…',
    subtitle: 'search across notes',
    actionType: 'prompt',
    prompt: 'Search my markdown files for the topic below. Summarize what I have already said about it across notes, link each relevant note, and call out any contradictions or gaps.\n\nTopic:\n',
    priority: 70 + getClickBoost('md:find-topic', cardClicks),
  });

  cards.push({
    id: 'md:draft-note',
    kind: 'action',
    icon: 'PenTool',
    title: 'Draft a new note',
    subtitle: 'with frontmatter + sections',
    actionType: 'prompt',
    prompt: 'Create a new markdown note on the topic below.\n\nInclude:\n- YAML frontmatter (title, date, tags)\n- A tight intro paragraph\n- 3–5 logical sections\n- [[wikilinks]] to any of my existing notes it should connect to\n\nSave it in the workspace.\n\nTopic:\n',
    priority: 65 + getClickBoost('md:draft-note', cardClicks),
  });

  cards.push({
    id: 'md:turn-into-wiki',
    kind: 'action',
    icon: 'Workflow',
    title: 'Turn these into a wiki',
    subtitle: 'bootstrap with wiki-bootstrap',
    actionType: 'prompt',
    prompt: buildWikiBootstrapPrompt('notes'),
    priority: 50 + getClickBoost('md:turn-into-wiki', cardClicks),
  });

  return cards;
}

function generalCards(cardClicks: Record<string, { count: number }> | undefined): CardSpec[] {
  const cards: CardSpec[] = [];

  cards.push({
    id: 'gen:find-file',
    kind: 'action',
    icon: 'Search',
    title: 'Find something in my workspace',
    subtitle: 'semantic + grep search',
    actionType: 'prompt',
    prompt: 'Search my workspace for the following. Tell me which files are most relevant and summarize what each one says about it.\n\nWhat I\'m looking for:\n',
    priority: 70 + getClickBoost('gen:find-file', cardClicks),
  });

  cards.push({
    id: 'gen:extract-file',
    kind: 'action',
    icon: 'FileSearch',
    title: 'Extract info from a file',
    subtitle: 'structured fields from PDF/DOCX',
    actionType: 'prompt',
    prompt: 'Read the file I reference below and extract the structured information from it — key fields, facts, dates, people, numbers.\n\nReturn the result as a clean markdown table (or JSON if the data is deeply nested). Call out anything ambiguous.\n\nFile:\n',
    priority: 65 + getClickBoost('gen:extract-file', cardClicks),
  });

  cards.push({
    id: 'gen:draft-doc',
    kind: 'action',
    icon: 'PenTool',
    title: 'Draft a document',
    subtitle: 'DOCX, PDF, or markdown',
    actionType: 'prompt',
    prompt: 'Draft a document for me and save it to the workspace.\n\nAsk me first:\n- What format (DOCX, PDF, markdown)?\n- What is the topic and purpose?\n- Who is the audience?\n- Rough length?\n\nThen write a clean draft and save it.\n\n',
    priority: 60 + getClickBoost('gen:draft-doc', cardClicks),
  });

  cards.push({
    id: 'gen:spreadsheet',
    kind: 'action',
    icon: 'Table2',
    title: 'Build a spreadsheet',
    subtitle: 'columns, formulas, chart',
    actionType: 'prompt',
    prompt: 'Create an .xlsx spreadsheet in my workspace.\n\nAsk me:\n- What am I tracking?\n- What columns, and do any need formulas?\n- Should you add sample data or a chart?\n\nThen build it.\n\n',
    priority: 55 + getClickBoost('gen:spreadsheet', cardClicks),
  });

  cards.push({
    id: 'gen:research',
    kind: 'action',
    icon: 'Compass',
    title: 'Research a topic',
    subtitle: 'briefing saved to workspace',
    actionType: 'prompt',
    prompt: 'Research the topic below and produce a short briefing in my workspace.\n\nInclude:\n- The 5 most important facts\n- Credible sources with links\n- Open questions worth following up on\n\nSave the result as a markdown note in the workspace.\n\nTopic:\n',
    priority: 50 + getClickBoost('gen:research', cardClicks),
  });

  return cards;
}

function timeOfDayCards(hourOfDay: number, workspaceKind: WorkspaceTypeInfo['kind'], cardClicks: Record<string, { count: number }> | undefined): CardSpec[] {
  const cards: CardSpec[] = [];
  const isMarkdownish = workspaceKind === 'obsidian-vault' || workspaceKind === 'wiki' || workspaceKind === 'markdown-heavy';

  if (hourOfDay < 12 && isMarkdownish) {
    cards.push({
      id: 'time:daily-note',
      kind: 'action',
      icon: 'Sun',
      title: "Start today's daily note",
      subtitle: 'dated markdown + journal',
      actionType: 'prompt',
      prompt: 'Create a daily note for today in the workspace.\n\nInclude a heading with today\'s date, a short section to capture what I want to accomplish, an open journal section, and a link to yesterday\'s note if one exists.\n',
      priority: 90 + getClickBoost('time:daily-note', cardClicks),
    });
  }

  if (hourOfDay >= 17) {
    cards.push({
      id: 'time:daily-wrap',
      kind: 'action',
      icon: 'Moon',
      title: "Summarize what I did today",
      subtitle: "files touched since this morning",
      actionType: 'prompt',
      prompt: 'Summarize what I worked on today.\n\nLook at the files modified since midnight. For each, give me a 1-sentence summary of what changed. End with a short paragraph on the overall direction of my work today.\n',
      priority: 85 + getClickBoost('time:daily-wrap', cardClicks),
    });
  }

  return cards;
}

function staticFallbackCards(cardClicks: Record<string, { count: number }> | undefined): CardSpec[] {
  return [
    {
      id: 'static:ask',
      kind: 'static',
      icon: 'MessageCircleQuestion',
      title: 'Ask anything',
      subtitle: 'start a new conversation',
      actionType: 'prompt',
      prompt: '',
      priority: 20 + getClickBoost('static:ask', cardClicks),
    },
    {
      id: 'static:create-note',
      kind: 'static',
      icon: 'Plus',
      title: 'New note',
      subtitle: 'empty markdown file',
      actionType: 'create-note',
      priority: 15 + getClickBoost('static:create-note', cardClicks),
    },
  ];
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

export interface BuildCardsInput {
  workspace: WorkspaceTypeInfo | null;
  activity: ActivitySignals | null;
  hourOfDay: number;
  /** Workspace skills, keyed by id so skill-usage records can be turned into clickable cards. */
  availableSkills: CardSkillRef[];
}

export function buildSuggestionCards(input: BuildCardsInput): CardSpec[] {
  const { workspace, activity, hourOfDay, availableSkills } = input;
  const now = Date.now();
  const cardClicks = activity?.cardClicks;
  const cards: CardSpec[] = [];
  const seenPaths = new Set<string>();

  // 1. Resume card: most recently opened file, if it was touched recently.
  const recentFiles = activity?.recentFiles || [];
  const mostRecent = recentFiles[0];
  if (mostRecent && isWithinHours(mostRecent.lastOpened, 72)) {
    cards.push(resumeCard(mostRecent, now, cardClicks));
    seenPaths.add(mostRecent.path);
  }

  // 2. Frequent files (skip dupes of resume).
  const frequentFiles = activity?.frequentFiles || [];
  for (const file of frequentFiles) {
    if (seenPaths.has(file.path)) continue;
    if (file.count < 2) continue; // require at least 2 opens to qualify
    cards.push(frequentFileCard(file, cardClicks));
    seenPaths.add(file.path);
    if (cards.length >= 4) break;
  }

  // 3. Frequent skills (link to workspace skills).
  const skillsById = new Map<string, CardSkillRef>();
  for (const ref of availableSkills) {
    skillsById.set(ref.id, ref);
    skillsById.set(ref.name, ref);
  }
  for (const skill of activity?.frequentSkills || []) {
    if (skill.count < 2) continue;
    const card = skillCard(skill, skillsById, cardClicks);
    if (card) cards.push(card);
  }

  // 4. Time-of-day cards.
  if (workspace) {
    cards.push(...timeOfDayCards(hourOfDay, workspace.kind, cardClicks));
  }

  // 5. Workspace-type specific default cards.
  if (workspace) {
    if (workspace.kind === 'obsidian-vault' || workspace.kind === 'wiki') {
      cards.push(...wikiCards(workspace, cardClicks));
    } else if (workspace.kind === 'markdown-heavy') {
      cards.push(...markdownCards(workspace, cardClicks));
    } else {
      cards.push(...generalCards(cardClicks));
    }
  } else {
    cards.push(...generalCards(cardClicks));
  }

  // 6. Static fallbacks (always at the bottom — low priority).
  cards.push(...staticFallbackCards(cardClicks));

  // Dedupe by id and sort by priority desc.
  const byId = new Map<string, CardSpec>();
  for (const card of cards) {
    if (!byId.has(card.id)) byId.set(card.id, card);
  }
  return Array.from(byId.values()).sort((a, b) => b.priority - a.priority);
}

// Exposed for the grid component to know about today-midnight without importing Date.now twice.
export { todayMidnightMs, timeAgo };
