import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  inferProviderForModel,
  getDefaultProviderId,
  getProviderApiKey,
  listModels,
  listProviderStatus,
  normalizeProviderId,
  resolveProviderId,
} from '../src/providers.js';

describe('providers: normalize/resolve', () => {
  it('normalizes provider ids case-insensitively', () => {
    assert.strictEqual(normalizeProviderId('Anthropic'), 'anthropic');
    assert.strictEqual(normalizeProviderId('OPENAI'), 'openai');
    assert.strictEqual(normalizeProviderId('z.ai'), 'zai');
    assert.strictEqual(normalizeProviderId('Z-AI'), 'zai');
  });

  it('returns null for unknown providers', () => {
    assert.strictEqual(normalizeProviderId('unknown-provider'), null);
  });

  it('resolves from config and falls back to default', () => {
    assert.strictEqual(resolveProviderId({ provider: 'openai' }), 'openai');
    assert.strictEqual(resolveProviderId({}), getDefaultProviderId());
  });
});

describe('providers: credentials', () => {
  it('reads api key from config for provider key field', () => {
    const key = getProviderApiKey({ apiKey: 'sk-ant-123' }, 'anthropic');
    assert.strictEqual(key, 'sk-ant-123');
  });

  it('reads zai key from config for provider key field', () => {
    const key = getProviderApiKey({ zaiKey: 'zai-123' }, 'zai');
    assert.strictEqual(key, 'zai-123');
  });

  it('falls back to env key and strips quotes', () => {
    const old = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = '"sk-openai-123"';

    try {
      const key = getProviderApiKey({}, 'openai');
      assert.strictEqual(key, 'sk-openai-123');
    } finally {
      if (old === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = old;
      }
    }
  });
});

describe('providers: status/models', () => {
  it('reports active provider and configuration state', () => {
    const rows = listProviderStatus({ provider: 'anthropic', apiKey: 'sk-ant-123' });
    const anthropic = rows.find((row) => row.id === 'anthropic');
    const zai = rows.find((row) => row.id === 'zai');

    assert.ok(anthropic);
    assert.ok(zai);
    assert.strictEqual(anthropic.active, true);
    assert.strictEqual(anthropic.configured, true);
    assert.strictEqual(zai.chatReady, true);
  });

  it('returns models for known provider and empty for unknown', () => {
    assert.ok(listModels('anthropic').length > 0);
    assert.ok(listModels('zai').includes('glm-5v-turbo'));
    assert.deepStrictEqual(listModels('does-not-exist'), []);
  });

  it('infers provider from model name and provider/model format', () => {
    assert.strictEqual(inferProviderForModel('glm-5v-turbo'), 'zai');
    assert.strictEqual(inferProviderForModel('z.ai/glm-5v-turbo'), 'zai');
    assert.strictEqual(inferProviderForModel('anthropic/claude-sonnet-4-20250514'), 'anthropic');
    assert.strictEqual(inferProviderForModel('unknown-model-x'), null);
  });
});
