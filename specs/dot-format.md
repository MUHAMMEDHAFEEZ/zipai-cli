# Spec: DOT Format

Module: `src/dot.js`
Dependencies: none
Status: frozen at v1

## Purpose

DOT is the primary encoding format for all structured context sent to the AI. It eliminates the syntax overhead of JSON (braces, quotes, colons, commas) and Markdown (headers, fences, bold markers), achieving 50-80% token savings.

## Schema (v1 — frozen)

| Key    | Full Name | Type   | Example                          |
|--------|-----------|--------|----------------------------------|
| `.t:`  | task      | string | `fix`, `explain`, `refactor`, `review` |
| `.f:`  | file      | string | `app.js`, `src/utils.py`         |
| `.l:`  | lang      | string | `js`, `py`, `ts`, `rs`, `go`     |
| `.c:`  | content   | string | Code or text (newlines as `↵`)   |
| `.q:`  | question  | string | User's question                  |
| `.e:`  | error     | string | Error message                    |
| `.ctx:` | context  | string | Additional context               |
| `.cfg:` | config   | k=v    | `lang=zh-CN`, `max=1024`         |

Adding a new key requires a version bump and explicit migration path.

## Encoding Rules

1. Each field is prefixed with its key (`.t:`, `.f:`, etc.)
2. Fields are concatenated directly with no separator (the `.` prefix of the next key acts as delimiter)
3. Within content values:
   - Newlines (`\n`) encode as `↵` (U+21B5)
   - Tabs (`\t`) encode as `→` (U+2192)
   - No other escape sequences
4. Empty/undefined fields are omitted entirely
5. `.cfg:` fields use `key=value` format and can appear multiple times

## Encoding Order

Fields are emitted in this fixed order (when present):
`.t:` -> `.l:` -> `.f:` -> `.line:` -> `.c:` -> `.e:` -> `.ctx:` -> `.q:` -> `.cfg:`

This order is not semantically significant but must be stable for testability.

## Examples

Simple question:
```
.t:ask.q:how does quicksort work
```

File fix with error:
```
.t:fix.l:js.f:app.js.c:const x=1↵const y=x()↵.e:TypeError: x is not a function
```

Code explanation with line range:
```
.t:explain.l:py.f:utils.py.line:10-50.c:def merge(a,b):↵→return sorted(a+b)
```

Config payload (system prompt):
```
.cfg:lang=zh-CN.cfg:output_lang=简体中文.cfg:max_response_tokens=1024.cfg:format=concise
```

## Round-Trip Safety

The invariant `decodeDot(encodeDot(obj))` must deep-equal `obj` for all valid inputs. This is a non-negotiable property — any change that breaks it is a bug.

Valid inputs are objects where:
- All values are strings (or string-convertible)
- No value contains the literal sequence `.<lowercase-letter>:` as data (this is the delimiter pattern)

## Exported Functions

### `encodeDot(obj) -> string`

Accepts an object with optional keys: `task`, `file`, `lang`, `line`, `content`, `error`, `context`, `question`, `config`.
Returns a DOT-encoded string. Omits keys whose values are falsy.

### `decodeDot(dotStr) -> object`

Parses a DOT string back into a structured object.
Uses regex: `/\.(\w+):([^.]*(?:\.[^a-z][^.]*)*)/g`

### `buildDotPrompt(opts) -> { dotPayload, estimatedTokens }`

Convenience wrapper. Calls `encodeDot` and returns the payload with a rough token estimate (`Math.ceil(payload.length / 3.5)`).

### `prettyPrintDot(dotStr) -> string`

Human-readable display of a DOT string. For debugging and the `/dot` REPL command.

### `compareFormats(data) -> { json, markdown, dot, savings }`

Encodes the same data as JSON, Markdown, and DOT. Returns all three with estimated token counts and percentage savings. Used by the `bench` CLI command.

## Token Savings Benchmark

For a typical file-fix payload (`task=fix`, `file=app.js`, `lang=js`, 200-char code block, error message):

| Format   | Estimated Tokens | vs DOT |
|----------|-----------------|--------|
| JSON     | ~52             | +80%   |
| Markdown | ~18             | +50%   |
| DOT      | ~9              | baseline |
