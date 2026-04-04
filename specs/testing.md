# Spec: Testing Strategy

Framework: `node:test` + `node:assert` (Node.js built-in)
Runner: `node --test test/*.test.js`

## Principles

- Every utility function in `src/` must have a corresponding test
- Tests must not require a real API key — mock the Anthropic client
- Critical paths (DOT, tokens, config) require 100% coverage
- Tests must be fast — no network calls, no filesystem side effects outside tmp dirs

## Test File Structure

```
test/
  dot.test.js          DOT encoding/decoding
  tokens.test.js       Token counting + budget enforcement
  config.test.js       Config loading + merge priority
  files.test.js        File reading + truncation + language detection
```

Each test file mirrors its source module.

## Critical Path: DOT (test/dot.test.js)

### Round-trip safety
- `decodeDot(encodeDot(obj))` deep-equals `obj` for:
  - All single-field objects (one key at a time)
  - Multi-field objects (all keys populated)
  - Objects with newlines and tabs in content
  - Empty string values (should be omitted)
  - Objects with only `.cfg:` keys

### encodeDot
- Omits falsy keys
- Escapes newlines as `↵` and tabs as `→`
- Produces fields in canonical order
- Handles `.cfg:` with multiple key=value pairs

### decodeDot
- Parses all known keys
- Handles content containing `.` characters that are not key prefixes
- Returns empty object for empty string input
- Ignores unknown keys gracefully

### buildDotPrompt
- Returns `{ dotPayload, estimatedTokens }`
- `estimatedTokens` is `Math.ceil(payload.length / 3.5)`

### compareFormats
- DOT tokens < Markdown tokens < JSON tokens for same input
- Savings percentages are correct arithmetic

## Critical Path: Tokens (test/tokens.test.js)

### countTokensSync
- Returns `Math.ceil(text.length / 3.5)` for any string
- Returns 1 for empty string
- Handles very long strings without crashing

### TokenBudget — unlimited
- `new TokenBudget(null)` has `remaining = Infinity`, `isExhausted = false`
- `canAfford()` always returns `{ ok: true }`
- `safeMaxOutput(n)` returns `n` unchanged

### TokenBudget — limited
- `new TokenBudget(1000)` tracks usage correctly
- `record(300, 200)` -> `total = 500`, `remaining = 500`
- `canAfford(300, 300)` -> `{ ok: true }` when 600 remaining
- `canAfford(300, 400)` -> `{ ok: false, message: ... }` when 600 remaining
- `isExhausted` returns true when `total >= max`
- `safeMaxOutput(1024)` never exceeds `remaining - 200`
- `safeMaxOutput()` returns at least 50
- `toString()` includes percentage when budget is set
- `summary()` returns correct structure

## Critical Path: Config (test/config.test.js)

### loadConfig
- Returns defaults when no config files exist
- CLI overrides take highest priority
- Local config overrides global config
- API key falls back to env var
- `parseValue` converts: `"true"` -> `true`, `"false"` -> `false`, `"null"` -> `null`, `"42"` -> `42`, `"hello"` -> `"hello"`

### Config file parsing
- Ignores empty lines and comments (`#`)
- Handles `key=value` with `=` in value (e.g., `apiKey=sk-ant-abc=123`)
- Handles missing files without throwing

### saveGlobalConfig / saveLocalConfig
- Merges with existing config
- Writes valid key=value format
- Includes header comment

## File Reading (test/files.test.js)

### readFileContext
- Returns correct structure for a valid file
- Detects language from extension
- Throws on missing file with path in message
- Throws on directory
- Truncates files exceeding MAX_FILE_CHARS
- Extracts correct line range with startLine/endLine
- Sets `truncated: true` when file is truncated

### detectLang
- Detects JS, Python, Rust, Go, PHP from code content
- Returns `txt` for unknown content

### trimToTokenBudget
- Returns content unchanged if it fits
- Preserves start and end, cuts middle
- Includes `[truncated]` marker

## Mocking Strategy

### Anthropic Client
Tests that involve `AIClient` must mock `@anthropic-ai/sdk`:

```javascript
// Mock the Anthropic SDK
const mockCreate = mock.fn(() => ({
  content: [{ text: 'response' }],
  usage: { input_tokens: 10, output_tokens: 20 }
}));

const mockClient = { messages: { create: mockCreate, stream: mockStream } };
```

### Filesystem
Config tests should use temp directories. File tests should create temp files with known content.

### Environment
Tests that check env var fallback should save/restore `process.env` values.

## Running Tests

```bash
node --test test/*.test.js
```

No external test framework. No coverage tool required (but `c8` can be used optionally: `npx c8 node --test test/*.test.js`).
