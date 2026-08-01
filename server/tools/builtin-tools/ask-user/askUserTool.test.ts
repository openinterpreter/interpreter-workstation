import { describe, expect, test } from 'bun:test';

import { askUserServerDefinition } from './index';
import { askUserQuestionTool } from './askUserTool';

describe('askUserQuestionTool guidance', () => {
  test('describes structured multiple-choice usage and polling guidance', () => {
    expect(askUserQuestionTool.description).toContain('structured output');
    expect(askUserQuestionTool.description).toContain('multiple-choice');
    expect(askUserQuestionTool.description).toContain('yield_time_ms');
    expect(askUserServerDefinition.description).toContain('structured multiple-choice');

    const questionsSchema = askUserQuestionTool.inputSchema.properties.questions as { description?: string };
    expect(questionsSchema.description).toContain('multiple-choice');
  });
});
