/**
 * Suggestion pill tree.
 *
 * Keep the root set small and knowledge-base oriented:
 *   - Create
 *   - Ingest
 *   - Ask Folder / Ask Wiki
 *   - Research
 *   - Maintain
 *   - More
 *
 * Children stay workspace-aware and can be re-ranked by click history.
 */

import type { WorkspaceTypeInfo, ActivitySignals } from '../../../api';
import type { LocaleKey } from '../../../i18n';
import {
  buildWikiBootstrapPrompt,
  buildWikiIngestPrompt,
  buildWikiLintPrompt,
  buildWikiQueryPrompt,
  isWikiWorkspace,
} from './wikiPrompts';

export interface PillSkillRef { id: string; name: string; label: string; path: string; title: string; }

export type PillActionType = 'prompt' | 'insert-skill' | 'create-note' | 'create-daily-note' | 'open-file';
export type SuggestionTreeTranslate = (key: LocaleKey, options?: Record<string, unknown>) => string;

export interface PillOption {
  id: string;
  title: string;
  icon?: string;
  question?: string;
  children?: PillOption[];
  prompt?: string;
  actionType?: PillActionType;
  skill?: PillSkillRef;
  filePath?: string;
  /** Optional secondary copy for richer surfaces. */
  subtitle?: string;
}

export interface BuildTreeInput {
  workspace: WorkspaceTypeInfo | null;
  activity: ActivitySignals | null;
  availableSkills: PillSkillRef[];
  hourOfDay: number;
  translate: SuggestionTreeTranslate;
}

function boost(id: string, cards: Record<string, { count: number }> | undefined): number {
  if (!cards) return 0;
  const entry = cards[id];
  if (!entry) return 0;
  return Math.min(entry.count * 2, 20);
}

function sortByBoost<T extends { id: string }>(items: T[], cards: Record<string, { count: number }> | undefined): T[] {
  return [...items].sort((a, b) => boost(b.id, cards) - boost(a.id, cards));
}

function sortByBoostWithPinnedOrder<T extends { id: string }>(
  items: T[],
  cards: Record<string, { count: number }> | undefined,
  pinnedStartIds: string[],
  pinnedEndIds: string[],
): T[] {
  const pinnedStartIdSet = new Set(pinnedStartIds);
  const pinnedEndIdSet = new Set(pinnedEndIds);
  const sortedItems = sortByBoost(items, cards);
  const leading = pinnedStartIds
    .map((id) => sortedItems.find((item) => item.id === id))
    .filter((item): item is T => item !== undefined);
  const middle = sortedItems.filter((item) => !pinnedStartIdSet.has(item.id) && !pinnedEndIdSet.has(item.id));
  const trailing = pinnedEndIds
    .map((id) => sortedItems.find((item) => item.id === id))
    .filter((item): item is T => item !== undefined);
  return [...leading, ...middle, ...trailing];
}

function buildDocumentPrompt(format: 'DOCX' | 'PDF' | 'Markdown'): string {
  return `Create a ${format} document for me.

Ask me:
- What is the topic and purpose?
- Who is the audience?
- Rough length?
- Any files in this workspace to draw from?

If I do not elaborate, read the workspace and infer a useful addition to the workspace in ${format} format.

Then draft it cleanly.

`;
}

function buildResearch(input: BuildTreeInput): PillOption {
  return {
    id: 'research',
    title: input.translate('newTab.tree.research.title'),
    icon: 'Compass',
    subtitle: input.translate('newTab.tree.research.subtitle'),
    actionType: 'prompt',
    prompt: `Look through the files in this folder and infer what I am working on.

Then find outside research that is actually relevant to this work: papers, articles, documentation, reports, or other strong sources.

Bring the useful research back into this workspace in concrete form:
- markdown notes with citations and links
- downloaded PDFs for sources worth keeping locally

Start by briefly stating what you think this folder is about, then do the research and bring back the most useful material.
`,
  };
}

function buildOrganizeFilesPrompt(): string {
  return `Look at the files in my workspace and propose a cleaner folder structure.

Show me the proposed moves as a tree, and wait for my approval before moving anything.
`;
}

