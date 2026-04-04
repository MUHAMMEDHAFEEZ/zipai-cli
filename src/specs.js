/**
 * Spec workflow helpers inspired by speckit.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SPECS_DIR_NAME = 'specs';

function toTitleCase(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

export function sanitizeSpecName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function getSpecsDir(workspaceDir = process.cwd()) {
  return join(workspaceDir, SPECS_DIR_NAME);
}

export function ensureSpecsDir(workspaceDir = process.cwd()) {
  const specsDir = getSpecsDir(workspaceDir);
  if (!existsSync(specsDir)) {
    mkdirSync(specsDir, { recursive: true });
  }
  return specsDir;
}

export function listSpecFiles(workspaceDir = process.cwd()) {
  const specsDir = getSpecsDir(workspaceDir);
  if (!existsSync(specsDir)) return [];

  return readdirSync(specsDir)
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));
}

export function resolveSpecPath(name, workspaceDir = process.cwd()) {
  const cleaned = sanitizeSpecName(name);
  if (!cleaned) {
    throw new Error('Spec name must include letters or numbers');
  }
  return join(getSpecsDir(workspaceDir), `${cleaned}.md`);
}

function buildSpecTemplate({ name, title, description }) {
  const finalTitle = title || toTitleCase(name);
  const now = new Date().toISOString();
  const descriptionLine = description
    ? description
    : 'Describe the user problem and expected outcome.';

  return [
    `# ${finalTitle}`,
    '',
    `Created: ${now}`,
    '',
    '## Summary',
    descriptionLine,
    '',
    '## Goals',
    '- Goal 1',
    '- Goal 2',
    '',
    '## Non-Goals',
    '- Non-goal 1',
    '',
    '## Requirements',
    '- [ ] Requirement 1',
    '- [ ] Requirement 2',
    '',
    '## Acceptance Criteria',
    '- [ ] Scenario 1',
    '- [ ] Scenario 2',
    '',
    '## Tasks',
    '- [ ] Task 1',
    '- [ ] Task 2',
    '',
  ].join('\n');
}

export function createSpecFile(name, options = {}) {
  const {
    workspaceDir = process.cwd(),
    force = false,
    title,
    description,
  } = options;

  const cleaned = sanitizeSpecName(name);
  if (!cleaned) {
    throw new Error('Spec name must include letters or numbers');
  }

  const specsDir = ensureSpecsDir(workspaceDir);
  const fileName = `${cleaned}.md`;
  const filePath = join(specsDir, fileName);
  const existed = existsSync(filePath);

  if (existed && !force) {
    throw new Error(`Spec already exists: ${fileName}. Use --force to overwrite.`);
  }

  const content = buildSpecTemplate({
    name: cleaned,
    title,
    description,
  });

  writeFileSync(filePath, content, 'utf8');

  return {
    fileName,
    filePath,
    overwritten: existed,
  };
}

export function readSpecFile(name, workspaceDir = process.cwd()) {
  const filePath = resolveSpecPath(name, workspaceDir);
  if (!existsSync(filePath)) {
    throw new Error(`Spec not found: ${sanitizeSpecName(name)}.md`);
  }
  return readFileSync(filePath, 'utf8');
}
