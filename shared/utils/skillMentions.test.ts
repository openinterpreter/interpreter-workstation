import { describe, expect, test } from 'bun:test';

import {
  extractSkillMentionsFromText,
  injectSkillMentionsIntoText,
  serializeSkillMentionToken,
} from './skillMentions';

describe('skill mention round-tripping', () => {
  test('does not attach a mention to an earlier literal $skill-name in user text', () => {
    const serializedMention = serializeSkillMentionToken({
      id: 'deploy-docs:/skills/deploy-docs/SKILL.md',
      label: 'Deploy Docs',
      name: 'deploy-docs',
      path: '/skills/deploy-docs/SKILL.md',
    });

    const extracted = extractSkillMentionsFromText(
      `Literal shell text $deploy-docs before ${serializedMention}`,
    );
    const restored = injectSkillMentionsIntoText(extracted.text, extracted.skills);

    expect(restored).toBe(`Literal shell text $deploy-docs before ${serializedMention}`);
  });

  test('restores every repeated mention for the same skill', () => {
    const serializedMention = serializeSkillMentionToken({
      id: 'project:skill-creator:/skills/skill-creator/SKILL.md',
      label: 'Skill Creator',
      name: 'skill-creator',
      path: '/skills/skill-creator/SKILL.md',
    });

    const original = `Run ${serializedMention} and then ${serializedMention} again.`;
    const extracted = extractSkillMentionsFromText(original);
    const restored = injectSkillMentionsIntoText(extracted.text, extracted.skills);

    expect(restored).toBe(original);
  });
});
