import { describe, expect, test } from 'bun:test';
import { extractSkillMentionsFromText } from '../../../shared/utils/skillMentions';
import {
  buildRememberSkillSuggestion,
  shouldEnableSuggestionChipInteractions,
} from './SuggestionChips';

describe('buildRememberSkillSuggestion', () => {
  test('builds a serialized skill mention for the skill creator', () => {
    const suggestion = buildRememberSkillSuggestion({
      id: 'global:skill-creator:/skills/skill-creator/SKILL.md',
      name: 'skill-creator',
      title: 'Skill Creator',
      filePath: '/skills/skill-creator/SKILL.md',
    });

    expect(suggestion).not.toBeNull();
    expect(suggestion?.prompt.startsWith('skill:[')).toBe(true);

    const extracted = extractSkillMentionsFromText(suggestion?.prompt ?? '');
    expect(extracted.skills).toEqual([
      {
        id: 'global:skill-creator:/skills/skill-creator/SKILL.md',
        label: 'Skill Creator',
        name: 'skill-creator',
        path: '/skills/skill-creator/SKILL.md',
      },
    ]);
  });

  test('returns null when the bundled skill is unavailable', () => {
    expect(buildRememberSkillSuggestion(null)).toBeNull();
  });
});

describe('shouldEnableSuggestionChipInteractions', () => {
  test('disables invisible suggestion chips while a turn is streaming', () => {
    expect(shouldEnableSuggestionChipInteractions({
      hasQueuedMessages: false,
      isStreaming: true,
      isVisible: true,
      externalOpacity: 1,
    })).toBe(false);
  });

  test('disables suggestion chips when queued messages hide the rail', () => {
    expect(shouldEnableSuggestionChipInteractions({
      hasQueuedMessages: true,
      isStreaming: false,
      isVisible: true,
      externalOpacity: 1,
    })).toBe(false);
  });

  test('enables suggestion chips only when the visible rail is interactive', () => {
    expect(shouldEnableSuggestionChipInteractions({
      hasQueuedMessages: false,
      isStreaming: false,
      isVisible: true,
      externalOpacity: 1,
    })).toBe(true);

    expect(shouldEnableSuggestionChipInteractions({
      hasQueuedMessages: false,
      isStreaming: false,
      isVisible: true,
      externalOpacity: 0.1,
    })).toBe(false);
  });
});
