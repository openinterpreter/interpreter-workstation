/**
 * Ask User Question Tool
 *
 * Allows the model to ask clarifying questions with rich UI options.
 * Questions appear in both the chat and the Approvals panel.
 */

import type { BuiltinToolDefinition, BuiltinToolContext } from '../../builtinTools';
import { approvalManager } from '../../../approvalManager';
import type { Question, QuestionOption } from '../../../../shared/types/approval';

interface OptionInput {
  label: string;
  value?: string;
  description?: string;
  recommended?: boolean;
}

interface QuestionInput {
  question: string;
  header?: string;
  options: Array<OptionInput | string>; // Allow string shortcuts
  multiSelect?: boolean;
  allowOther?: boolean;
  default?: string | string[];
  optional?: boolean;
}

export const askUserQuestionTool: BuiltinToolDefinition = {
  name: 'ask_user_question',
  description: `Ask the user clarifying questions when you need input to proceed.
Use this to gather structured input, clarify requirements, or get decisions on implementation choices.

Features:
- Mark options as "recommended" to show the user your suggestion
- Specify "default" to pre-select an answer (used if user clicks Skip)
- Set "optional: true" for minor questions - shows a countdown timer (default: 15 seconds) that auto-selects defaults
- Users can click "Skip" to accept your defaults (means "you figure it out!")

Best practices:
- If you need structured output from the user, or need to ask multiple related questions, prefer this tool over free-form chat
- Prefer concise multiple-choice questions with clear options over open-ended prompts
- Only interrupt the user with this tool when their answer is truly necessary to proceed well
- For complex or important questions, do NOT mark as optional - let the user take their time
- Only use "optional: true" for low-stakes choices where your default is clearly reasonable
- When asking multiple questions, each question is shown one at a time for clarity
- If the caller supports a tool-level "yield_time_ms" hint, use a high value like 30000 so the user has time to answer before the next poll`,
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'Questions to ask the user (1-4 questions). Prefer concise multiple-choice questions and keep the list short unless more structure is truly necessary.',
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The question text. Keep it clear, specific, and easy to answer with the provided options.',
            },
            header: {
              type: 'string',
              description:
                'Short label displayed as a chip/tag (max 12 chars). E.g., "Framework", "Language"',
            },
            options: {
              type: 'array',
              description: 'Available choices (2+ options). Prefer concise multiple-choice answers. Can be strings or objects with label/value/description.',
              items: {
                oneOf: [
                  { type: 'string', description: 'Simple option text (used as both label and value)' },
                  {
                    type: 'object',
                    properties: {
                      label: {
                        type: 'string',
                        description: 'Display text for the option (1-5 words)',
                      },
                      value: {
                        type: 'string',
                        description:
                          'Machine-readable value returned to model. Defaults to label if omitted.',
                      },
                      description: {
                        type: 'string',
                        description: 'Explanation of what this option means',
                      },
                      recommended: {
                        type: 'boolean',
                        description:
                          'If true, shows "Recommended" badge. Use for your suggested option when there is a clearly sensible default.',
                      },
                    },
                    required: ['label'],
                  },
                ],
              },
              minItems: 2,
            },
            multiSelect: {
              type: 'boolean',
              description: 'Allow multiple selections. Default: false',
              default: false,
            },
            allowOther: {
              type: 'boolean',
              description: 'Show "Other" option with text input. Default: false',
              default: false,
            },
            default: {
              type: ['string', 'array'],
              description:
                'Default value(s) to use if user skips. Should match an option label.',
            },
            optional: {
              type: 'boolean',
              description:
                'If true, shows countdown timer. When timer expires, defaults are auto-selected. Use for minor/non-critical questions.',
              default: false,
            },
          },
          required: ['question', 'options'],
        },
        minItems: 1,
        maxItems: 4,
      },
    },
    required: ['questions'],
  },
  handler: async (args: Record<string, any>, context?: BuiltinToolContext) => {
    // Validate required questions array
    if (!args.questions || !Array.isArray(args.questions)) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: 'Missing required field: questions (must be an array)',
          example: {
            questions: [{
              question: 'What framework do you prefer?',
              options: [{ label: 'React' }, { label: 'Vue' }, { label: 'Angular' }]
            }]
          }
        }, null, 2) }],
        isError: true,
      };
    }

    const inputQuestions: QuestionInput[] = args.questions;

    // Transform input to internal format
    // Handle both string options ["opt1", "opt2"] and object options [{ label: "opt1" }]
    const questions: Question[] = inputQuestions.map((q) => ({
      question: q.question,
      header: q.header,
      options: (q.options ?? []).map(
        (opt): QuestionOption => {
          // Handle string shortcut: "Option text" -> { label: "Option text", value: "Option text" }
          if (typeof opt === 'string') {
            return { label: opt, value: opt };
          }
          // Handle object format: { label: "Option text", value?: "value", ... }
          return {
            label: opt.label,
            value: opt.value ?? opt.label,
            description: opt.description,
            recommended: opt.recommended,
          };
        }
      ),
      multiSelect: q.multiSelect,
      allowOther: q.allowOther,
      default: q.default,
      optional: q.optional,
    }));

    try {
      const result = await approvalManager.createQuestion(
        'ask_user_question',
        'builtin-ask-user',
        questions,
        undefined,
        0, // No timeout -- this tool waits indefinitely for human input
        context?.toolCallId,
        false, // Not a simple approval
        context?.agentId
      );

      // Result includes metadata about how the response was obtained
      // result: { answers, skipped?, timedOut?, timeoutSeconds? }
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: false,
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true,
      };
    }
  },
};
