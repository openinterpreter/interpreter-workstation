#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [binaryPath, outputPath] = process.argv.slice(2);

if (!binaryPath || !outputPath) {
  console.error('Usage: node scripts/generate-cua-driver-tool-metadata.mjs <cua-driver-binary> <output-json>');
  process.exit(1);
}

if (!fs.existsSync(binaryPath)) {
  throw new Error(`cua-driver binary not found: ${binaryPath}`);
}

function parseDescribeOutput(output) {
  const nameMatch = output.match(/^name:\s*(.+)$/m);
  if (!nameMatch) {
    throw new Error(`describe output missing name: ${output.slice(0, 200)}`);
  }

  const schemaMarker = '\ninput_schema:\n';
  const schemaIndex = output.indexOf(schemaMarker);
  if (schemaIndex < 0) {
    throw new Error(`describe output missing input_schema for ${nameMatch[1]}`);
  }

  const descriptionMarker = '\ndescription:\n';
  const descriptionIndex = output.indexOf(descriptionMarker);
  const description = descriptionIndex >= 0
    ? output.slice(descriptionIndex + descriptionMarker.length, schemaIndex).trim()
    : '';
  const inputSchema = JSON.parse(output.slice(schemaIndex + schemaMarker.length).trim());

  if (inputSchema?.type !== 'object' || !inputSchema.properties) {
    throw new Error(`describe returned invalid input schema for ${nameMatch[1]}`);
  }

  return {
    name: nameMatch[1].trim(),
    description,
    inputSchema,
  };
}

const listOutput = execFileSync(binaryPath, ['list-tools', '--no-daemon'], {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
});

const toolNames = listOutput
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => line.split(':', 1)[0]?.trim())
  .filter(Boolean);

if (toolNames.length === 0) {
  throw new Error(`cua-driver list-tools returned no tools: ${listOutput}`);
}

const tools = toolNames.map((toolName) => {
  const describeOutput = execFileSync(binaryPath, ['describe', toolName, '--compact', '--no-daemon'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseDescribeOutput(describeOutput);
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: {
    submodulePath: 'submodules/interpreter-cua',
    binary: 'libs/cua-driver',
  },
  tools,
}, null, 2)}\n`);

console.log(`[cua-driver] generated ${tools.length} tool definitions at ${outputPath}`);
