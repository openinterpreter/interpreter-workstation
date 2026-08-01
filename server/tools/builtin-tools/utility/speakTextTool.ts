import { getCurrentWorkspace } from '../../../utils/workspace';
import { resolvePathWithWorkspace } from '../../../utils/permissions';
import {
  TTS_MODEL_FAMILIES,
  TTS_MODELS,
  TTS_PROVIDERS,
  type TtsModelFamily,
  type TtsModelId,
  type TtsModelSize,
  type TtsProvider,
} from '../../../../shared/types/tts';
import type { BuiltinToolDefinition } from '../../builtinTools';

function isTtsModelId(value: unknown): value is TtsModelId {
  return typeof value === 'string' && TTS_MODELS.some((model) => model.id === value);
}

function isTtsModelFamily(value: unknown): value is TtsModelFamily {
  return typeof value === 'string' && (TTS_MODEL_FAMILIES as readonly string[]).includes(value);
}

const TTS_MODEL_SIZE_VALUES = Array.from(new Set(
  TTS_MODELS.map((model) => model.size),
)) as TtsModelSize[];

function isTtsModelSize(value: unknown): value is TtsModelSize {
  return typeof value === 'string' && (TTS_MODEL_SIZE_VALUES as readonly string[]).includes(value);
}

export const speakTextTool: BuiltinToolDefinition = {
  name: 'speak_text',
  description: `Generate speech from text using the configured sherpa-onnx TTS engine and optionally play it immediately.

Use this when you want spoken output. You can provide raw text directly, or pass a text file path (txt/markdown/plain text). You can also write the generated audio to a WAV file.

Defaults:
- Model: current TTS settings model
- Voice: current TTS settings voice
- Playback: enabled`,
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Text to synthesize and speak.',
      },
      inputPath: {
        type: 'string',
        description: 'Optional path to a plain-text input file. Supports workspace-relative or absolute paths.',
      },
      outputPath: {
        type: 'string',
        description: 'Optional output WAV file path. Supports workspace-relative or absolute paths.',
      },
      play: {
        type: 'boolean',
        description: 'Whether to play the generated speech out loud immediately. Default: true',
        default: true,
      },
      modelFamily: {
        type: 'string',
        enum: [...TTS_MODEL_FAMILIES],
        description: 'Optional engine family override (kitten/kokoro/vits).',
      },
      modelSize: {
        type: 'string',
        enum: [...TTS_MODEL_SIZE_VALUES],
        description: 'Optional model size override. Used with modelFamily when provided.',
      },
      modelId: {
        type: 'string',
        enum: TTS_MODELS.map((model) => model.id),
        description: 'Optional exact model ID override. If set, it takes precedence over modelSize.',
      },
      voiceId: {
        type: 'integer',
        description: 'Optional voice ID override (0-based).',
      },
      speed: {
        type: 'number',
        description: 'Optional speech speed multiplier (0.25-3.0).',
      },
      provider: {
        type: 'string',
        enum: [...TTS_PROVIDERS],
        description: 'Optional runtime backend/provider override.',
      },
    },
  },
  fileAccess: {
    mode: 'write',
    pathArg: ['inputPath', 'outputPath'],
    pathArgModes: {
      inputPath: 'read',
      outputPath: 'write',
    },
  },
  mode: 'write',
  handler: async (args: Record<string, unknown>) => {
    const textArg = typeof args.text === 'string' ? args.text : undefined;
    const inputPathArg = typeof args.inputPath === 'string' ? args.inputPath : undefined;
    const outputPathArg = typeof args.outputPath === 'string' ? args.outputPath : undefined;

    if (!textArg?.trim() && !inputPathArg?.trim()) {
      return {
        content: [{
          type: 'text',
          text: 'Error: Provide either `text` or `inputPath`.',
        }],
        isError: true,
      };
    }

    const workspace = getCurrentWorkspace();

    const inputPath = inputPathArg?.trim()
      ? resolvePathWithWorkspace(inputPathArg.trim(), workspace)
      : undefined;

    const outputPath = outputPathArg?.trim()
      ? resolvePathWithWorkspace(outputPathArg.trim(), workspace)
      : undefined;

    const modelIdArg = isTtsModelId(args.modelId) ? args.modelId : undefined;
    const modelFamilyArg = isTtsModelFamily(args.modelFamily) ? args.modelFamily : undefined;
    const modelSizeArg = isTtsModelSize(args.modelSize) ? args.modelSize : undefined;
    const providerArg = typeof args.provider === 'string' && (TTS_PROVIDERS as readonly string[]).includes(args.provider)
      ? args.provider as TtsProvider
      : undefined;

    if (typeof args.modelId === 'string' && !modelIdArg) {
      const { formatInstalledTtsModelsForError, listModels } = await import('../../../handlers/tts');
      const models = await listModels();
      return {
        content: [{
          type: 'text',
          text: `Error: Unknown TTS model: ${args.modelId}. Known modelId values: ${TTS_MODELS.map((model) => model.id).join(', ')}. ${formatInstalledTtsModelsForError(models.models)}`,
        }],
        isError: true,
      };
    }

    if (typeof args.modelFamily === 'string' && !modelFamilyArg) {
      return {
        content: [{
          type: 'text',
          text: `Error: Unknown TTS modelFamily: ${args.modelFamily}. Available modelFamily values: ${TTS_MODEL_FAMILIES.join(', ')}.`,
        }],
        isError: true,
      };
    }

    if (typeof args.modelSize === 'string' && !modelSizeArg) {
      return {
        content: [{
          type: 'text',
          text: `Error: Unknown TTS modelSize: ${args.modelSize}. Available modelSize values: ${TTS_MODEL_SIZE_VALUES.join(', ')}.`,
        }],
        isError: true,
      };
    }

    if (typeof args.provider === 'string' && !providerArg) {
      return {
        content: [{
          type: 'text',
          text: `Error: Unknown TTS provider: ${args.provider}. Available provider values: ${TTS_PROVIDERS.join(', ')}.`,
        }],
        isError: true,
      };
    }

    const resolvedModelId: TtsModelId | undefined = (() => {
      if (modelIdArg) {
        return modelIdArg;
      }

      if (modelFamilyArg && modelSizeArg) {
        const byFamilyAndSize = TTS_MODELS.find(
          (model) => model.family === modelFamilyArg && model.size === modelSizeArg,
        );
        if (byFamilyAndSize) return byFamilyAndSize.id;
      }

      if (modelFamilyArg) {
        const byFamily = TTS_MODELS.find((model) => model.family === modelFamilyArg);
        if (byFamily) return byFamily.id;
      }

      if (modelSizeArg) {
        const bySize = TTS_MODELS.find((model) => model.size === modelSizeArg);
        if (bySize) return bySize.id;
      }

      return undefined;
    })();

    const { speakText } = await import('../../../handlers/tts');
    const result = await speakText({
      text: textArg,
      inputPath,
      outputPath,
      play: args.play !== false,
      modelId: resolvedModelId,
      voiceId: Number.isInteger(args.voiceId) ? (args.voiceId as number) : undefined,
      speed: typeof args.speed === 'number' ? args.speed : undefined,
      provider: providerArg,
    });

    if (!result.success) {
      return {
        content: [{
          type: 'text',
          text: `Error: ${result.error || 'Failed to synthesize speech.'}`,
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          chars: result.chars,
          modelId: result.modelId,
          voiceId: result.voiceId,
          durationSeconds: result.durationSeconds,
          outputPath: result.outputPath ?? null,
          played: args.play !== false,
        }, null, 2),
      }],
    };
  },
};
