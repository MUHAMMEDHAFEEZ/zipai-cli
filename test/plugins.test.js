import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  installPlugin,
  listPlugins,
} from '../src/plugins.js';

let workspace;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'zipai-plugins-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('plugins', () => {
  it('starts with no plugins', () => {
    assert.deepStrictEqual(listPlugins(workspace), []);
  });

  it('installs a plugin and lists it', () => {
    const installed = installPlugin('@demo/logger', { workspaceDir: workspace });
    assert.ok(installed.id.includes('demo-logger'));

    const listed = listPlugins(workspace);
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].module, '@demo/logger');
  });

  it('throws when plugin already exists without force', () => {
    installPlugin('demo', { workspaceDir: workspace });
    assert.throws(
      () => installPlugin('demo', { workspaceDir: workspace }),
      /already installed/
    );
  });

  it('overwrites existing plugin with force', () => {
    installPlugin('demo', { workspaceDir: workspace });
    const result = installPlugin('demo', { workspaceDir: workspace, force: true });
    assert.strictEqual(result.overwritten, true);
  });
});
