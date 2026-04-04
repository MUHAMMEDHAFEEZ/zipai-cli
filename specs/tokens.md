# Spec: Token Counting & Budget

Module: `src/tokens.js`
Dependencies: tiktoken (lazy-loaded, optional)

## Purpose

Provide token counting (exact or heuristic) and enforce session-wide token budgets. Budget enforcement is non-optional — the CLI must refuse requests that would exceed the remaining budget.

## Token Counting

### `countTokens(text) -> Promise<number>`

Async. Attempts tiktoken's `cl100k_base` encoder for exact counts. Falls back to heuristic if tiktoken is unavailable or throws.

### `countTokensSync(text) -> number`

Sync. Always uses the heuristic. For fast UI feedback (spinners, budget checks before API calls).

### Heuristic

```
Math.ceil(text.length / 3.5)
```

Ratio of ~3.5 characters per token is calibrated for mixed code/prose content typical of developer CLI usage.

### Tiktoken Lazy Loading

```javascript
let encoder = null;

async function getEncoder() {
  if (encoder) return encoder;
  try {
    const { get_encoding } = await import('tiktoken');
    encoder = get_encoding('cl100k_base');
  } catch {
    encoder = null;
  }
  return encoder;
}
```

- tiktoken is only imported when `countTokens()` is first called
- If the import fails (not installed, WASM issue), silently falls back to heuristic
- The encoder is cached after first successful load
- This keeps cold start fast — tiktoken is heavy (~4MB WASM)

## TokenBudget Class

Tracks cumulative token usage across a session and enforces limits.

### Constructor

```javascript
new TokenBudget(maxTokens)  // number or null
```

- `null` means unlimited (no enforcement)
- Any positive integer sets a hard cap on total tokens (input + output combined)

### Properties

| Property      | Type    | Description                          |
|---------------|---------|--------------------------------------|
| `.max`        | int/null | Budget limit                        |
| `.usedInput`  | int     | Cumulative input tokens              |
| `.usedOutput` | int     | Cumulative output tokens             |
| `.calls`      | int     | Number of API calls made             |
| `.total`      | int     | `usedInput + usedOutput`             |
| `.remaining`  | int/Inf | `max - total` (Infinity if no budget) |
| `.isExhausted` | bool   | `total >= max` (false if no budget)  |

### Methods

#### `canAfford(inputEstimate, requestedMaxOutput) -> { ok, message? }`

Pre-flight check before sending a request.

- If `max` is null: always returns `{ ok: true }`
- Otherwise: checks if `inputEstimate + requestedMaxOutput <= remaining`
- On failure returns: `{ ok: false, message: "Token budget exceeded. Need ~{needed}, have {remaining} remaining ({total}/{max} used)." }`

#### `safeMaxOutput(requested) -> number`

Compute the safe `max_tokens` parameter for an API call. Never exceeds remaining budget minus a 200-token safety margin. Returns at least 50 (minimum useful response).

```javascript
safeMaxOutput(requested) {
  if (this.max === null) return requested;
  const headroom = this.remaining - 200;
  return Math.max(50, Math.min(requested, headroom));
}
```

#### `record(inputTokens, outputTokens) -> void`

Called after each API response with actual token counts from the API's `usage` field. Increments `usedInput`, `usedOutput`, and `calls`.

#### `summary() -> object`

Returns `{ calls, input, output, total, max, pct }` where `pct` is percentage used (null if no budget).

#### `toString() -> string`

Human-readable summary:
- With budget: `tokens: 1200/5000 (24%) — in:800 out:400 calls:3`
- Without: `tokens: 1200 total — in:800 out:400 calls:3`

## Budget Enforcement Flow

1. `client.send()` calls `buildDotPrompt()` to get estimated input tokens
2. `budget.canAfford(estimated, maxOutput)` — if `{ ok: false }`, throw with message
3. `budget.safeMaxOutput(cfg.maxTokens)` — cap the `max_tokens` API parameter
4. After response: `budget.record(usage.input_tokens, usage.output_tokens)`
5. If `budget.isExhausted` on next call: throw immediately

Budget is checked BEFORE the API call, never after. The user sees why the request was refused and how much budget remains.
