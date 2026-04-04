/**
 * File reader — reads source files and extracts metadata for DOT encoding.
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { extname, basename } from 'path';

const LANG_MAP = {
  '.js':   'js',   '.mjs': 'js',   '.cjs': 'js',
  '.ts':   'ts',   '.tsx': 'tsx',  '.jsx': 'jsx',
  '.py':   'py',   '.pyw': 'py',
  '.rs':   'rs',
  '.go':   'go',
  '.java': 'java',
  '.c':    'c',    '.h':   'c',
  '.cpp':  'cpp',  '.cc':  'cpp',  '.cxx': 'cpp',
  '.cs':   'cs',
  '.rb':   'rb',
  '.php':  'php',
  '.swift':'swift',
  '.kt':   'kt',
  '.sh':   'sh',   '.bash':'sh',   '.zsh': 'sh',
  '.sql':  'sql',
  '.html': 'html', '.htm': 'html',
  '.css':  'css',  '.scss':'scss', '.sass':'scss',
  '.json': 'json',
  '.yaml': 'yaml', '.yml':'yaml',
  '.toml': 'toml',
  '.md':   'md',
  '.txt':  'txt',
  '.env':  'env',
  '.xml':  'xml',
};

const MAX_FILE_CHARS = 8000; // ~2300 tokens — truncate large files

/**
 * Read a file and return structured context ready for DOT encoding.
 */
export function readFileContext(filePath, opts = {}) {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stats = statSync(filePath);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  const ext      = extname(filePath).toLowerCase();
  const lang     = LANG_MAP[ext] || 'txt';
  const filename = basename(filePath);
  let   content  = readFileSync(filePath, 'utf8');

  // Truncate if too large
  let truncated = false;
  if (content.length > MAX_FILE_CHARS) {
    content   = content.slice(0, MAX_FILE_CHARS);
    truncated = true;
  }

  // Extract specific line range if requested
  if (opts.startLine || opts.endLine) {
    const lines = content.split('\n');
    const start = (opts.startLine || 1) - 1;
    const end   = opts.endLine || lines.length;
    content = lines.slice(start, end).join('\n');
  }

  return {
    file:      filename,
    filePath,
    lang,
    content,
    truncated,
    lines:     content.split('\n').length,
    chars:     content.length,
  };
}

/**
 * Detect language from a code string (basic heuristics)
 */
export function detectLang(code) {
  if (/^(import|export|const|let|var|function|class|=>)/.test(code)) return 'js';
  if (/^(def |class |import |from |if __name__)/.test(code)) return 'py';
  if (/^(fn |use |struct |impl |pub )/.test(code)) return 'rs';
  if (/^(package |import "fmt"|func )/.test(code)) return 'go';
  if (/^(<\?php|namespace |use |echo )/.test(code)) return 'php';
  return 'txt';
}

/**
 * Trim content to fit within a token budget.
 * Prefers keeping the start and end of the file (where declarations and returns live).
 */
export function trimToTokenBudget(content, maxTokens) {
  const maxChars = maxTokens * 3.5;
  if (content.length <= maxChars) return content;

  const half   = Math.floor(maxChars / 2);
  const start  = content.slice(0, half);
  const end    = content.slice(-half);
  return `${start}\n... [truncated] ...\n${end}`;
}
