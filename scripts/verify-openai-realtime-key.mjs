#!/usr/bin/env node

// Fail-fast preflight for the OpenAI key inherited by this process. The public
// repository never reads keys from a sibling service or commits local env files.

function masked(key) {
  return `<len ${key.length}, ends ...${key.slice(-4)}>`;
}

function fail(message) {
  console.error(`[openai-key] FAIL: ${message}`);
  process.exit(1);
}

const effectiveKey = process.env.OPENAI_API_KEY?.trim() || null;
const source = 'OPENAI_API_KEY';

if (!effectiveKey) {
  fail('no OPENAI_API_KEY in the process environment');
}
console.log(`[openai-key] probing key ${masked(effectiveKey)} from ${source}`);

const response = await fetch('https://api.openai.com/v1/responses', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${effectiveKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ model: 'gpt-4o-mini', input: 'ping', max_output_tokens: 16 }),
  signal: AbortSignal.timeout(20000),
});

if (response.ok) {
  console.log(`[openai-key] OK: key from ${source} is valid and billing-active (HTTP ${response.status})`);
  process.exit(0);
}

const body = (await response.text()).slice(0, 400);
fail(`key from ${source} was rejected: HTTP ${response.status} ${body}`);
