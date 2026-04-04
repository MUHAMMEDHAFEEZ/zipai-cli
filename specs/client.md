# Spec: AI Client

Module: `src/client.js`
Dependencies: @anthropic-ai/sdk, src/tokens.js, src/dot.js

## Purpose

Wraps the Anthropic SDK. Handles DOT-encoded prompt construction, system prompt generation, token budget enforcement, conversation history, and streaming output. This is the only module that imports `@anthropic-ai/sdk`.

## AIClient Class

### Constructor

```javascript
new AIClient(cfg)
```

- `cfg` must contain `apiKey` — throws actionable error if missing
- Creates Anthropic SDK client
- Creates TokenBudget from `cfg.budget`
- Initializes empty conversation history

### `send(opts) -> Promise<{ text, usage, dotPayload }>`

Primary method. Sends a message to the AI and returns the response.

**Parameters (opts):**

| Key        | Type   | Required | Description                    |
|------------|--------|----------|--------------------------------|
| `task`     | string | no       | fix, explain, refactor, review |
| `file`     | string | no       | Filename                       |
| `fileLang` | string | no       | Language code                  |
| `line`     | string | no       | Line number/range              |
| `content`  | string | no       | File content                   |
| `error`    | string | no       | Error message                  |
| `context`  | string | no       | Extra context                  |
| `question` | string | no       | User's question                |
| `message`  | string | no       | Raw message (chat mode)        |
| `raw`      | bool   | no       | If true, send message as-is (skip DOT) |

**Flow:**

1. Call `buildDotPrompt(opts)` to get `{ dotPayload, estimatedTokens }`
2. Determine user message: if `opts.raw`, use `opts.message`; otherwise use `dotPayload`
3. Compute `requestedOutput = min(cfg.maxTokens, budget.safeMaxOutput(cfg.maxTokens))`
4. Check `budget.isExhausted` — throw if true
5. Check `budget.canAfford(estimatedTokens, requestedOutput)` — throw if not ok
6. Build messages array: `[...this.history, { role: 'user', content: userMessage }]`
7. Build system prompt via `buildSystemPrompt(cfg)`
8. Call Anthropic API (streaming or non-streaming)
9. Record actual token usage: `budget.record(usage.input_tokens, usage.output_tokens)`
10. Append user + assistant messages to history
11. Return `{ text, usage, dotPayload }`

### `ask(message, opts) -> Promise<{ text, usage, dotPayload }>`

Convenience one-shot. Calls `send({ message, raw: true, ...opts })`.

### `clearHistory() -> void`

Empties conversation history. Used by REPL `/clear` command.

### `tokenSummary` (getter)

Returns `budget.toString()`.

### `budgetObject` (getter)

Returns the TokenBudget instance directly. Used by REPL for progress bar display.

### `compareFormats(data)`

Passthrough to `dot.compareFormats()`. For debugging.

## System Prompt

Built by internal `buildSystemPrompt(cfg)`:

```
.cfg:lang=zh-CN.cfg:output_lang=简体中文 (Simplified Chinese).cfg:max_response_tokens=1024.cfg:format=concise.cfg:style=direct
用简体中文回答。简洁，直接，无废话。代码保持原语言。最多1024token。
```

The system prompt is itself DOT-encoded (meta-efficiency). The human-readable rules portion switches language based on `cfg.lang`:
- `zh-CN`: Chinese rules
- All others: English rules with the language name substituted

## Streaming Behavior

When `cfg.streaming` is true (default):

1. Use `client.messages.stream()` — returns an async iterable
2. For each `content_block_delta` with `text_delta`, write directly to `process.stdout`
3. After stream completes, call `stream.finalMessage()` for usage stats
4. Accumulate full text for history

When streaming is false:

1. Use `client.messages.create()` — returns complete response
2. Extract text from `response.content` blocks
3. Print full text at once

## Supported Languages

| Code   | Display Name                     |
|--------|----------------------------------|
| `zh-CN` | 简体中文 (Simplified Chinese)    |
| `zh-TW` | 繁體中文 (Traditional Chinese)   |
| `en`    | English                          |
| `ar`    | Arabic (العربية)                 |
| `ja`    | Japanese (日本語)                |
| `ko`    | Korean (한국어)                  |
| `es`    | Spanish (Español)                |
| `fr`    | French (Français)                |
| `de`    | German (Deutsch)                 |
| `ru`    | Russian (Русский)                |

Unknown codes are passed through as-is to the system prompt.
