# Spec: CLI Commands

Module: `bin/zipai.js`
Dependencies: commander, chalk, ora, all src/ modules

## Global Options

Applied before any subcommand:

| Flag                  | Type   | Default               | Description                     |
|-----------------------|--------|-----------------------|---------------------------------|
| `-k, --api-key <key>` | string | env `ANTHROPIC_API_KEY` | Anthropic API key              |
| `-m, --model <model>` | string | `claude-sonnet-4-20250514` | Model ID                  |
| `-l, --lang <lang>`   | string | `zh-CN`               | Output language                 |
| `-t, --max-tokens <n>` | int   | `1024`                | Max tokens per response         |
| `-b, --budget <n>`    | int    | null (unlimited)      | Session-wide total token budget |
| `--no-stream`         | bool   | false                 | Disable streaming               |
| `--no-tokens`         | bool   | false                 | Hide token usage display        |
| `--temp <n>`          | float  | `0.3`                 | Temperature (0-1)               |

## Commands

### `zipai` / `zipai chat` (default)

Interactive REPL session. See [repl.md](repl.md) for full spec.

**Behavior:**
1. Load config (flags > local > global > env > defaults)
2. Create AIClient with config
3. Print session header (model, lang, max tokens, budget if set)
4. Enter readline loop — see REPL spec

### `zipai ask <message>`

One-shot question. Prints answer and exits.

**Options:**
- `-f, --file <path>` — Attach file as context

**Flow:**
1. Build config, create client
2. If `--file`: read file via `readFileContext()`, attach to send opts
3. If streaming: print tokens as they arrive. If not: show spinner.
4. Print response
5. If `showTokens`: print `↑{input} ↓{output} total: {summary}`
6. Exit 0

**Error cases:**
- File not found -> exit 1 with message + suggestion
- API key missing -> exit 1 with `set ANTHROPIC_API_KEY` hint
- Budget exceeded -> exit 1 with remaining vs requested

### `zipai file <path>`

General file review. Alias for `fileCommand(path, 'review', opts)`.

**Options:**
- `--start <n>` — Start line (1-indexed)
- `--end <n>` — End line

### `zipai fix <path>`

Bug fixing. Alias for `fileCommand(path, 'fix', opts)`.

**Options:**
- `-e, --error <msg>` — Paste error message for context
- `--start <n>`, `--end <n>` — Line range

### `zipai explain <path>`

Explain what code does. Alias for `fileCommand(path, 'explain', opts)`.

**Options:**
- `--start <n>`, `--end <n>` — Line range

### `zipai refactor <path>`

Suggest improvements. Alias for `fileCommand(path, 'refactor', opts)`.

**Options:**
- `--start <n>`, `--end <n>` — Line range

### `zipai dot <message>`

Show how a message would be DOT-encoded. Does not call the API.

**Options:**
- `-f, --file <path>` — Include file in encoding

**Output:**
```
DOT payload:
.t:ask.q:how does quicksort work

Decoded:
  task     : ask
  question : how does quicksort work

estimated tokens: ~10
```

### `zipai bench <message>`

Compare token costs across formats. Does not call the API.

**Options:**
- `-f, --file <path>` — Include file for realistic benchmark (truncated to 500 chars for display)

**Output:**
```
  Token cost comparison

  JSON       52 tokens
  Markdown   18 tokens
  DOT         9 tokens

  DOT saves 83% vs JSON
  DOT saves 50% vs Markdown
```

### `zipai config`

View current config or change a setting.

**Options:**
- `--set <key=value>` — Save a config value
- `--global` — Apply to `~/.zipairc` (default target for `--set`)

**View mode** (no `--set`): prints all config keys with current values and config file locations.

**Set mode**: parses `key=value`, saves to global config file, prints confirmation.

## Shared File Command Flow

`fileCommand(filePath, task, opts)` is the shared handler for `file`, `fix`, `explain`, `refactor`:

1. Build config, create client
2. Read file via `readFileContext(filePath, { startLine, endLine })`
3. Print header: `{task}: {filename} ({lang}, {lines} lines)`
4. Send to AI with `{ task, file, fileLang, content, error }`
5. Stream response
6. Print token usage if enabled
7. If file was truncated: print warning

## Exit Codes

| Code | Meaning                        |
|------|--------------------------------|
| 0    | Success                        |
| 1    | User error (bad args, missing file, no API key, budget exceeded) |
