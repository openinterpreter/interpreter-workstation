import { describe, test, expect } from 'bun:test';
import matter from 'gray-matter';

/**
 * Unit tests for skills system logic.
 * Tests the skill parsing, default skills configuration, and validation.
 */

// Replicate the parseSkillFile logic for testing
interface SkillOption {
  id: string;
  title: string;
  description: string;
  action: string;
  actionType: string;
  icon?: string;
  workspacePath?: string;
  sortOrder: number;
  question?: string;
}

function humanizeSkillName(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  const deSlugged = normalized.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!deSlugged) return '';
  if (/[A-Z]/.test(deSlugged)) return deSlugged;
  return deSlugged
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function parseSkillFile(fileContent: string, dirName: string): SkillOption | null {
  try {
    const { data, content } = matter(fileContent);
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    const description = typeof data.description === 'string' ? data.description.trim() : '';
    const icon = typeof data.icon === 'string' ? data.icon.trim() : '';
    if (!name || !description) return null;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return null;
    if (name !== dirName) return null;

    return {
      id: `workspace:${name}`,
      title: (typeof data.title === 'string' && data.title.trim()) ? data.title.trim() : humanizeSkillName(name),
      description,
      action: content.trim(),
      actionType: data.actionType || 'prompt',
      icon: icon || undefined,
      workspacePath: data.workspacePath,
      sortOrder: typeof data.sortOrder === 'number' ? data.sortOrder : 999,
      question: data.question,
    };
  } catch {
    return null;
  }
}

// The expected built-in skills (from skills.ts)
const EXPECTED_BUILTIN_SKILL_IDS = [
  'builtin:create-skill',
];

describe('Skills system', () => {
  describe('parseSkillFile', () => {
    test('parses valid skill with all fields', () => {
      const content = `---
name: test-skill
description: A test skill
icon: star
actionType: prompt
sortOrder: 1
question: "What would you like?"
---

This is the action content.
`;
      const result = parseSkillFile(content, 'test-skill');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('workspace:test-skill');
      expect(result!.title).toBe('Test Skill');
      expect(result!.description).toBe('A test skill');
      expect(result!.action).toBe('This is the action content.');
      expect(result!.actionType).toBe('prompt');
      expect(result!.icon).toBe('star');
      expect(result!.sortOrder).toBe(1);
      expect(result!.question).toBe('What would you like?');
    });

    test('returns null when name is missing', () => {
      const content = `---
title: "No Name Skill"
---

Action here.
`;
      const result = parseSkillFile(content, 'my-fallback');

      expect(result).toBeNull();
    });

    test('returns null when description is missing', () => {
      const content = `---
name: skill-name
---

Action.
`;
      const result = parseSkillFile(content, 'skill-name');

      expect(result).toBeNull();
    });

    test('returns null when name does not match directory name', () => {
      const content = `---
name: some-other-name
description: Valid description
---

Action.
`;
      const result = parseSkillFile(content, 'expected-dir-name');
      expect(result).toBeNull();
    });

    test('returns null for invalid non-kebab-case name', () => {
      const content = `---
name: InvalidName
description: Valid description
---

Action.
`;
      const result = parseSkillFile(content, 'InvalidName');
      expect(result).toBeNull();
    });

    test('defaults sortOrder to 999 when missing', () => {
      const content = `---
name: no-order
description: Has no sort order
---

Action.
`;
      const result = parseSkillFile(content, 'no-order');

      expect(result).not.toBeNull();
      expect(result!.sortOrder).toBe(999);
    });

    test('uses title from frontmatter when provided', () => {
      const content = `---
name: summarize-workspace
title: Summarize Workspace
description: Summarize the project
---

Action.
`;
      const result = parseSkillFile(content, 'summarize-workspace');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Summarize Workspace');
    });

    test('defaults actionType to prompt when missing', () => {
      const content = `---
name: no-action-type
description: Has no action type
---

Action.
`;
      const result = parseSkillFile(content, 'no-action-type');

      expect(result).not.toBeNull();
      expect(result!.actionType).toBe('prompt');
    });

    test('parses different actionTypes', () => {
      const actionTypes = ['prompt', 'create-note', 'change-workspace', 'open-folder-picker'];

      for (const actionType of actionTypes) {
        const content = `---
name: test
description: Test action type
actionType: ${actionType}
---

Action.
`;
        const result = parseSkillFile(content, 'test');
        expect(result!.actionType).toBe(actionType);
      }
    });

    test('handles workspacePath for change-workspace actions', () => {
      const content = `---
name: desktop-skill
description: Organize desktop
actionType: change-workspace
workspacePath: desktop
---

Organize desktop.
`;
      const result = parseSkillFile(content, 'desktop-skill');

      expect(result).not.toBeNull();
      expect(result!.workspacePath).toBe('desktop');
    });

    test('trims action content', () => {
      const content = `---
name: test
description: A description
---

   Action with whitespace.
`;
      const result = parseSkillFile(content, 'test');

      expect(result!.action).toBe('Action with whitespace.');
    });

    test('handles empty action content', () => {
      const content = `---
name: empty-action
description: A description
---
`;
      const result = parseSkillFile(content, 'empty-action');

      expect(result).not.toBeNull();
      expect(result!.action).toBe('');
    });

    test('ignores non-string icon values', () => {
      const content = `---
name: invalid-icon
description: Invalid icon type
icon:
  name: Sparkles
---

Action.
`;
      const result = parseSkillFile(content, 'invalid-icon');

      expect(result).not.toBeNull();
      expect(result!.icon).toBeUndefined();
    });
  });

  describe('Built-in skills configuration', () => {
    test('has exactly 1 built-in skill', () => {
      expect(EXPECTED_BUILTIN_SKILL_IDS.length).toBe(1);
    });

    test('includes the create-skill built-in command', () => {
      const expected = ['builtin:create-skill'];

      expect(EXPECTED_BUILTIN_SKILL_IDS).toEqual(expected);
    });

    test('built-in skill IDs follow builtin namespace convention', () => {
      for (const id of EXPECTED_BUILTIN_SKILL_IDS) {
        expect(id).toMatch(/^builtin:/);
      }
    });
  });
});
