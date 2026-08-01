import { mkdir, writeFile } from 'node:fs/promises';

type ModelsDevModel = {
  name?: string;
  status?: string;
  tool_call?: boolean;
};

type ModelsDevProvider = {
  models?: Record<string, ModelsDevModel>;
};

type ModelsDevResponse = Record<string, ModelsDevProvider>;

type SupportedRemoteProvider = 'anthropic' | 'openai' | 'groq' | 'openrouter';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const OUTPUT_PATH = new URL('../shared/generated/modelCatalog.ts', import.meta.url);
const INTERPRETER_MODEL_OPTIONS = [
  { id: 'interpreter-smart', name: 'Interpreter Smart' },
  { id: 'interpreter-fast', name: 'Interpreter Fast' },
];
const REMOTE_PROVIDERS: readonly SupportedRemoteProvider[] = ['anthropic', 'openai', 'groq', 'openrouter'];

function toModelOptions(response: ModelsDevResponse, provider: SupportedRemoteProvider): Array<{ id: string; name: string }> {
  const models = response[provider]?.models ?? {};

  return Object.entries(models)
    .filter(([, model]) => model.tool_call === true && (model.status ?? 'stable') !== 'deprecated')
    .map(([id, model]) => ({
      id,
      name: model.name?.trim() || id,
    }))
    .sort((left, right) => {
      const byName = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      if (byName !== 0) {
        return byName;
      }
      return left.id.localeCompare(right.id, undefined, { sensitivity: 'base' });
    });
}

function renderModelOptions(name: string, options: Array<{ id: string; name: string }>): string {
  const renderedOptions = options.map((option) => `  { id: ${JSON.stringify(option.id)}, name: ${JSON.stringify(option.name)} },`).join('\n');
  return `export const ${name} = [\n${renderedOptions}\n];\n`;
}

async function main(): Promise<void> {
  const response = await fetch(MODELS_DEV_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${MODELS_DEV_URL}: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as ModelsDevResponse;
  const anthropicOptions = toModelOptions(payload, 'anthropic');
  const openaiOptions = toModelOptions(payload, 'openai');
  const groqOptions = toModelOptions(payload, 'groq');
  const openrouterOptions = toModelOptions(payload, 'openrouter');

  const fileContents = `// Generated file. Do not edit directly.\n// Regenerate with: pnpm run generate:model-catalog\n// Source: https://models.dev/api.json\n// Provider refresh queries used historically:\n//   curl -s https://models.dev/api.json | jq -r '.anthropic.models | to_entries[] | select(.value.tool_call == true and (.value.status // "stable") != "deprecated") | [.key, .value.name] | @tsv'\n//   curl -s https://models.dev/api.json | jq -r '.openai.models | to_entries[] | select(.value.tool_call == true and (.value.status // "stable") != "deprecated") | [.key, .value.name] | @tsv'\n//   curl -s https://models.dev/api.json | jq -r '.groq.models | to_entries[] | select(.value.tool_call == true and (.value.status // "stable") != "deprecated") | [.key, .value.name] | @tsv'\n//   curl -s https://models.dev/api.json | jq -r '.openrouter.models | to_entries[] | select(.value.tool_call == true and (.value.status // "stable") != "deprecated") | [.key, .value.name] | @tsv'\n\nexport type GeneratedModelOption = {\n  id: string;\n  name: string;\n};\n\n${renderModelOptions('INTERPRETER_MODEL_OPTIONS', INTERPRETER_MODEL_OPTIONS)}\n${renderModelOptions('ANTHROPIC_MODEL_OPTIONS', anthropicOptions)}\n${renderModelOptions('OPENAI_MODEL_OPTIONS', openaiOptions)}\n${renderModelOptions('GROQ_MODEL_OPTIONS', groqOptions)}\n${renderModelOptions('OPENROUTER_MODEL_OPTIONS', openrouterOptions)}\nexport const INTERPRETER_MODEL_ID_SET: ReadonlySet<string> = new Set(INTERPRETER_MODEL_OPTIONS.map((option) => option.id));\nexport const ANTHROPIC_MODEL_ID_SET: ReadonlySet<string> = new Set(ANTHROPIC_MODEL_OPTIONS.map((option) => option.id));\nexport const OPENAI_MODEL_ID_SET: ReadonlySet<string> = new Set(OPENAI_MODEL_OPTIONS.map((option) => option.id));\nexport const GROQ_MODEL_ID_SET: ReadonlySet<string> = new Set(GROQ_MODEL_OPTIONS.map((option) => option.id));\nexport const OPENROUTER_MODEL_ID_SET: ReadonlySet<string> = new Set(OPENROUTER_MODEL_OPTIONS.map((option) => option.id));\n`;

  await mkdir(new URL('../shared/generated/', import.meta.url), { recursive: true });
  await writeFile(OUTPUT_PATH, fileContents, 'utf-8');
}

await main();
