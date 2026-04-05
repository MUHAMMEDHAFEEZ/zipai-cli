/**
 * AI client with provider-aware runtime routing.
 * Handles:
 *   - DOT-encoded prompt construction
 *   - System prompt with language + brevity instructions
 *   - Token budget enforcement
 *   - Streaming and non-streaming output
 */

import Anthropic from '@anthropic-ai/sdk';
import { TokenBudget, countTokensSync } from './tokens.js';
import { buildDotPrompt, compareFormats } from './dot.js';
import {
  getProviderApiKey,
  getProviderDefinition,
  normalizeProviderId,
  resolveProviderId,
} from './providers.js';

const ZAI_BASE_URL_DEFAULT = 'https://api.z.ai/api/paas/v4';

const LANG_NAMES = {
  'zh-CN': '简体中文 (Simplified Chinese)',
  'zh-TW': '繁體中文 (Traditional Chinese)',
  'en':    'English',
  'ar':    'Arabic (العربية)',
  'ja':    'Japanese (日本語)',
  'ko':    'Korean (한국어)',
  'es':    'Spanish (Español)',
  'fr':    'French (Français)',
  'de':    'German (Deutsch)',
  'ru':    'Russian (Русский)',
};

/**
 * Build the system prompt.
 * The system prompt itself is written in DOT format for meta-efficiency.
 */
function buildSystemPrompt(cfg) {
  const lang = cfg.lang || 'zh-CN';
  const langName = LANG_NAMES[lang] || lang;
  const maxOut = cfg.maxTokens || 1024;

  const dotInstructions = [
    `.cfg:lang=zh-CN`,
    `.cfg:output_lang=${langName}`,
    `.cfg:max_response_tokens=${maxOut}`,
    `.cfg:format=concise`,
    `.cfg:style=direct`,
  ].join('');

  const rules = `用 ${langName} 回答。简洁，直接，无废话。代码保持原语言。最多${maxOut}token。`;

  return `${dotInstructions}\n${rules}`;
}

function normalizeUsage(usage) {
  const input = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0);
  return {
    input_tokens: Number.isFinite(input) ? input : 0,
    output_tokens: Number.isFinite(output) ? output : 0,
  };
}

function extractOpenAiContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      return '';
    })
    .join('');
}

function extractOpenAiDeltaText(delta) {
  if (!delta) return '';
  if (typeof delta.content === 'string') return delta.content;
  if (typeof delta.text === 'string') return delta.text;

  if (Array.isArray(delta.content)) {
    return delta.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('');
  }

  return '';
}

async function buildProviderHttpError(response, providerId) {
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }

  let message = body || response.statusText || 'request failed';
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.message || parsed?.message || message;
  } catch {
    // keep fallback message
  }

  const err = new Error(`${providerId} request failed (${response.status}): ${message}`);
  err.status = response.status;
  err.provider = providerId;
  return err;
}

function normalizeClientError(err, providerId = 'anthropic') {
  const status = err?.status;
  const rawType = err?.error?.type || err?.type;
  const msg = String(err?.message || '').toLowerCase();
  const isAuth =
    status === 401 ||
    status === 403 ||
    rawType === 'authentication_error' ||
    msg.includes('authentication_error') ||
    msg.includes('invalid x-api-key') ||
    msg.includes('invalid api key') ||
    msg.includes('invalid_api_key') ||
    msg.includes('unauthorized');

  if (!isAuth) return err;

  if (providerId === 'zai') {
    return new Error(
      [
        'Authentication failed: invalid Z.AI API key.',
        'Fix:',
        '  1) Set key securely in REPL: /key zai',
        '  2) Or persist key: zipai providers --for zai --key <key>',
        '  3) Or set env var (PowerShell): $env:ZAI_API_KEY="<key>"',
      ].join('\n')
    );
  }

  return new Error(
    [
      'Authentication failed: invalid Anthropic API key.',
      'Fix:',
      '  1) Set a valid key: zipai config --set apiKey=sk-ant-...',
      '  2) Or set env var (PowerShell): $env:ANTHROPIC_API_KEY="sk-ant-..."',
      '  3) Verify active config: zipai config',
    ].join('\n')
  );
}

