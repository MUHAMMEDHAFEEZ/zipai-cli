# zipai — Project Overview

## What It Is

zipai is a command-line AI assistant that communicates with Claude using DOT format — a compact key-value encoding that uses 50-80% fewer tokens than JSON or Markdown. Designed for developers who want fast, cheap, repeatable AI interactions from the terminal.

## What It Is NOT

- Not a code editor or IDE plugin
- Not a code executor or sandbox
- Not a multi-agent orchestrator
- Not a GUI tool

## Core Value Proposition

Every byte counts. DOT format encodes structured context (file, language, content, task) into a compact string that costs a fraction of the equivalent JSON or Markdown. Combined with Simplified Chinese as the default output language (higher meaning-per-token ratio), zipai minimizes API spend per interaction.

## Technology Stack

| Layer        | Choice                           | Rationale                        |
|--------------|----------------------------------|----------------------------------|
| Runtime      | Node.js >= 20                    | ESM native, built-in test runner |
| Language     | JavaScript (pure ESM)            | Zero build step, fast startup    |
| AI Provider  | Anthropic (Claude)               | Best code reasoning at cost      |
| CLI Parser   | commander                        | Mature, zero-config, tree-shaken |
| Terminal UI  | chalk + ora                      | Color + spinners, lightweight    |
| Token Count  | tiktoken (lazy-loaded)           | Accurate counts, optional dep    |
| Config       | Custom key=value parser          | No YAML/TOML dep needed          |

## Module Map

```
zipai/
  bin/
    zipai.js            CLI entry point (only default export in project)
  src/
    dot.js              DOT encode/decode — zero runtime dependencies
    tokens.js           Token counting + budget enforcement
    config.js           Config loading (CLI flags > .zipai > ~/.zipairc > env > defaults)
    client.js           Anthropic API wrapper — streaming-first
    files.js            File reading with language detection + truncation
    repl.js             Interactive REPL with slash commands
  test/
    dot.test.js         DOT encode/decode round-trip tests
    tokens.test.js      Token counting + budget tests
    config.test.js      Config loading + merge priority tests
    files.test.js       File reading + truncation tests
  package.json
  CONSTITUTION.md       Inviolable project principles
  specs/                This directory — specification documents
```

## Dependency Graph

```
bin/zipai.js
  -> src/config.js      (fs, os, path, dotenv)
  -> src/client.js      (@anthropic-ai/sdk, src/tokens.js, src/dot.js)
  -> src/repl.js        (readline, src/tokens.js, src/files.js, src/dot.js)
  -> src/files.js       (fs, path)
  -> src/dot.js         (no dependencies)
```

Rules:
- `src/dot.js` has zero runtime dependencies — it is the foundation
- `src/client.js` is the only module that imports `@anthropic-ai/sdk`
- No circular dependencies between modules
