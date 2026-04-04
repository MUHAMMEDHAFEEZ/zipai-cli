# zipai

Token-efficient AI CLI tool using DOT format encoding. Node.js (pure ESM).

## Quick Reference

- **Specs:** `specs/` directory — read before implementing any module
- **Constitution:** `CONSTITUTION.md` — inviolable project principles
- **Prototype code:** `PLAN/` directory — reference implementation (uses old name `aicli`)

## Commands

```bash
node --test test/*.test.js     # run all tests
node bin/zipai.js              # run CLI
```

## Architecture

```
bin/zipai.js     CLI entry (only default export)
src/dot.js       DOT encode/decode (zero deps — build this first)
src/tokens.js    Token counting + budget (lazy tiktoken)
src/config.js    Config loading (flags > .zipai > ~/.zipairc > env > defaults)
src/client.js    Anthropic API (only module importing SDK)
src/files.js     File reading + truncation
src/repl.js      Interactive REPL
```

## Key Rules

1. All modules are pure ESM with named exports
2. DOT schema is frozen — `.t .f .l .c .q .e .ctx .cfg` — new keys need version bump
3. `decodeDot(encodeDot(obj))` must always round-trip
4. Never send a prompt without DOT encoding
5. Token budget enforcement is mandatory — refuse, don't exceed
6. Tests use `node:test` only — no external frameworks, no real API keys
7. Default output language is `zh-CN`
8. Streaming is the default for all API responses
9. Cold start must be under 300ms — lazy-load tiktoken
