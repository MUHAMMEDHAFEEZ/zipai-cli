/**
 * Provider registry and capability helpers.
 *
 * Anthropic and Z.AI are currently wired to runtime chat calls,
 * while other providers are exposed on the command surface for future expansion.
 */

const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    keyField: 'apiKey',
    envKey: 'ANTHROPIC_API_KEY',
    chatReady: true,
    models: [
      'claude-3-opus-20240229',
      'claude-sonnet-4-20250514',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-haiku-20241022',
    ],
  },
  openai: {
    name: 'OpenAI',
    keyField: 'openaiKey',
    envKey: 'OPENAI_API_KEY',
    chatReady: false,
    models: [
      'gpt-5',
      'gpt-5-mini',
      'gpt-4.1',
      'o4-mini',
    ],
  },
  google: {
    name: 'Google',
    keyField: 'googleKey',
    envKey: 'GOOGLE_API_KEY',
    chatReady: false,
    models: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ],
  },
  groq: {
    name: 'Groq',
    keyField: 'groqKey',
    envKey: 'GROQ_API_KEY',
    chatReady: false,
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
    ],
  },
  zai: {
    name: 'Z.AI',
    keyField: 'zaiKey',
    envKey: 'ZAI_API_KEY',
    chatReady: true,
    models: [
      'glm-5v-turbo',
      'glm-4.5',
      'glm-4.5-air',
      'glm-4v-plus',
    ],
  },
};

export function getProviderMap() {
  return PROVIDERS;
}

export function normalizeProviderId(input) {
  const raw = String(input || '').trim().toLowerCase();
  const value = raw === 'z.ai' || raw === 'z-ai' ? 'zai' : raw;
  return PROVIDERS[value] ? value : null;
}

export function getDefaultProviderId() {
  return 'anthropic';
}

export function resolveProviderId(cfg = {}) {
  const fromCfg = normalizeProviderId(cfg.provider);
  if (fromCfg) return fromCfg;

  const fromEnv = normalizeProviderId(process.env.ZIPAI_PROVIDER);
  if (fromEnv) return fromEnv;

  return getDefaultProviderId();
}

function normalizeSecret(value) {
  if (value == null) return null;
  let key = String(value).trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  return key || null;
}

export function getProviderApiKey(cfg = {}, providerId = resolveProviderId(cfg)) {
  const def = PROVIDERS[providerId];
  if (!def) return null;

  const fromCfg = normalizeSecret(cfg[def.keyField]);
  if (fromCfg) return fromCfg;

  return normalizeSecret(process.env[def.envKey]);
}

export function listProviderStatus(cfg = {}) {
  const activeId = resolveProviderId(cfg);

  return Object.entries(PROVIDERS).map(([id, def]) => {
    const key = getProviderApiKey(cfg, id);
    return {
      id,
      name: def.name,
      envKey: def.envKey,
      chatReady: def.chatReady,
      active: id === activeId,
      configured: def.envKey ? Boolean(key) : true,
    };
  });
}

export function listModels(providerId) {
  const id = normalizeProviderId(providerId);
  if (!id) return [];
  return [...PROVIDERS[id].models];
}

export function getProviderDefinition(providerId) {
  const id = normalizeProviderId(providerId);
  if (!id) return null;
  return PROVIDERS[id];
}

export function inferProviderForModel(model) {
  const text = String(model || '').trim();
  if (!text) return null;

  // Supports provider/model format.
  if (text.includes('/')) {
    const [providerPart] = text.split('/');
    return normalizeProviderId(providerPart);
  }

  for (const [providerId, def] of Object.entries(PROVIDERS)) {
    if (def.models.includes(text)) {
      return providerId;
    }
  }

  return null;
}
