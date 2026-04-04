# Spec: Interactive REPL

Module: `src/repl.js`
Dependencies: readline (Node built-in), chalk, src/tokens.js, src/files.js, src/dot.js

## Purpose

The REPL provides a multi-turn conversational interface with the AI. It maintains conversation history, supports file attachment, and exposes slash commands for session control.

## Session Startup

On entry, print:
```
  zipai — token-efficient AI CLI
  model: claude-sonnet-4-20250514  |  lang: zh-CN  |  max: 1024 tok/reply
  budget: 5000 tokens total          (only if budget is set)
  type /help for commands, /exit to quit
```

Prompt format: `you › ` (cyan "you", gray " › ")

## Message Flow

1. User types a message (non-slash, non-empty)
2. If a file is pending (from `/file`), attach it to send opts, then clear pending file
3. Print blank line, then `ai › ` prefix
4. Send message via `client.send()` — streams response to stdout
5. After response completes, print token usage:
   ```
   ↑{input}tok ↓{output}tok budget:{remaining}rem
   ```
   (budget portion only shown when budget is set)
6. Store the DOT payload as `lastDot` for `/dot` command
7. Re-display prompt

## Slash Commands

| Command           | Action                                              |
|-------------------|-----------------------------------------------------|
| `/exit`, `/quit`  | Print final token summary, exit process              |
| `/clear`          | Clear conversation history via `client.clearHistory()` |
| `/tokens`         | Print current token summary                          |
| `/budget`         | Print budget progress bar + numbers                  |
| `/file <path>`    | Read file, store as pending attachment                |
| `/lang <code>`    | Change `cfg.lang` for this session                   |
| `/max <n>`        | Change `cfg.maxTokens` for this session              |
| `/dot`            | Print last message's DOT payload + decoded view      |
| `/cmp <msg>`      | Compare DOT vs JSON vs Markdown token costs          |
| `/help`           | Print command table                                  |

Unknown commands print: `unknown command: {cmd}  (try /help)`

## Budget Progress Bar

When `/budget` is used and a budget is set:
```
  budget: ████████████░░░░░░░░░░░░░░░░░░ 1200/5000 (24%)
```

Bar is 30 characters wide. Color thresholds:
- Green: 0-50% used
- Yellow: 50-80% used
- Red: 80-100% used

When no budget is set: `no budget set — unlimited`

## File Attachment

`/file <path>` reads the file via `readFileContext()` and stores it as `pendingFile`. On the next user message, the file's content is included in the DOT payload and `pendingFile` is cleared.

Success: `attached: {filename} ({lang}, {lines} lines)`
Failure: print error message from `readFileContext()`

## Session End

On `/exit`, `/quit`, or EOF (Ctrl+D):
1. Print final token summary
2. Print `bye!`
3. `process.exit(0)`

## Error Handling

API errors during send:
- Print `error: {message}` in red
- Do NOT exit — return to prompt (the session continues)

This is different from one-shot commands which exit on error.
