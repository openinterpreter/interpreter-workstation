const fs = require('fs');
const path = require('path');

const ALLOWED_BUNDLED_SKILLS = [
  'accrual-schedule',
  'audit-xls',
  'browser-control',
  'computer-use',
  'doc',
  'media-creation',
  'month-end-closer',
  'pdf',
  'playwright',
  'roll-forward',
  'screenshot',
  'settings',
  'skill-creator',
  'slides',
  'spreadsheets',
  'transcribe',
  'variance-commentary',
  'wiki-bootstrap',
  'wiki-ingest',
  'wiki-lint',
  'wiki-maintainer',
  'wiki-query',
  'xlsx-author',
];
const REQUIRED_BUNDLED_SKILL_FILES = {
  'accrual-schedule': [
    'SKILL.md',
    'agents/openai.yaml',
    'LICENSE.txt',
  ],
  'audit-xls': [
    'SKILL.md',
    'agents/openai.yaml',
    'LICENSE.txt',
  ],
  'browser-control': [
    'SKILL.md',
    'agents/openai.yaml',
  ],
  'computer-use': [
    'SKILL.md',
    'SKILL.win32.md',
    'WEB_APPS.md',
    'agents/openai.yaml',
    'agents/openai.win32.yaml',
  ],
  doc: [
    'SKILL.md',
    'agents/openai.yaml',
    'scripts/render_docx.py',
  ],
  'media-creation': [
    'SKILL.md',
    'agents/openai.yaml',
  ],
  'month-end-closer': [
    'SKILL.md',
    'agents/openai.yaml',
    'LICENSE.txt',
  ],
  pdf: [
    'SKILL.md',
    'agents/openai.yaml',
  ],
  playwright: [
    'SKILL.md',
    'agents/openai.yaml',
    'references/cli.md',
    'references/workflows.md',
    'scripts/playwright_cli.sh',
  ],
  'roll-forward': [
    'SKILL.md',
    'agents/openai.yaml',
    'LICENSE.txt',
  ],
  screenshot: [
    'SKILL.md',
    'agents/openai.yaml',
    'scripts/take_screenshot.py',
  ],
  settings: [
    'SKILL.md',
    'agents/openai.yaml',
  ],
  'skill-creator': [
    'SKILL.md',
    'agents/openai.yaml',
    'references/openai_yaml.md',
    'scripts/generate_openai_yaml.py',
    'scripts/init_skill.py',
    'scripts/quick_validate.py',
  ],
  spreadsheets: [
    'SKILL.md',
    'agents/openai.yaml',
    'style_guidelines.md',
    'templates/financial_models.md',
  ],
  slides: [
    'SKILL.md',
    'agents/openai.yaml',
    'scripts/init_pro_deck_builder_js.js',
    'scripts/prepare_reference_prompts.js',
    'scripts/pro_deck_quality_check.js',
    'templates/build_pro_deck_template.js',
  ],
  'wiki-maintainer': [
    'SKILL.md',
    'agents/openai.yaml',
  ],
  'wiki-ingest': [
    'SKILL.md',
    'agents/openai.yaml',
  ],
  'wiki-query': [
    'SKILL.md',
    'agents/openai.yaml',
  ],
  'wiki-lint': [
    'SKILL.md',
    'agents/openai.yaml',
  ],
  'wiki-bootstrap': [
    'SKILL.md',
    'agents/openai.yaml',
  ],
  transcribe: [
    'SKILL.md',
    'agents/openai.yaml',
    'references/api.md',
  ],
  'variance-commentary': [
    'SKILL.md',
    'agents/openai.yaml',
    'LICENSE.txt',
  ],
  'xlsx-author': [
    'SKILL.md',
    'agents/openai.yaml',
    'LICENSE.txt',
  ],
};

function extractSkillFrontmatter(skillDocPath) {
  const contents = fs.readFileSync(skillDocPath, 'utf8');
  const lines = contents.split(/\r?\n/);
  if (lines[0] !== '---') {
    throw new Error(`[bundled-skills] ${skillDocPath} must start with YAML frontmatter delimited by ---`);
  }

  const closingIndex = lines.slice(1).indexOf('---');
  if (closingIndex === -1) {
    throw new Error(`[bundled-skills] ${skillDocPath} is missing a closing YAML frontmatter delimiter`);
  }

  return lines.slice(1, closingIndex + 1).join('\n');
}

function assertSkillDocFrontmatter(skillDocPath) {
  const frontmatter = extractSkillFrontmatter(skillDocPath);
  const hasName = /^name:\s*.+$/m.test(frontmatter);
  const hasDescription = /^description:\s*.+$/m.test(frontmatter);

  if (!hasName || !hasDescription) {
    throw new Error(
      `[bundled-skills] ${skillDocPath} must declare frontmatter name and description fields`,
    );
  }
}

function listBundledSkillDirs(skillsRoot) {
  if (!fs.existsSync(skillsRoot)) {
    throw new Error(`[bundled-skills] Skills directory not found: ${skillsRoot}`);
  }

  return fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

function assertBundledCodexSkills(skillsRoot) {
  const actualSkills = listBundledSkillDirs(skillsRoot);
  const expectedSkills = [...ALLOWED_BUNDLED_SKILLS].sort();

  if (actualSkills.length !== expectedSkills.length
    || actualSkills.some((skill, index) => skill !== expectedSkills[index])) {
    throw new Error(
      `[bundled-skills] Unexpected bundled Codex skills in ${skillsRoot}. `
      + `Expected: ${expectedSkills.join(', ')}. `
      + `Found: ${actualSkills.join(', ') || '(none)'}.`,
    );
  }

  for (const skillName of expectedSkills) {
    const requiredFiles = REQUIRED_BUNDLED_SKILL_FILES[skillName] || [];
    for (const relativeFilePath of requiredFiles) {
      const requiredPath = path.join(skillsRoot, skillName, relativeFilePath);
      if (!fs.existsSync(requiredPath)) {
        throw new Error(`[bundled-skills] Missing required skill payload: ${requiredPath}`);
      }
    }

    assertSkillDocFrontmatter(path.join(skillsRoot, skillName, 'SKILL.md'));
  }
}

module.exports = {
  ALLOWED_BUNDLED_SKILLS,
  REQUIRED_BUNDLED_SKILL_FILES,
  assertBundledCodexSkills,
};
