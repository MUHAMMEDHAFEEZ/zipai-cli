# zipai Constitution

Project: **zipai** — a token-efficient AI CLI tool
Language: Node.js (ESM)
Runtime: Node.js >= 20

---

## 1. Code Quality

- All modules must be pure ESM with named exports.
- No default exports except the CLI entry point (`bin/zipai.js`).
- Functions must be small, single-purpose, and testable in isolation.
- No magic strings — all constants must be defined at the top of their module.
- Error messages must be human-readable and actionable (suggest a fix, not just describe the problem).
- Imports must be explicit — no barrel files re-exporting everything from `src/index.js`.

## 2. Testing Standards

- Every utility function in `src/` must have a corresponding unit test.
- Critical paths require 100% test coverage:
  - Token counting (`src/tokens.js`)
  - DOT encoding and decoding (`src/dot.js`)
  - Config loading (`src/config.js`)
- Tests must not require a real API key — mock the Anthropic client.
- Use Node.js built-in test runner (`node:test`) with `node:assert` — no external test frameworks.
- Test files live in `test/` and mirror the `src/` structure (e.g., `test/dot.test.js` tests `src/dot.js`).

## 3. DOT Format

- DOT encoding is the primary and default input format — never fall back to JSON or Markdown silently.
- The DOT schema is frozen at v1:

  | Key    | Meaning         |
  |--------|-----------------|
  | `.f:`  | file name       |
  | `.l:`  | language        |
  | `.c:`  | content         |
  | `.q:`  | question        |
  | `.e:`  | error message   |
  | `.t:`  | task type       |
  | `.ctx:`| extra context   |
  | `.cfg:`| config key=val  |

- New keys require a version bump and explicit migration path.
- Encoding and decoding must be perfectly invertible (round-trip safe): `decodeDot(encodeDot(obj))` must deep-equal `obj` for all valid inputs.
- Newlines encode as `↵`, tabs as `→` — no other escape sequences.

## 4. Token Efficiency

- Every prompt sent to the API must go through DOT encoding.
- The system prompt must itself be written compactly — no verbose prose, no filler words.
- Default output language is Simplified Chinese (`zh-CN`) to maximize meaning-per-token ratio.
- Token budget enforcement is non-optional — the CLI must refuse requests that would exceed the budget with a clear message showing (requested vs. remaining).

## 5. User Experience

- All CLI commands must provide instant feedback (spinner or first output within 200ms).
- Token usage must always be shown after each response unless `--no-tokens` is passed.
- Error messages must suggest a fix, not just describe the problem:
  - Bad: `"API key not found"`
  - Good: `"API key not found. Set ANTHROPIC_API_KEY or run: zipai config --set apiKey=sk-ant-..."`
- Config must work with zero setup beyond setting `ANTHROPIC_API_KEY`.
- Config file locations: `~/.zipairc` (global), `.zipai` (per-project, overrides global).

## 6. Performance

- Cold start must be under 300ms — avoid heavy imports at the top level.
- Lazy-load `tiktoken` only when token counting is actually needed.
- File reading must truncate gracefully at configurable limits — never crash on large files.
- Streaming must be the default for all API responses.
- Dependencies must be minimal — prefer Node.js built-ins over npm packages where practical.

## 7. Architecture Boundaries

```
bin/zipai.js        CLI entry point (only default export)
src/dot.js          DOT encode/decode (zero dependencies)
src/tokens.js       Token counting (lazy tiktoken)
src/config.js       Config loading (~/.zipairc, .zipai)
src/client.js       Anthropic API wrapper (streaming-first)
src/files.js        File reading with truncation
src/repl.js         Interactive REPL session
```

- `src/dot.js` must have zero runtime dependencies — it is the foundation.
- `src/client.js` is the only module that imports `@anthropic-ai/sdk`.
- No circular dependencies between modules.

## 8. Non-Negotiable Rules

1. Never send a prompt without DOT encoding it first.
2. Never exceed the token budget — refuse the request instead.
3. Never swallow errors silently — log and surface them.
4. Never add a dependency without justifying it against a built-in alternative.
5. Never break DOT round-trip safety.
