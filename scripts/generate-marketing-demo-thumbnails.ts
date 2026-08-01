import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getAllMarketingDemoSeedFiles,
  getMarketingDemoFileIconAssetUrl,
  getMarketingDemoThumbnailAssetUrl,
} from '../src/demo/marketingDemo.ts';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '..');
const publicRoot = path.join(repoRoot, 'apps/interpreter-marketing-demo/public');
const thumbnailsRoot = path.join(publicRoot, 'thumbnails');
const fileIconsRoot = path.join(publicRoot, 'file-icons');
const exportFileIconScriptPath = path.join(repoRoot, 'scripts', 'export-file-icon.swift');

function splitDemoPath(filePath: string): { workspaceName: string; relativePath: string } {
  const normalized = filePath.replace(/^\/+/, '');
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0) {
    throw new Error(`Unexpected demo path: ${filePath}`);
  }
  return {
    workspaceName: normalized.slice(0, slashIndex),
    relativePath: normalized.slice(slashIndex + 1),
  };
}

async function ensureCleanDir(dirPath: string): Promise<void> {
  await fs.rm(dirPath, { recursive: true, force: true });
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeSeededFile(
  tempRoot: string,
  seedFile: { filePath: string; content: string; assetUrl?: string },
): Promise<string> {
  const { workspaceName, relativePath } = splitDemoPath(seedFile.filePath);
  const destinationPath = path.join(tempRoot, workspaceName, relativePath);
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });

  if (seedFile.assetUrl) {
    const bundledAssetPath = path.join(publicRoot, seedFile.assetUrl.replace(/^\//, ''));
    await fs.copyFile(bundledAssetPath, destinationPath);
    return destinationPath;
  }

  await fs.writeFile(destinationPath, seedFile.content, 'utf8');
  return destinationPath;
}

async function generateThumbnail(sourcePath: string, targetPath: string): Promise<void> {
  const tempOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'marketing-demo-thumb-'));
  try {
    await execFileAsync('qlmanage', ['-t', '-x', '-s', '768', '-o', tempOutputDir, sourcePath]);
    const generatedName = `${path.basename(sourcePath)}.png`;
    const generatedPath = path.join(tempOutputDir, generatedName);
    await fs.copyFile(generatedPath, targetPath);
  } finally {
    await fs.rm(tempOutputDir, { recursive: true, force: true });
  }
}

async function generateFileIcon(kind: 'md' | 'pdf' | 'generic', targetPath: string): Promise<void> {
  await execFileAsync('swift', [exportFileIconScriptPath, kind, targetPath]);
}

async function ensureFileIconAssets(): Promise<void> {
  await ensureCleanDir(fileIconsRoot);

  const fileIconSpecs = [
    {
      kind: 'md' as const,
      targetPath: path.join(publicRoot, getMarketingDemoFileIconAssetUrl('/generalist-robotics-wiki/AGENTS.md').replace(/^\//, '')),
    },
    {
      kind: 'pdf' as const,
      targetPath: path.join(publicRoot, getMarketingDemoFileIconAssetUrl('/generalist-robotics-wiki/raw/papers/pi0-general-robot-control.pdf').replace(/^\//, '')),
    },
    {
      kind: 'generic' as const,
      targetPath: path.join(publicRoot, getMarketingDemoFileIconAssetUrl('/generalist-robotics-wiki/generic.txt').replace(/^\//, '')),
    },
  ];

  for (const { kind, targetPath } of fileIconSpecs) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await generateFileIcon(kind, targetPath);
    console.log(`generated ${path.relative(publicRoot, targetPath)}`);
  }
}

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'marketing-demo-workspace-'));
  await ensureCleanDir(thumbnailsRoot);

  try {
    for (const seedFile of getAllMarketingDemoSeedFiles()) {
      const sourcePath = await writeSeededFile(tempRoot, seedFile);
      const assetUrl = getMarketingDemoThumbnailAssetUrl(seedFile.filePath);
      const targetPath = path.join(publicRoot, assetUrl.replace(/^\//, ''));
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await generateThumbnail(sourcePath, targetPath);
      console.log(`generated ${assetUrl}`);
    }

    await ensureFileIconAssets();
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
