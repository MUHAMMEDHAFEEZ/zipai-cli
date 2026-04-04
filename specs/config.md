# Spec: Configuration

Module: `src/config.js`
Dependencies: fs, os, path, dotenv

## Purpose

Load, merge, and persist configuration from multiple sources with a clear priority chain.

## Config Priority (highest to lowest)

1. **CLI flags** — `--lang en`, `--budget 5000`, etc.
2. **Local config** — `.zipai` file in current working directory
3. **Global config** — `~/.zipairc` file in user home directory
4. **Environment variables** — `ANTHROPIC_API_KEY`
5. **Defaults** — hardcoded in module

Higher-priority sources override lower ones on a per-key basis.

## Config Keys

| Key           | Type    | Default               | Description                     |
|---------------|---------|-----------------------|---------------------------------|
| `apiKey`      | string  | env `ANTHROPIC_API_KEY` | Anthropic API key              |
| `model`       | string  | `claude-sonnet-4-20250514` | Model identifier           |
| `maxTokens`   | int     | `1024`                | Max output tokens per response  |
| `budget`      | int/null | `null`               | Session token budget (null = unlimited) |
| `lang`        | string  | `zh-CN`               | Output language code            |
| `format`      | string  | `dot`                 | Input encoding format           |
| `streaming`   | bool    | `true`                | Stream API responses            |
| `showTokens`  | bool    | `true`                | Show token usage after responses |
| `temperature` | float   | `0.3`                 | Model temperature               |

## File Format

Config files use simple `key=value` format, one per line:

```
# zipai config
lang=zh-CN
maxTokens=1024
model=claude-sonnet-4-20250514
streaming=true
showTokens=true
temperature=0.3
```

- Lines starting with `#` are comments
- Empty lines are ignored
- Values are auto-parsed: `true`/`false` -> boolean, `null` -> null, numeric strings -> number, everything else -> string

## File Locations

- **Global**: `~/.zipairc` (cross-project defaults)
- **Local**: `.zipai` (in current working directory, project-specific overrides)

## Exported Functions

### `loadConfig(cliOverrides = {}) -> object`

1. Load `.env` file if present (via dotenv)
2. Parse global config (`~/.zipairc`)
3. Parse local config (`./.zipai`)
4. Spread-merge: `{ ...DEFAULTS, ...global, ...local, ...cliOverrides }`
5. If no `apiKey` in merged result, check `process.env.ANTHROPIC_API_KEY`
6. Return merged config object

### `saveGlobalConfig(updates) -> void`

1. Read existing `~/.zipairc` (or empty object)
2. Merge with `updates`
3. Write back as `key=value` lines with `# zipai global config` header

### `saveLocalConfig(updates) -> void`

Same as `saveGlobalConfig` but targets `./.zipai`.

### `DEFAULTS` (named export)

The hardcoded defaults object, exported for testing.

## Zero-Setup Requirement

The only thing a user must provide to start using zipai is `ANTHROPIC_API_KEY`. Everything else has sensible defaults. The CLI must never fail because a config file is missing.
