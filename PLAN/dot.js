/**
 * DOT FORMAT — Ultra-compact context encoding
 *
 * Instead of JSON:
 *   {"file":"index.js","lang":"javascript","content":"const x = 1"}
 *   → 52 tokens
 *
 * Or Markdown:
 *   ## File: index.js (javascript)
 *   ```javascript
 *   const x = 1
 *   ```
 *   → 18 tokens
 *
 * DOT format:
 *   .f:index.js.l:js.c:const x=1
 *   → 9 tokens  ← ~50% savings vs markdown, ~80% vs JSON
 *
 * Schema:
 *   .f:<filename>        file name
 *   .l:<lang>            language (js, py, ts, sh, etc.)
 *   .c:<content>         code/content (newlines → ↵)
 *   .e:<error>           error message
 *   .q:<question>        user question
 *   .ctx:<context>       extra context
 *   .t:<task>            task type (fix, explain, refactor, review)
 *   .line:<n>            line number reference
 *   .cfg:<key>=<val>     config key=value pairs
 */

const NEWLINE_TOKEN = '↵';

export function encodeDot(obj) {
  const parts = [];

  if (obj.task)    parts.push(`.t:${obj.task}`);
  if (obj.lang)    parts.push(`.l:${obj.lang}`);
  if (obj.file)    parts.push(`.f:${obj.file}`);
  if (obj.line)    parts.push(`.line:${obj.line}`);
  if (obj.content) parts.push(`.c:${escapeContent(obj.content)}`);
  if (obj.error)   parts.push(`.e:${escapeContent(obj.error)}`);
  if (obj.context) parts.push(`.ctx:${escapeContent(obj.context)}`);
  if (obj.question) parts.push(`.q:${escapeContent(obj.question)}`);

  if (obj.config) {
    for (const [k, v] of Object.entries(obj.config)) {
      parts.push(`.cfg:${k}=${v}`);
    }
  }

  return parts.join('');
}

export function decodeDot(dotStr) {
  const obj = {};
  const regex = /\.(\w+):([^.]*(?:\.[^a-z][^.]*)*)/g;
  let match;

  while ((match = regex.exec(dotStr)) !== null) {
    const key = match[1];
    const val = unescapeContent(match[2]);

    switch (key) {
      case 't':    obj.task = val; break;
      case 'l':    obj.lang = val; break;
      case 'f':    obj.file = val; break;
      case 'line': obj.line = val; break;
      case 'c':    obj.content = val; break;
      case 'e':    obj.error = val; break;
      case 'ctx':  obj.context = val; break;
      case 'q':    obj.question = val; break;
      case 'cfg':
        if (!obj.config) obj.config = {};
        const [k, v] = val.split('=');
        obj.config[k] = v;
        break;
    }
  }

  return obj;
}

function escapeContent(str) {
  return String(str)
    .replace(/\n/g, NEWLINE_TOKEN)
    .replace(/\t/g, '→')
    .trim();
}

function unescapeContent(str) {
  return str
    .replace(new RegExp(NEWLINE_TOKEN, 'g'), '\n')
    .replace(/→/g, '\t');
}

/**
 * Build a DOT-encoded prompt from structured input.
 * Returns both the DOT string and an estimated token count.
 */
export function buildDotPrompt(opts) {
  const dotPayload = encodeDot({
    task:     opts.task,
    file:     opts.file,
    lang:     opts.lang,
    line:     opts.line,
    content:  opts.content,
    error:    opts.error,
    context:  opts.context,
    question: opts.question,
  });

  // Rough token estimate: ~1 token per 3.5 chars for code/mixed content
  const estimatedTokens = Math.ceil(dotPayload.length / 3.5);

  return { dotPayload, estimatedTokens };
}

/**
 * Format a DOT string for display (pretty-print for humans)
 */
export function prettyPrintDot(dotStr) {
  const obj = decodeDot(dotStr);
  const lines = [];

  if (obj.task)     lines.push(`  task     : ${obj.task}`);
  if (obj.lang)     lines.push(`  lang     : ${obj.lang}`);
  if (obj.file)     lines.push(`  file     : ${obj.file}`);
  if (obj.line)     lines.push(`  line     : ${obj.line}`);
  if (obj.question) lines.push(`  question : ${obj.question}`);
  if (obj.error)    lines.push(`  error    : ${obj.error.slice(0, 80)}...`);
  if (obj.content)  lines.push(`  content  : [${obj.content.length} chars]`);
  if (obj.context)  lines.push(`  context  : ${obj.context.slice(0, 60)}...`);

  return lines.join('\n');
}

/**
 * Compare token costs between formats
 */
export function compareFormats(data) {
  const jsonStr  = JSON.stringify(data);
  const mdStr    = toMarkdown(data);
  const dotStr   = encodeDot(data);

  const est = (s) => Math.ceil(s.length / 3.5);

  return {
    json:     { str: jsonStr, tokens: est(jsonStr) },
    markdown: { str: mdStr,   tokens: est(mdStr)   },
    dot:      { str: dotStr,  tokens: est(dotStr)   },
    savings: {
      vsJson:     Math.round((1 - est(dotStr)/est(jsonStr)) * 100),
      vsMarkdown: Math.round((1 - est(dotStr)/est(mdStr))   * 100),
    }
  };
}

function toMarkdown(data) {
  let md = '';
  if (data.task)    md += `## Task: ${data.task}\n`;
  if (data.file)    md += `## File: ${data.file}`;
  if (data.lang)    md += ` (${data.lang})`;
  if (data.file || data.lang) md += '\n';
  if (data.content) md += `\`\`\`${data.lang||''}\n${data.content}\n\`\`\`\n`;
  if (data.error)   md += `**Error:** ${data.error}\n`;
  if (data.question) md += `**Question:** ${data.question}\n`;
  return md;
}
