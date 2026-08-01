import { describe, expect, test } from 'bun:test';

import en from '../../../../shared/locales/en.json';
import { buildSuggestionTree, type BuildTreeInput } from './suggestionTree';

function translate(key: string, options?: Record<string, unknown>): string {
  const template = en[key as keyof typeof en];
  if (typeof template !== 'string') {
    return options?.defaultValue as string ?? key;
  }

  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = options?.[name];
    return value == null ? '' : String(value);
  });
}

function buildTree(input: Omit<BuildTreeInput, 'translate'>) {
  return buildSuggestionTree({
    ...input,
    translate,
  });
}

describe('buildSuggestionTree', () => {
  test('adds Ask Folder and Organize to the root taxonomy for non-wiki folders', () => {
    const tree = buildTree({
      workspace: {
        kind: 'general',
        hasObsidianFolder: false,
        hasWikiStructure: false,
        hasIndexMd: false,
        hasLogMd: false,
        markdownFileCount: 3,
        pdfFileCount: 0,
        nonMarkdownFileCount: 12,
        sampled: false,
      },
      activity: null,
      availableSkills: [],
      hourOfDay: 9,
    });

    expect(tree.map((option) => option.title)).toEqual([
      'Create',
      'Wiki',
      'Ask Folder',
      'Research',
      'Organize',
      'More',
    ]);

    const wiki = tree.find((option) => option.title === 'Wiki');
    expect(wiki?.children?.map((option) => option.title)).toEqual([
      'Setup',
      'Ingest',
      'Query',
      'Maintain',
    ]);
    const bootstrap = wiki?.children?.find((option) => option.id === 'wiki:bootstrap');
    expect(bootstrap?.prompt).toContain('Read $wiki-bootstrap.');
    expect(bootstrap?.prompt).toContain('bootstrap a durable wiki workflow');
    expect(bootstrap?.prompt).not.toContain('Move the existing material into raw/');

    const askFolder = tree.find((option) => option.id === 'ask-folder');
    expect(askFolder?.actionType).toBe('prompt');
    expect(askFolder?.prompt).toContain('Answer my question according to the contents of this folder.');

    const research = tree.find((option) => option.id === 'research');
    expect(research?.actionType).toBe('prompt');
    expect(research?.prompt).toContain('infer what I am working on');

    const organize = tree.find((option) => option.id === 'organize');
    expect(organize?.actionType).toBe('prompt');
    expect(organize?.prompt).toContain('propose a cleaner folder structure');

    const more = tree.find((option) => option.id === 'cat:more');
    expect(more?.children?.map((option) => option.title)).toEqual([
      'Analyze',
      'Teach Skill',
    ]);

    const analyze = more?.children?.find((option) => option.id === 'cat:analyze');
    expect(analyze?.children?.map((option) => option.title)).toEqual([
      'Summarize my notes',
      'Analyze my notes',
      'Find something',
    ]);
  });

  test('keeps forms and shipped skills under More instead of at the root', () => {
    const tree = buildTree({
      workspace: {
        kind: 'general',
        hasObsidianFolder: false,
        hasWikiStructure: false,
        hasIndexMd: false,
        hasLogMd: false,
        markdownFileCount: 3,
        pdfFileCount: 2,
        nonMarkdownFileCount: 12,
        sampled: false,
      },
      activity: null,
      availableSkills: [{
        id: 'project:skill-creator:/tmp/skills/skill-creator/SKILL.md',
        name: 'skill-creator',
        label: 'Skill Creator',
        path: '/tmp/skills/skill-creator/SKILL.md',
        title: 'Skill Creator',
      }],
      hourOfDay: 9,
    });

    expect(tree.map((option) => option.title)).toEqual([
      'Create',
      'Wiki',
      'Ask Folder',
      'Research',
      'Organize',
      'More',
    ]);

    expect(tree.some((option) => option.title === 'Skills')).toBe(false);
    expect(tree.some((option) => option.title === 'Fill Forms')).toBe(false);
    expect(tree.some((option) => option.title === 'Bootstrap Wiki')).toBe(false);

    const more = tree.find((option) => option.id === 'cat:more');
    expect(more?.children?.map((option) => option.title)).toEqual([
      'Analyze',
      'Fill Forms',
      'Teach Skill',
      'Skill Creator',
    ]);

    const fillForm = more?.children?.find((option) => option.id === 'fill-form');
    expect(fillForm?.actionType).toBe('prompt');
    expect(fillForm?.prompt).toContain('Please fill the PDF form in this folder: [filename]');
    expect(fillForm?.prompt).not.toContain('one field at a time');

    const skill = more?.children?.find((option) => option.id === 'skill:project:skill-creator:/tmp/skills/skill-creator/SKILL.md');
    expect(skill?.actionType).toBe('insert-skill');
    expect(skill?.icon).toBe('BookOpen');
  });

  test('keeps create focused, pins daily note near the front, and still pins the interface action last', () => {
    const tree = buildTree({
      workspace: {
        kind: 'general',
        hasObsidianFolder: false,
        hasWikiStructure: false,
        hasIndexMd: false,
        hasLogMd: false,
        markdownFileCount: 3,
        pdfFileCount: 1,
        nonMarkdownFileCount: 12,
        sampled: false,
      },
      activity: {
        recentFiles: [],
        frequentFiles: [],
        frequentSkills: [],
        cardClicks: {
          'create:new-interface': { cardId: 'create:new-interface', count: 100, lastClicked: Date.now() },
          'create:document': { cardId: 'create:document', count: 1, lastClicked: Date.now() },
        },
        frequentActions: [],
        actionCounts: {},
      },
      availableSkills: [],
      hourOfDay: 9,
    });

    const createCategory = tree.find((option) => option.id === 'cat:create');
    const createIds = createCategory?.children?.map((option) => option.id) ?? [];
    expect(createIds).toEqual([
      'create:note',
      'create:daily-note',
      'create:document',
      'create:new-interface',
    ]);

    const documentCategory = createCategory?.children?.find((option) => option.id === 'create:document');
    expect(documentCategory?.children?.map((option) => option.title)).toEqual([
      'DOCX',
      'PDF',
      'Markdown',
    ]);
    expect(documentCategory?.children?.[0]?.prompt).toContain('If I do not elaborate, read the workspace and infer a useful addition to the workspace in DOCX format.');

    const newInterface = createCategory?.children?.find((option) => option.id === 'create:new-interface');
    expect(newInterface?.title).toBe('New Interface');
    expect(newInterface?.prompt).toContain('graph view of all the files');
    expect(newInterface?.prompt).toContain('start the server yourself');
    expect(newInterface?.prompt).toContain('open a new browser tab to the localhost URL');
  });

  test('markdown-heavy workspaces keep Ask Folder at the root and expose Bootstrap Wiki in More', () => {
    const tree = buildTree({
      workspace: {
        kind: 'markdown-heavy',
        hasObsidianFolder: false,
        hasWikiStructure: false,
        hasIndexMd: false,
        hasLogMd: false,
        markdownFileCount: 42,
        pdfFileCount: 0,
        nonMarkdownFileCount: 10,
        sampled: false,
      },
      activity: null,
      availableSkills: [],
      hourOfDay: 9,
    });

    expect(tree.map((option) => option.title)).toEqual([
      'Create',
      'Wiki',
      'Ask Folder',
      'Research',
      'Organize',
      'More',
    ]);

    const wiki = tree.find((option) => option.title === 'Wiki');
    expect(wiki?.children?.map((option) => option.title)).toEqual([
      'Setup',
      'Ingest',
      'Query',
      'Maintain',
    ]);
    const bootstrap = wiki?.children?.find((option) => option.id === 'wiki:bootstrap');
    expect(bootstrap?.prompt).toContain('Read $wiki-bootstrap.');
    expect(bootstrap?.prompt).toContain('existing notes');
    expect(bootstrap?.prompt).not.toContain('Move the existing notes into raw/');

    const askFolder = tree.find((option) => option.id === 'ask-folder');
    expect(askFolder?.prompt).toContain('Answer my question according to the contents of this folder.');

    const more = tree.find((option) => option.id === 'cat:more');
    expect(more?.children?.some((option) => option.id === 'more:bootstrap-wiki')).toBe(false);
    const analyze = more?.children?.find((option) => option.id === 'cat:analyze');
    expect(analyze?.children?.map((option) => option.title)).toContain('Summarize my notes');
    expect(analyze?.children?.map((option) => option.title)).toContain('Analyze my notes');
    expect(more?.children?.some((option) => option.id === 'fill-form')).toBe(false);

    const organize = tree.find((option) => option.id === 'organize');
    expect(organize?.prompt).toContain('propose a cleaner folder structure');
  });

  test('wiki workspaces keep the same root pills while grouping wiki actions under Wiki', () => {
    const tree = buildTree({
      workspace: {
        kind: 'wiki',
        hasObsidianFolder: false,
        hasWikiStructure: true,
        hasIndexMd: true,
        hasLogMd: true,
        markdownFileCount: 90,
        pdfFileCount: 4,
        nonMarkdownFileCount: 8,
        sampled: false,
      },
      activity: null,
      availableSkills: [],
      hourOfDay: 9,
    });

    expect(tree.map((option) => option.title)).toEqual([
      'Create',
      'Wiki',
      'Ask Folder',
      'Research',
      'Organize',
      'More',
    ]);

    const wiki = tree.find((option) => option.id === 'cat:llm-wiki');
    expect(wiki?.children?.map((option) => option.title)).toEqual([
      'Setup',
      'Ingest',
      'Query',
      'Maintain',
    ]);
    const ingest = wiki?.children?.find((option) => option.id === 'wiki:ingest');
    expect(ingest?.prompt).toContain('Read $wiki-ingest.');
    expect(ingest?.prompt).toContain('use $wiki-bootstrap first');
    const query = wiki?.children?.find((option) => option.id === 'wiki:query');
    expect(query?.prompt).toContain('Read $wiki-query.');
    expect(query?.prompt).toContain('Read `index.md` only if it exists');
    const maintain = wiki?.children?.find((option) => option.id === 'wiki:maintain');
    expect(maintain?.prompt).toContain('Read $wiki-lint.');

    const askFolder = tree.find((option) => option.id === 'ask-folder');
    expect(askFolder?.title).toBe('Ask Folder');
    expect(askFolder?.prompt).toContain('Read $wiki-query.');

    const organize = tree.find((option) => option.id === 'organize');
    expect(organize?.prompt).toContain('propose a cleaner folder structure');

    const more = tree.find((option) => option.id === 'cat:more');
    expect(more?.children?.map((option) => option.title)).toEqual([
      'Analyze',
      'Fill Forms',
      'Teach Skill',
    ]);
    expect(more?.children?.some((option) => option.id === 'more:bootstrap-wiki')).toBe(false);

    const analyze = more?.children?.find((option) => option.id === 'cat:analyze');
    expect(analyze?.children?.some((option) => option.id === 'analyze:ask-wiki')).toBe(false);
    expect(analyze?.children?.some((option) => option.id === 'analyze:check-contradictions')).toBe(false);
  });

  test('obsidian vaults keep the same root pills and include setup inside Wiki', () => {
    const tree = buildTree({
      workspace: {
        kind: 'obsidian-vault',
        hasObsidianFolder: true,
        hasWikiStructure: false,
        hasIndexMd: false,
        hasLogMd: false,
        markdownFileCount: 40,
        pdfFileCount: 0,
        nonMarkdownFileCount: 8,
        sampled: false,
      },
      activity: null,
      availableSkills: [],
      hourOfDay: 9,
    });

    expect(tree.map((option) => option.title)).toEqual([
      'Create',
      'Wiki',
      'Ask Folder',
      'Research',
      'Organize',
      'More',
    ]);

    const wiki = tree.find((option) => option.id === 'cat:llm-wiki');
    expect(wiki?.children?.map((option) => option.title)).toEqual([
      'Setup',
      'Ingest',
      'Query',
      'Maintain',
    ]);
    const bootstrap = wiki?.children?.find((option) => option.id === 'wiki:bootstrap');
    expect(bootstrap?.prompt).toContain('Read $wiki-bootstrap.');

    const askFolder = tree.find((option) => option.id === 'ask-folder');
    expect(askFolder?.title).toBe('Ask Folder');
    expect(askFolder?.prompt).toContain('Read $wiki-query.');

    const organize = tree.find((option) => option.id === 'organize');
    expect(organize?.prompt).toContain('propose a cleaner folder structure');

    const more = tree.find((option) => option.id === 'cat:more');
    expect(more?.children?.some((option) => option.id === 'more:bootstrap-wiki')).toBe(false);
  });
});
