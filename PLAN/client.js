/**
 * AI client — wraps Anthropic SDK.
 * Handles:
 *   - DOT-encoded prompt construction
 *   - System prompt with language + brevity instructions
 *   - Token budget enforcement
 *   - Streaming output
 */

import Anthropic from '@anthropic-ai/sdk';
import { TokenBudget, countTokensSync } from './tokens.js';
import { buildDotPrompt, compareFormats } from './dot.js';

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
  const lang     = cfg.lang || 'zh-CN';
  const langName = LANG_NAMES[lang] || lang;
  const maxOut   = cfg.maxTokens || 1024;

  // DOT-encoded system instructions — shorter than prose
  const dotInstructions = [
    `.cfg:lang=${lang}`,
    `.cfg:output_lang=${langName}`,
    `.cfg:max_response_tokens=${maxOut}`,
    `.cfg:format=concise`,
    `.cfg:style=direct`,
  ].join('');

  // Human-readable rules (kept ultra-short)
  const rules = lang === 'zh-CN'
    ? `用简体中文回答。简洁，直接，无废话。代码保持原语言。最多${maxOut}token。`
    : `Reply in ${langName}. Be concise and direct. Code stays in original language. Max ${maxOut} tokens.`;

  return `${dotInstructions}\n${rules}`;
}

export class AIClient {
  constructor(cfg) {
    if (!cfg.apiKey) {
      throw new Error(
        'No API key found. Set ANTHROPIC_API_KEY in your environment or run: aicli config --set apiKey=<key>'
      );
    }
    this.cfg    = cfg;
    this.client = new Anthropic({ apiKey: cfg.apiKey });
    this.budget = new TokenBudget(cfg.budget || null);
    this.history = [];  // conversation history
  }

  /**
   * Send a message. Returns { text, usage, dotPayload }.
   * Supports streaming (prints to stdout as it arrives).
   */
  async send(opts) {
    const { dotPayload, estimatedTokens } = buildDotPrompt({
      task:     opts.task,
      file:     opts.file,
      lang:     opts.fileLang,
      line:     opts.line,
      content:  opts.content,
      error:    opts.error,
      context:  opts.context,
      question: opts.question || opts.message,
    });

    // For plain text messages (chat mode), use the message directly
    const userMessage = opts.raw ? opts.message : dotPayload;

    // Enforce budget
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

    // Build messages array with history
    const messages = [
      ...this.history,
      { role: 'user', content: userMessage }
    ];

    const systemPrompt = buildSystemPrompt(this.cfg);

    let fullText = '';

    if (this.cfg.streaming) {
      // Streaming mode
      const stream = this.client.messages.stream({
        model:      this.cfg.model,
        max_tokens: requestedOutput,
        system:     systemPrompt,
        messages,
        temperature: this.cfg.temperature ?? 0.3,
      });

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
      const usage = final.usage;

      this.budget.record(usage.input_tokens, usage.output_tokens);
      this.history.push(
        { role: 'user',      content: userMessage },
        { role: 'assistant', content: fullText }
      );

      return { text: fullText, usage, dotPayload };

    } else {
      // Non-streaming mode
      const response = await this.client.messages.create({
        model:      this.cfg.model,
        max_tokens: requestedOutput,
        system:     systemPrompt,
        messages,
        temperature: this.cfg.temperature ?? 0.3,
      });

      fullText = response.content.map(b => b.text || '').join('');
      const usage = response.usage;

      this.budget.record(usage.input_tokens, usage.output_tokens);
      this.history.push(
        { role: 'user',      content: userMessage },
        { role: 'assistant', content: fullText }
      );

      return { text: fullText, usage, dotPayload };
    }
  }

  /**
   * Quick one-shot ask (no history)
   */
  async ask(message, opts = {}) {
    return this.send({ message, raw: true, ...opts });
  }

  clearHistory() {
    this.history = [];
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
