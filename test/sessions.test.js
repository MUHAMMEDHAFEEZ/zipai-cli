import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createSession,
  getActiveSession,
  getOrCreateSession,
  listSessions,
  setActiveSession,
  updateSessionHistory,
} from '../src/sessions.js';

let workspace;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'zipai-sessions-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('sessions', () => {
  it('creates a session and marks it active', () => {
    const created = createSession({ workspaceDir: workspace, name: 'Alpha' });
    assert.ok(created.id.startsWith('s_'));

    const active = getActiveSession(workspace);
    assert.ok(active);
    assert.strictEqual(active.id, created.id);
    assert.strictEqual(active.name, 'Alpha');
  });

  it('lists sessions with active flag', () => {
    const a = createSession({ workspaceDir: workspace, name: 'A' });
    const b = createSession({ workspaceDir: workspace, name: 'B' });
    void a;

    const sessions = listSessions(workspace);
    const active = sessions.find((s) => s.active);
    assert.ok(active);
    assert.strictEqual(active.id, b.id);
  });

  it('switches active session by id', () => {
    const a = createSession({ workspaceDir: workspace, name: 'A' });
    const b = createSession({ workspaceDir: workspace, name: 'B' });
    void b;

    setActiveSession(a.id, workspace);
    const active = getActiveSession(workspace);
    assert.ok(active);
    assert.strictEqual(active.id, a.id);
  });

  it('persists session history updates', () => {
    const created = createSession({ workspaceDir: workspace, name: 'Chat' });
    const history = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];

    updateSessionHistory(created.id, history, workspace);
    const active = getActiveSession(workspace);
    assert.ok(active);
    assert.deepStrictEqual(active.history, history);
  });

  it('returns active session with getOrCreateSession', () => {
    const created = createSession({ workspaceDir: workspace, name: 'Primary' });
    const selected = getOrCreateSession({ workspaceDir: workspace });
    assert.strictEqual(selected.id, created.id);
  });
});
