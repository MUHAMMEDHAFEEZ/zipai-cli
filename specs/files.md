# Spec: File Reading

Module: `src/files.js`
Dependencies: fs, path (Node built-ins)

## Purpose

Read source files from disk, detect their language, truncate gracefully if too large, and return structured context ready for DOT encoding.

## readFileContext(filePath, opts?) -> object

Primary function. Reads a file and returns metadata + content.

**Parameters:**
- `filePath` — path to file (relative or absolute)
- `opts.startLine` — start line (1-indexed, optional)
- `opts.endLine` — end line (optional)

**Return value:**

```javascript
{
  file:      'app.js',           // basename only
  filePath:  'src/app.js',       // original path as passed
  lang:      'js',               // detected language code
  content:   'const x = 1\n...', // file content (may be truncated)
  truncated: false,              // true if file exceeded MAX_FILE_CHARS
  lines:     42,                 // line count of returned content
  chars:     1200,               // char count of returned content
}
```

**Flow:**

1. Check `existsSync(filePath)` — throw `"File not found: {path}"` if missing
2. Check `statSync(filePath).isFile()` — throw `"Not a file: {path}"` if directory
3. Detect language from extension via `LANG_MAP`
4. Read file as UTF-8
5. If content exceeds `MAX_FILE_CHARS` (8000): truncate to first 8000 chars, set `truncated = true`
6. If `startLine` or `endLine` specified: extract line range (1-indexed, inclusive)
7. Return structured object

**Truncation order matters:** truncation happens before line extraction. This means if a file is very large, line ranges near the end may be unavailable after truncation. This is by design — we cap memory first.

## Constants

```javascript
const MAX_FILE_CHARS = 8000;  // ~2300 tokens
```

## Language Detection

### By extension (LANG_MAP)

| Extensions                        | Code    |
|-----------------------------------|---------|
| `.js`, `.mjs`, `.cjs`            | `js`    |
| `.ts`                             | `ts`    |
| `.tsx`                            | `tsx`   |
| `.jsx`                            | `jsx`   |
| `.py`, `.pyw`                     | `py`    |
| `.rs`                             | `rs`    |
| `.go`                             | `go`    |
| `.java`                           | `java`  |
| `.c`, `.h`                        | `c`     |
| `.cpp`, `.cc`, `.cxx`            | `cpp`   |
| `.cs`                             | `cs`    |
| `.rb`                             | `rb`    |
| `.php`                            | `php`   |
| `.swift`                          | `swift` |
| `.kt`                             | `kt`    |
| `.sh`, `.bash`, `.zsh`           | `sh`    |
| `.sql`                            | `sql`   |
| `.html`, `.htm`                   | `html`  |
| `.css`                            | `css`   |
| `.scss`, `.sass`                  | `scss`  |
| `.json`                           | `json`  |
| `.yaml`, `.yml`                   | `yaml`  |
| `.toml`                           | `toml`  |
| `.md`                             | `md`    |
| `.txt`                            | `txt`   |
| `.env`                            | `env`   |
| `.xml`                            | `xml`   |

Unknown extensions default to `txt`.

### By content heuristic (detectLang)

```javascript
export function detectLang(code) { ... }
```

Regex-based detection from first line of code. Used when no file extension is available (e.g., stdin piping, future feature). Detects: `js`, `py`, `rs`, `go`, `php`. Falls back to `txt`.

## trimToTokenBudget(content, maxTokens) -> string

Trims content to fit within a token budget while preserving usefulness.

**Strategy:** Keep the start and end of the file (where declarations, imports, and return statements typically live). Cut the middle.

```
{first half}
... [truncated] ...
{last half}
```

If content already fits: returns unchanged.

## Error Messages

All errors thrown by this module must be actionable:
- `"File not found: src/missing.js"` — user knows exactly which path failed
- `"Not a file: src/"` — user knows they passed a directory
