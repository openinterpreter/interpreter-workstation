#!/usr/bin/env node
// Read-only, bounded S3 compatibility check. Never print credentials, raw
// provider responses, object metadata values, or unrelated object names.
import { spawnSync } from 'node:child_process';

const key = 'releases/Interpreter-arm64-0.2.219.dmg';
const bucket = 'workstationupdater';
const endpoint = process.env.AWS_ENDPOINT_URL;
const region = process.env.AWS_REGION;
if (!endpoint || !region || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  throw new Error('Scoped storage configuration is unavailable');
}
function run(args) {
  const result = spawnSync('aws', [...args, '--endpoint-url', endpoint, '--region', region, '--output', 'json'],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 });
  if (result.error) return { ok: false, code: result.error.code ?? 'process_error' };
  if (result.status !== 0) {
    const code = /An error occurred \(([^)]+)\) when calling/.exec(result.stderr ?? '')?.[1] ?? 'unknown';
    return { ok: false, code, exitStatus: result.status };
  }
  try { return { ok: true, value: JSON.parse(result.stdout) }; }
  catch { return { ok: false, code: 'invalid_json' }; }
}
const pages = [];
const automatic = run(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', key]);
const automaticSummary = automatic.ok ? {
  isTruncatedPresent: Object.hasOwn(automatic.value, 'IsTruncated'),
  keyCountPresent: Object.hasOwn(automatic.value, 'KeyCount'),
  contentsPresent: Object.hasOwn(automatic.value, 'Contents'),
  exactMatches: (Array.isArray(automatic.value.Contents) ? automatic.value.Contents : [])
    .filter((item) => item?.Key === key).length,
  returnedFields: Object.keys(automatic.value).sort(),
} : { error: automatic.code, exitStatus: automatic.exitStatus };
let continuation;
for (let index = 0; index < 3; index++) {
  const args = ['s3api', 'list-objects-v2', '--no-paginate', '--bucket', bucket,
    '--prefix', key, '--max-keys', '1'];
  if (continuation) args.push('--continuation-token', continuation);
  const result = run(args);
  if (!result.ok) { pages.push({ page: index + 1, error: result.code, exitStatus: result.exitStatus }); break; }
  const data = result.value;
  const contents = Array.isArray(data.Contents) ? data.Contents : null;
  const matches = contents?.filter((item) => item?.Key === key) ?? [];
  pages.push({
    page: index + 1,
    isTruncatedPresent: Object.hasOwn(data, 'IsTruncated'),
    isTruncated: data.IsTruncated ?? null,
    keyCountPresent: Object.hasOwn(data, 'KeyCount'),
    keyCount: Number.isSafeInteger(data.KeyCount) ? data.KeyCount : null,
    contentsPresent: Object.hasOwn(data, 'Contents'),
    contentsCount: contents?.length ?? null,
    exactMatches: matches.length,
    exactSizes: matches.map((item) => Number.isSafeInteger(item.Size) ? item.Size : null),
    continuationPresent: typeof data.NextContinuationToken === 'string' && data.NextContinuationToken.length > 0,
    returnedFields: Object.keys(data).sort(),
  });
  if (data.IsTruncated !== true) break;
  if (typeof data.NextContinuationToken !== 'string' || !data.NextContinuationToken || index === 2) break;
  continuation = data.NextContinuationToken;
}
const head = run(['s3api', 'head-object', '--bucket', bucket, '--key', key]);
const headSummary = head.ok ? {
  status: 'present', size: head.value.ContentLength,
  versionIdPresent: typeof head.value.VersionId === 'string',
  checksumSha256Present: typeof head.value.ChecksumSHA256 === 'string',
} : { status: 'unavailable', error: head.code, exitStatus: head.exitStatus };
console.log(JSON.stringify({ key, automatic: automaticSummary, pages, head: headSummary }));
if (automaticSummary.error || pages.some((page) => page.error && page.error !== 'NoSuchKey') ||
    (headSummary.status === 'unavailable' && !['404', 'NotFound', 'NoSuchKey'].includes(headSummary.error))) {
  process.exitCode = 1;
}