export class AIClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.budget = new TokenBudget(cfg.budget || null);
    this.history = [];
    this._historyChangeHandler = null;

    this.providerId = null;
    this.apiKey = null;
    this.client = null;

    this._ensureRuntimeProvider(true);
  }

  _notifyHistoryChange() {
    if (typeof this._historyChangeHandler === 'function') {
      this._historyChangeHandler(this.history);
    }
  }

  _estimateUsage(messages, systemPrompt, outputText) {
    const inputText = `${systemPrompt}\n${messages.map((m) => m.content || '').join('\n')}`;
    return {
      input_tokens: countTokensSync(inputText),
      output_tokens: countTokensSync(outputText),
    };
  }

  _ensureRuntimeProvider(force = false) {
    const providerId = resolveProviderId(this.cfg);
    if (!force && providerId === this.providerId) {
      return providerId;
    }

    const def = getProviderDefinition(providerId);
    if (!def) {
      throw new Error(`Unknown provider: ${providerId}`);
    }

    const apiKey = getProviderApiKey(this.cfg, providerId);
    if (!apiKey) {
      throw new Error(
        `No API key found for ${providerId}. Set ${def.envKey} or run: zipai providers --for ${providerId} --key <key>`
      );
    }

    this._initializeProvider(providerId, apiKey);
    return providerId;
  }

  _initializeProvider(providerId, apiKey) {
    const def = getProviderDefinition(providerId);
    if (!def) {
      throw new Error(`Unknown provider: ${providerId}`);
    }

    if (providerId === 'anthropic') {
      this.client = new Anthropic({ apiKey });
    } else if (providerId === 'zai') {
      // Z.AI uses a direct HTTP integration path.
      this.client = null;
    } else {
      throw new Error(`provider "${providerId}" is not wired for runtime chat yet`);
    }

    this.providerId = providerId;
    this.apiKey = apiKey;
    this.cfg.provider = providerId;
    this.cfg[def.keyField] = apiKey;

    if (providerId === 'anthropic') {
      this.cfg.apiKey = apiKey;
    }
  }

  async _sendAnthropic({ messages, systemPrompt, requestedOutput }) {
    if (this.cfg.streaming) {
      const stream = this.client.messages.stream({
        model: this.cfg.model,
        max_tokens: requestedOutput,
        system: systemPrompt,
        messages,
        temperature: this.cfg.temperature ?? 0.3,
      });

      let fullText = '';
      for await (const chunk of stream) {
        if (
          chunk.type === 'content_block_delta' &&
          chunk.delta?.type === 'text_delta'
        ) {
          process.stdout.write(chunk.delta.text);
          fullText += chunk.delta.text;
        }
      }

      const final = await stream.finalMessage();
      return {
        fullText,
        usage: normalizeUsage(final?.usage),
      };
    }

    const response = await this.client.messages.create({
      model: this.cfg.model,
      max_tokens: requestedOutput,
      system: systemPrompt,
      messages,
      temperature: this.cfg.temperature ?? 0.3,
    });

    return {
      fullText: response.content.map((b) => b.text || '').join(''),
      usage: normalizeUsage(response.usage),
    };
  }

  async _sendZai({ messages, systemPrompt, requestedOutput }) {
    const baseUrl = String(this.cfg.zaiBaseUrl || process.env.ZAI_BASE_URL || ZAI_BASE_URL_DEFAULT).replace(/\/+$/, '');
    const url = `${baseUrl}/chat/completions`;

    const payload = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      temperature: this.cfg.temperature ?? 0.3,
      max_tokens: requestedOutput,
      stream: Boolean(this.cfg.streaming),
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw await buildProviderHttpError(response, 'zai');
    }

    if (this.cfg.streaming) {
      if (!response.body) {
        throw new Error('zai request failed: empty streaming response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let usage = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let lineBreak = buffer.indexOf('\n');
        while (lineBreak >= 0) {
          const rawLine = buffer.slice(0, lineBreak);
          buffer = buffer.slice(lineBreak + 1);
          const line = rawLine.trim();

          if (!line || !line.startsWith('data:')) {
            lineBreak = buffer.indexOf('\n');
            continue;
          }

          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') {
            lineBreak = buffer.indexOf('\n');
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            const text = extractOpenAiDeltaText(parsed?.choices?.[0]?.delta);
            if (text) {
              process.stdout.write(text);
              fullText += text;
            }
            if (parsed?.usage) {
              usage = normalizeUsage(parsed.usage);
            }
          } catch {
            // Ignore malformed SSE lines.
          }

          lineBreak = buffer.indexOf('\n');
        }
      }

      const trailing = buffer.trim();
      if (trailing.startsWith('data:')) {
        const data = trailing.slice(5).trim();
        if (data && data !== '[DONE]') {
          try {
            const parsed = JSON.parse(data);
            const text = extractOpenAiDeltaText(parsed?.choices?.[0]?.delta);
            if (text) {
              process.stdout.write(text);
              fullText += text;
            }
            if (parsed?.usage) {
              usage = normalizeUsage(parsed.usage);
            }
          } catch {
            // Ignore malformed trailing line.
          }
        }
      }

      return {
        fullText,
        usage: usage || this._estimateUsage(messages, systemPrompt, fullText),
      };
    }

    const json = await response.json();
    const fullText = extractOpenAiContent(json?.choices?.[0]?.message?.content);
    const usage = json?.usage
      ? normalizeUsage(json.usage)
      : this._estimateUsage(messages, systemPrompt, fullText);

    return { fullText, usage };
  }

  /**
   * Send a message. Returns { text, usage, dotPayload }.
   */
  async send(opts) {
    const { dotPayload, estimatedTokens } = buildDotPrompt({
      task: opts.task,
      file: opts.file,
      lang: opts.fileLang,
      line: opts.line,
      content: opts.content,
      error: opts.error,
      context: opts.context,
      question: opts.question || opts.message,
    });

    const userMessage = opts.raw ? opts.message : dotPayload;

    const requestedOutput = Math.min(
      this.cfg.maxTokens || 1024,
      this.budget.safeMaxOutput(this.cfg.maxTokens || 1024)
    );

    if (this.budget.isExhausted) {
      throw new Error(`Token budget exhausted (${this.budget.toString()})`);
    }

    const check = this.budget.canAfford(estimatedTokens, requestedOutput);
    if (!check.ok) {
      throw new Error(check.message);
    }

    const messages = [
      ...this.history,
      { role: 'user', content: userMessage },
    ];

    const systemPrompt = buildSystemPrompt(this.cfg);
    const providerId = this._ensureRuntimeProvider();

    let fullText = '';
    let usage = null;

    try {
      if (providerId === 'anthropic') {
        ({ fullText, usage } = await this._sendAnthropic({
          messages,
          systemPrompt,
          requestedOutput,
        }));
      } else if (providerId === 'zai') {
        ({ fullText, usage } = await this._sendZai({
          messages,
          systemPrompt,
          requestedOutput,
        }));
      } else {
        throw new Error(`provider "${providerId}" is not wired for runtime chat yet`);
      }
    } catch (err) {
      throw normalizeClientError(err, providerId);
    }

    const finalUsage = usage || this._estimateUsage(messages, systemPrompt, fullText);

    this.budget.record(finalUsage.input_tokens, finalUsage.output_tokens);
    this.history.push(
      { role: 'user', content: userMessage },
      { role: 'assistant', content: fullText }
    );
    this._notifyHistoryChange();

    return { text: fullText, usage: finalUsage, dotPayload };
  }

  /**
   * Quick one-shot ask (no history)
   */
  async ask(message, opts = {}) {
    return this.send({ message, raw: true, ...opts });
  }

  clearHistory() {
    this.history = [];
    this._notifyHistoryChange();
  }

  setApiKey(apiKey, providerInput) {
    const key = String(apiKey || '').trim();
    if (!key) {
      throw new Error('API key cannot be empty');
    }

    const providerId = normalizeProviderId(providerInput || this.cfg.provider || this.providerId);
    if (!providerId) {
      throw new Error(`Unknown provider: ${providerInput || this.cfg.provider}`);
    }

    const def = getProviderDefinition(providerId);
    if (!def) {
      throw new Error(`Unknown provider: ${providerId}`);
    }

    this.cfg[def.keyField] = key;
    if (providerId === 'anthropic') {
      this.cfg.apiKey = key;
    }

    if (providerId === resolveProviderId(this.cfg)) {
      this._initializeProvider(providerId, key);
    }
  }

  setHistoryChangeHandler(handler) {
    this._historyChangeHandler = handler;
  }

  get tokenSummary() {
    return this.budget.toString();
  }

  get budgetObject() {
    return this.budget;
  }

  /**
   * Show format comparison for debugging
   */
  compareFormats(data) {
    return compareFormats(data);
  }
}
