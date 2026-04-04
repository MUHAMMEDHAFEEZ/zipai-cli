import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createSpecFile,
  listSpecFiles,
  readSpecFile,
  resolveSpecPath,
  sanitizeSpecName,
} from '../src/specs.js';

let tmpWorkspace;

beforeEach(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), 'zipai-specs-'));
});

afterEach(() => {
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

describe('specs: naming', () => {
  it('sanitizes names to lowercase slug', () => {
    assert.strictEqual(sanitizeSpecName('My New Spec!'), 'my-new-spec');
  });
});

describe('specs: create/list/read', () => {
  it('creates a spec markdown file in specs directory', () => {
    const created = createSpecFile('checkout flow', { workspaceDir: tmpWorkspace });
    assert.strictEqual(created.fileName, 'checkout-flow.md');
    assert.ok(existsSync(created.filePath));
  });

  it('lists spec files in sorted order', () => {
    createSpecFile('zeta', { workspaceDir: tmpWorkspace });
    createSpecFile('alpha', { workspaceDir: tmpWorkspace });

    assert.deepStrictEqual(listSpecFiles(tmpWorkspace), ['alpha.md', 'zeta.md']);
  });

  it('throws when creating same spec without force', () => {
    createSpecFile('auth', { workspaceDir: tmpWorkspace });
    assert.throws(
      () => createSpecFile('auth', { workspaceDir: tmpWorkspace }),
      /Spec already exists/
    );
  });

  it('overwrites existing spec when force is true', () => {
    createSpecFile('billing', { workspaceDir: tmpWorkspace, description: 'v1' });
    const overwritten = createSpecFile('billing', {
      workspaceDir: tmpWorkspace,
      description: 'v2',
      force: true,
    });

    assert.strictEqual(overwritten.overwritten, true);
    const content = readSpecFile('billing', tmpWorkspace);
    assert.ok(content.includes('v2'));
  });

  it('resolves and reads a created spec by name', () => {
    createSpecFile('payments', { workspaceDir: tmpWorkspace });
    const path = resolveSpecPath('payments', tmpWorkspace);

    assert.ok(path.endsWith('payments.md'));
    const content = readSpecFile('payments', tmpWorkspace);
    assert.ok(content.includes('# Payments'));
  });
});
