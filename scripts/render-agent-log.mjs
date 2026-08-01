import fs from 'node:fs';
import path from 'node:path';

function usage() {
  console.error('Usage: pnpm agent:log [--write] [--out <path>] <session.log|test.log|.agent-events.jsonl>');
  process.exit(1);
}

function resolveEventLogPath(inputPath) {
  const resolved = path.resolve(inputPath);

  if (resolved.endsWith('.agent-events.jsonl')) {
    return resolved;
  }

  if (resolved.endsWith('.agent.log')) {
    return resolved.replace(/\.agent\.log$/i, '.agent-events.jsonl');
  }

  if (resolved.endsWith('.log')) {
    return resolved.replace(/\.log$/i, '.agent-events.jsonl');
  }

  throw new Error(`Unsupported input path: ${inputPath}`);
}

function defaultOutputPath(eventLogPath) {
  return eventLogPath.replace(/\.agent-events\.jsonl$/i, '.agent.log');
}

function parseArgs(argv) {
  let write = false;
  let outPath = null;
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--write') {
      write = true;
      continue;
    }
    if (value === '--out') {
      outPath = argv[index + 1] ? path.resolve(argv[index + 1]) : null;
      index += 1;
      continue;
    }
    positional.push(value);
  }

  if (positional.length !== 1) {
    usage();
  }

  return {
    write,
    outPath,
    inputPath: positional[0],
  };
}

function renderScalar(value) {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function pushBlock(lines, indentLevel, tag, content) {
  const indent = '  '.repeat(indentLevel);
  lines.push(`${indent}<${tag}>`);
  const rendered = renderScalar(content);
  for (const line of rendered.split('\n')) {
    lines.push(`${indent}${line}`);
  }
  lines.push(`${indent}</${tag}>`);
  lines.push('');
}

function pushToolBlock(lines, indentLevel, tag, toolName, payload) {
  const indent = '  '.repeat(indentLevel);
  lines.push(`${indent}<${tag} name="${toolName}">`);
  const rendered = renderScalar(payload);
  for (const line of rendered.split('\n')) {
    lines.push(`${indent}${line}`);
  }
  lines.push(`${indent}</${tag}>`);
  lines.push('');
}

function pushTools(lines, indentLevel, tools) {
  const indent = '  '.repeat(indentLevel);
  lines.push(`${indent}<tools>`);
  for (const tool of tools) {
    lines.push(`${indent}<tool name="${tool.name}">`);
    lines.push(`${indent}  <description>${tool.description ?? ''}</description>`);
    if (tool.inputSchema) {
      lines.push(`${indent}  <parameters>`);
      const schema = JSON.stringify(tool.inputSchema, null, 2);
      for (const line of schema.split('\n')) {
        lines.push(`${indent}    ${line}`);
      }
      lines.push(`${indent}  </parameters>`);
    }
    lines.push(`${indent}</tool>`);
    lines.push('');
  }
  lines.push(`${indent}</tools>`);
  lines.push('');
}

function renderTranscript(records) {
  const lines = [];
  let indentLevel = 0;

  for (const record of records) {
    switch (record.type) {
      case 'system':
        pushBlock(lines, indentLevel, 'system', record.content ?? '');
        break;
      case 'tools':
        pushTools(lines, indentLevel, Array.isArray(record.tools) ? record.tools : []);
        break;
      case 'user':
        pushBlock(lines, indentLevel, 'user', record.content ?? '');
        break;
      case 'assistant':
        pushBlock(lines, indentLevel, 'assistant', record.content ?? '');
        break;
      case 'reasoning':
        pushBlock(lines, indentLevel, 'reasoning', record.content ?? '');
        break;
      case 'tool_call':
        pushToolBlock(lines, indentLevel, 'tool_call', record.toolName ?? 'unknown', record.input ?? '');
        break;
      case 'tool_result':
        pushToolBlock(lines, indentLevel, 'tool_result', record.toolName ?? 'unknown', record.output ?? '');
        break;
      case 'tool_error':
        pushToolBlock(lines, indentLevel, 'tool_error', record.toolName ?? 'unknown', record.output ?? '');
        break;
      case 'subagent_start':
        lines.push(`${'  '.repeat(indentLevel)}<subagent name="${record.agentName ?? 'unknown'}">`);
        indentLevel += 1;
        if (record.task) {
          pushBlock(lines, indentLevel, 'task', record.task);
        }
        break;
      case 'subagent_end':
        indentLevel = Math.max(0, indentLevel - 1);
        lines.push(`${'  '.repeat(indentLevel)}</subagent>`);
        lines.push('');
        break;
      default:
        break;
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function loadTranscriptRecords(eventLogPath) {
  const raw = fs.readFileSync(eventLogPath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => record.kind === 'transcript' && typeof record.type === 'string');
}

function main() {
  const { write, outPath, inputPath } = parseArgs(process.argv.slice(2));
  const eventLogPath = resolveEventLogPath(inputPath);

  if (!fs.existsSync(eventLogPath)) {
    throw new Error(`Agent event log not found: ${eventLogPath}`);
  }

  const transcript = renderTranscript(loadTranscriptRecords(eventLogPath));
  const finalOutPath = outPath ?? defaultOutputPath(eventLogPath);

  if (write || outPath) {
    fs.mkdirSync(path.dirname(finalOutPath), { recursive: true });
    fs.writeFileSync(finalOutPath, transcript, 'utf8');
    process.stdout.write(`${finalOutPath}\n`);
    return;
  }

  process.stdout.write(transcript);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
