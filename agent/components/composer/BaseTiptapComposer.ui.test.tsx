import { describe, expect, test } from 'vitest';
import { parseContentWithMentions } from './BaseTiptapComposer';
import { serializeSkillMentionToken } from '../../../shared/utils/skillMentions';

function collectText(node: any): string[] {
  if (!node) return [];
  if (node.type === 'text' && typeof node.text === 'string') {
    return [node.text];
  }
  if (!Array.isArray(node.content)) {
    return [];
  }
  return node.content.flatMap((child: any) => collectText(child));
}

describe('parseContentWithMentions', () => {
  test('parses a serialized skill token into a skill chip without leaking the skill prefix', () => {
    const token = serializeSkillMentionToken({
      id: 'imagegen',
      label: 'Imagegen',
      name: 'imagegen',
      path: '/tmp/Skill (System)/SKILL.md',
    });

    const doc = parseContentWithMentions(`${token}\n\nFollow this skill.`);

    expect(doc).toMatchObject({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'skillMention',
              attrs: expect.objectContaining({
                id: 'imagegen',
                label: 'Imagegen',
                name: 'imagegen',
                path: '/tmp/Skill (System)/SKILL.md',
              }),
            },
          ],
        },
        { type: 'paragraph' },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Follow this skill.' }],
        },
      ],
    });

    expect(collectText(doc)).not.toContain('skill:');
    expect(JSON.stringify(doc)).not.toContain('skill:[');
  });
});
