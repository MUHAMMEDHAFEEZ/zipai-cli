# aicli — Token-Efficient AI CLI

A CLI tool like opencode, but built around **DOT format** for maximum token efficiency.

## Why DOT format?

| Format   | Tokens (example) | vs DOT     |
|----------|-----------------|------------|
| JSON     | ~52             | −80%       |
| Markdown | ~18             | −50%       |
| **DOT**  | **~9**          | baseline   |

DOT encodes structured context in a compact key-value notation:
```
.t:fix.f:app.js.l:js.c:const x=1↵const y=2.e:TypeError:x is not a fn
```
Instead of:
```json
{"task":"fix","file":"app.js","lang":"js","content":"const x=1\nconst y=2","error":"TypeError: x is not a fn"}
```

---

## Install

```bash
cd aicli
npm install
npm link        # makes `aicli` available globally
```

Set your API key:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or
aicli config --set apiKey=sk-ant-...
```

---

## Usage

### Interactive chat (REPL)
```bash
aicli
aicli chat
```

### One-shot question
```bash
aicli ask "how does quicksort work"
aicli ask "explain this" --file src/app.js
```

### Code commands
```bash
aicli file src/app.js          # general review
aicli explain src/app.js       # explain what it does
aicli fix src/app.js           # fix bugs
aicli fix src/app.js -e "TypeError: x is not a function"
aicli refactor src/app.js      # improve code quality

# Focus on specific lines
aicli explain src/app.js --start 10 --end 50
```

### Token control
```bash
# Limit tokens per response
aicli ask "explain this" --max-tokens 256

# Set a total session budget (won't exceed this across all requests)
aicli --budget 5000 chat

# One-shot with budget
aicli --budget 2000 ask "explain quicksort"
```

### Language control
```bash
# Default is Simplified Chinese (zh-CN) — fewest tokens for most content
aicli ask "explain this"            # answers in 简体中文

# Switch to English
aicli --lang en ask "explain this"

# Switch language mid-session (in REPL)
/lang en
/lang zh-CN
/lang ja
```

### DOT format tools
```bash
# See how your message is encoded in DOT format
aicli dot "fix the bug in my login function" --file src/auth.js

# Compare token costs between formats
aicli bench "explain this code" --file src/app.js
```

### Config
```bash
aicli config                        # show current config
aicli config --set lang=en          # change default language
aicli config --set maxTokens=512    # change default response limit
aicli config --set budget=10000     # set default session budget
```

---

## Config file

`~/.aiclirc` (global) or `.aicli` (per-project):
```
lang=zh-CN
maxTokens=1024
budget=null
model=claude-sonnet-4-20250514
showTokens=true
streaming=true
temperature=0.3
```

---

## REPL commands

| Command | Description |
|---------|-------------|
| `/exit` | Exit |
| `/clear` | Clear conversation history |
| `/tokens` | Show token usage |
| `/budget` | Show remaining budget with progress bar |
| `/file <path>` | Attach file to next message |
| `/lang <code>` | Switch language (en, zh-CN, ja, ar…) |
| `/max <n>` | Change max output tokens |
| `/dot` | Show last message's DOT encoding |
| `/cmp <msg>` | Compare DOT vs JSON vs Markdown tokens |
| `/help` | Show all commands |

---

## Token savings explained

DOT format strips all syntax overhead:
- No JSON braces, quotes, colons, commas
- No Markdown `##`, triple backticks, `**bold**`
- Newlines become `↵` (1 char), tabs become `→`
- Short keys: `.f:` (file), `.l:` (lang), `.c:` (content), `.q:` (question)

The output language (Simplified Chinese by default) also saves tokens because Chinese characters pack more meaning per token than English words in most LLM tokenizers.

---

## Examples

```bash
# Fix a bug with error context, budget of 1000 tokens, answer in English
aicli --lang en --budget 1000 fix src/server.js -e "ECONNREFUSED 127.0.0.1:5432"

# Quick explain, max 200 tokens
aicli --max-tokens 200 explain src/utils.js

# See DOT encoding vs other formats
aicli bench "what does this code do" --file src/app.js
```