function buildAskWorkspace(input: BuildTreeInput): PillOption {
  const isWiki = isWikiWorkspace(input.workspace);

  return {
    id: 'ask-folder',
    title: input.translate('newTab.tree.askFolder.title'),
    icon: 'MessageCircleQuestion',
    subtitle: isWiki
      ? input.translate('newTab.tree.askWiki.subtitle')
      : input.translate('newTab.tree.askFolder.subtitle'),
    actionType: 'prompt',
    prompt: isWiki
      ? buildWikiQueryPrompt()
      : `Answer my question according to the contents of this folder.

Read the relevant files carefully and cite the files you rely on.

If the answer is non-trivial, offer to file it back into the folder as a synthesis note.

Question:
`,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function buildCreate(input: BuildTreeInput): PillOption {
  const children: PillOption[] = [
    {
      id: 'create:note',
      title: input.translate('newTab.tree.create.note.title'),
      icon: 'FileText',
      subtitle: input.translate('newTab.tree.create.note.subtitle'),
      actionType: 'create-note',
    },
    {
      id: 'create:daily-note',
      title: input.translate('newTab.tree.create.dailyNote.title'),
      icon: 'Sun',
      subtitle: input.translate('newTab.tree.create.dailyNote.subtitle'),
      actionType: 'create-daily-note',
    },
  ];

  children.push(
    {
      id: 'create:document',
      title: input.translate('newTab.tree.create.document.title'),
      icon: 'PenTool',
      subtitle: input.translate('newTab.tree.create.document.subtitle'),
      question: input.translate('newTab.tree.create.document.question'),
      children: [
        {
          id: 'create:document:docx',
          title: input.translate('newTab.tree.create.document.docx'),
          icon: 'FileText',
          actionType: 'prompt',
          prompt: buildDocumentPrompt('DOCX'),
        },
        {
          id: 'create:document:pdf',
          title: input.translate('newTab.tree.create.document.pdf'),
          icon: 'FileText',
          actionType: 'prompt',
          prompt: buildDocumentPrompt('PDF'),
        },
        {
          id: 'create:document:markdown',
          title: input.translate('newTab.tree.create.document.markdown'),
          icon: 'FileText',
          actionType: 'prompt',
          prompt: buildDocumentPrompt('Markdown'),
        },
      ],
    },
    {
      id: 'create:new-interface',
      title: input.translate('newTab.tree.create.newInterface.title'),
      icon: 'Code2',
      subtitle: input.translate('newTab.tree.create.newInterface.subtitle'),
      actionType: 'prompt',
      prompt: `Build a new Node app in this workspace that helps me understand these files visually.

The interface should include:
- a graph view of all the files
- pan and zoom
- visible connections between related files
- a way to understand the layout of the workspace
- high-level stats about the workspace

When you finish building it:
- start the server yourself
- use the Interpreter CLI layout functions to open a new browser tab to the localhost URL
- those layout functions can open localhost URLs, so actually open the tab instead of only printing the URL

Pick a lightweight, practical stack and make the interface usable right away.
`,
    },
  );

  return {
    id: 'cat:create',
    title: input.translate('newTab.tree.create.title'),
    icon: 'Plus',
    question: input.translate('newTab.tree.create.question'),
    children: sortByBoostWithPinnedOrder(
      children,
      input.activity?.cardClicks,
      ['create:note', 'create:daily-note'],
      ['create:new-interface'],
    ),
  };
}

// ---------------------------------------------------------------------------
// LLM Wiki
// ---------------------------------------------------------------------------

function buildLlmWiki(input: BuildTreeInput): PillOption {
  const { workspace } = input;
  const isMarkdownHeavy = workspace?.kind === 'markdown-heavy';
  const bootstrapPrompt = buildWikiBootstrapPrompt(isMarkdownHeavy ? 'notes' : 'workspace');
  const children: PillOption[] = [
    {
      id: 'wiki:bootstrap',
      title: 'Setup',
      icon: 'Asterisk',
      subtitle: isMarkdownHeavy ? 'Turn notes into a wiki' : 'Bootstrap a wiki',
      actionType: 'prompt',
      prompt: bootstrapPrompt,
    },
    {
      id: 'wiki:ingest',
      title: 'Ingest',
      icon: 'ArrowDown',
      subtitle: 'One source at a time',
      actionType: 'prompt',
      prompt: buildWikiIngestPrompt(),
    },
    {
      id: 'wiki:query',
      title: 'Query',
      icon: 'MessageCircleQuestion',
      subtitle: 'Answer with ([[Page]]) citations',
      actionType: 'prompt',
      prompt: buildWikiQueryPrompt(),
    },
    {
      id: 'wiki:maintain',
      title: input.translate('newTab.tree.maintain.title'),
      icon: 'ShieldCheck',
      subtitle: 'Lint, gaps, stale claims',
      actionType: 'prompt',
      prompt: buildWikiLintPrompt(),
    },
  ];

  return {
    id: 'cat:llm-wiki',
    title: 'Wiki',
    icon: 'Globe',
    question: 'What should we do with your wiki?',
    children: sortByBoost(children, input.activity?.cardClicks),
  };
}

// ---------------------------------------------------------------------------
// Analyze
// ---------------------------------------------------------------------------

function buildAnalyze(input: BuildTreeInput): PillOption {
  const { workspace } = input;
  const hasNotes = (workspace?.markdownFileCount ?? 0) > 0;

  const children: PillOption[] = [
    {
      id: 'analyze:summarize-notes',
      title: hasNotes
        ? input.translate('newTab.tree.analyze.summarizeNotes')
        : input.translate('newTab.tree.analyze.summarizeWorkspace'),
      icon: 'FileSearch',
      subtitle: input.translate('newTab.tree.analyze.summarize.subtitle'),
      actionType: 'prompt',
      prompt: `Read the files in my workspace and give me a concise summary of what is here.

Group related notes or files by theme. Cite the specific files you rely on. End with the 3 most important threads I seem to be working on.
`,
    },
    {
      id: 'analyze:analyze-notes',
      title: hasNotes
        ? input.translate('newTab.tree.analyze.analyzeNotes')
        : input.translate('newTab.tree.analyze.analyzeWorkspace'),
      icon: 'Workflow',
      subtitle: input.translate('newTab.tree.analyze.analyze.subtitle'),
      actionType: 'prompt',
      prompt: `Read across my files and find the strongest patterns, recurring themes, surprising connections, and contradictions.

For each point, cite the relevant files. Point out anything non-obvious. End with the 3 most important threads I should pay attention to.
`,
    },
    {
      id: 'analyze:find-something',
      title: input.translate('newTab.tree.analyze.findSomething.title'),
      icon: 'Search',
      subtitle: input.translate('newTab.tree.analyze.findSomething.subtitle'),
      actionType: 'prompt',
      prompt: `Search my workspace for the following. Tell me which files are most relevant and summarize what each one says about it.

What I'm looking for:
`,
    },
  ];

  return {
    id: 'cat:analyze',
    title: input.translate('newTab.tree.analyze.title'),
    icon: 'LineChart',
    question: input.translate('newTab.tree.analyze.question'),
    children: sortByBoost(children, input.activity?.cardClicks),
  };
}

function buildTeachSkill(input: BuildTreeInput): PillOption {
  return {
    id: 'skills:teach',
    title: input.translate('newTab.tree.teachSkill.title'),
    icon: 'Plus',
    subtitle: input.translate('newTab.tree.teachSkill.subtitle'),
    actionType: 'prompt',
    prompt: `I want to teach you a new skill for this folder.

Ask me to walk you through it step by step. Confirm each step and its expected outcome. Once we agree on the workflow, create the skill.
`,
  };
}

function buildOrganize(): PillOption {
  return {
    id: 'organize',
    title: 'Organize',
    icon: 'Folder',
    subtitle: 'Propose a cleaner folder structure',
    actionType: 'prompt',
    prompt: buildOrganizeFilesPrompt(),
  };
}

function buildFillForm(input: BuildTreeInput): PillOption {
  return {
    id: 'fill-form',
    title: input.translate('newTab.tree.fillForms.title'),
    icon: 'ClipboardCheck',
    subtitle: input.translate('newTab.tree.fillForms.subtitle'),
    actionType: 'prompt',
    prompt: `Please fill the PDF form in this folder: [filename]

I will paste:
- all the information that should go into it
- any extra instructions

Details:
`,
  };
}

// ---------------------------------------------------------------------------
// More
// ---------------------------------------------------------------------------

function buildMore(input: BuildTreeInput): PillOption {
  const hasPdf = (input.workspace?.pdfFileCount ?? 0) > 0;

  const children: PillOption[] = [
    buildAnalyze(input),
    ...(hasPdf ? [buildFillForm(input)] : []),
    {
      ...buildTeachSkill(input),
      id: 'more:teach-skill',
    },
    ...input.availableSkills.map((skill): PillOption => ({
      id: `skill:${skill.id}`,
      title: skill.label,
      icon: 'BookOpen',
      subtitle: input.translate('newTab.tree.more.skill.subtitle'),
      actionType: 'insert-skill',
      skill,
    })),
  ];

  return {
    id: 'cat:more',
    title: input.translate('newTab.tree.more.title'),
    icon: 'ArrowRight',
    question: input.translate('newTab.tree.more.question'),
    children: sortByBoost(children, input.activity?.cardClicks),
  };
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export function buildSuggestionTree(input: BuildTreeInput): PillOption[] {
  return [
    buildCreate(input),
    buildLlmWiki(input),
    buildAskWorkspace(input),
    buildResearch(input),
    buildOrganize(),
    buildMore(input),
  ];
}

export function findOptionByPath(tree: PillOption[], path: string[]): { currentOptions: PillOption[]; currentQuestion: string | null; currentTitle: string | null } {
  if (path.length === 0) return { currentOptions: tree, currentQuestion: null, currentTitle: null };

  let options = tree;
  let question: string | null = null;
  let title: string | null = null;
  for (const id of path) {
    const match = options.find((option) => option.id === id);
    if (!match || !match.children) break;
    options = match.children;
    question = match.question ?? null;
    title = match.title;
  }
  return { currentOptions: options, currentQuestion: question, currentTitle: title };
}
