/**
 * Interactive REPL — chat mode for aicli.
 * Supports multi-turn conversation with token tracking.
 */

import * as readline from 'readline';
import chalk from 'chalk';
import { countTokensSync } from './tokens.js';
import { readFileContext } from './files.js';
import { prettyPrintDot, compareFormats } from './dot.js';

const PROMPT = chalk.cyan('you') + chalk.gray(' › ');

// Commands available in chat mode
const COMMANDS = {
  '/exit':    'Exit chat',
  '/clear':   'Clear conversation history',
  '/tokens':  'Show token usage',
  '/budget':  'Show remaining token budget',
  '/file <path>': 'Attach a file to the next message',
  '/lang <code>': 'Switch output language (e.g. en, zh-CN, ja)',
  '/max <n>': 'Set max output tokens per response',
  '/dot':     'Show last message in DOT format',
  '/cmp <msg>': 'Compare token costs: DOT vs JSON vs Markdown',
  '/help':    'Show this help',
};

export async function startRepl(client, cfg) {
  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: PROMPT,
  });

  console.log(chalk.bold.cyan('\n  aicli — token-efficient AI CLI'));
  console.log(chalk.gray(`  model: ${cfg.model}  |  lang: ${cfg.lang}  |  max: ${cfg.maxTokens} tok/reply`));
  if (cfg.budget) {
    console.log(chalk.yellow(`  budget: ${cfg.budget} tokens total`));
  }
  console.log(chalk.gray('  type /help for commands, /exit to quit\n'));

  rl.prompt();

  let pendingFile = null;
  let lastDot     = null;

  rl.on('line', async (input) => {
    const line = input.trim();
    if (!line) { rl.prompt(); return; }

    // --- Handle slash commands ---
    if (line.startsWith('/')) {
      const [cmd, ...args] = line.split(' ');

      switch (cmd) {
        case '/exit':
        case '/quit':
          console.log(chalk.gray('\n  ' + client.tokenSummary));
          console.log(chalk.gray('  bye!\n'));
          process.exit(0);
          break;

        case '/clear':
          client.clearHistory();
          console.log(chalk.gray('  history cleared'));
          break;

        case '/tokens':
          console.log(chalk.gray('  ' + client.tokenSummary));
          break;

        case '/budget': {
          const b = client.budgetObject;
          if (b.max) {
            const bar = progressBar(b.total, b.max, 30);
            console.log(chalk.yellow(`  budget: ${bar} ${b.total}/${b.max} (${b.summary().pct}%)`));
          } else {
            console.log(chalk.gray('  no budget set — unlimited'));
          }
          break;
        }

        case '/file':
          if (!args[0]) {
            console.log(chalk.red('  usage: /file <path>'));
          } else {
            try {
              pendingFile = readFileContext(args[0]);
              console.log(chalk.green(`  attached: ${pendingFile.file} (${pendingFile.lang}, ${pendingFile.lines} lines)`));
            } catch (e) {
              console.log(chalk.red(`  ${e.message}`));
            }
          }
          break;

        case '/lang':
          if (!args[0]) {
            console.log(chalk.red('  usage: /lang <code>  e.g. en, zh-CN, ja, ar'));
          } else {
            cfg.lang = args[0];
            console.log(chalk.green(`  language set to: ${args[0]}`));
          }
          break;

        case '/max':
          if (!args[0] || isNaN(Number(args[0]))) {
            console.log(chalk.red('  usage: /max <number>'));
          } else {
            cfg.maxTokens = Number(args[0]);
            console.log(chalk.green(`  max output set to: ${cfg.maxTokens} tokens`));
          }
          break;

        case '/dot':
          if (lastDot) {
            console.log(chalk.gray('\n  DOT payload:'));
            console.log(chalk.dim('  ' + lastDot));
            console.log(chalk.gray('\n  Decoded:'));
            console.log(prettyPrintDot(lastDot));
          } else {
            console.log(chalk.gray('  no DOT payload yet'));
          }
          break;

        case '/cmp': {
          const msg = args.join(' ') || 'example code content here';
          const data = { task: 'explain', content: msg, lang: 'js', file: 'test.js' };
          const cmp  = compareFormats(data);
          console.log(chalk.bold('\n  Format token comparison:'));
          console.log(chalk.gray(`  JSON     : ${cmp.json.tokens} tokens`));
          console.log(chalk.gray(`  Markdown : ${cmp.markdown.tokens} tokens`));
          console.log(chalk.green(`  DOT      : ${cmp.dot.tokens} tokens`));
          console.log(chalk.yellow(`  Savings  : ${cmp.savings.vsJson}% vs JSON, ${cmp.savings.vsMarkdown}% vs Markdown`));
          console.log();
          break;
        }

        case '/help':
          console.log(chalk.bold('\n  Commands:'));
          for (const [c, desc] of Object.entries(COMMANDS)) {
            console.log(`  ${chalk.cyan(c.padEnd(20))} ${chalk.gray(desc)}`);
          }
          console.log();
          break;

        default:
          console.log(chalk.red(`  unknown command: ${cmd}  (try /help)`));
      }

      rl.prompt();
      return;
    }

    // --- Send message to AI ---
    const sendOpts = { question: line };

    if (pendingFile) {
      sendOpts.file     = pendingFile.file;
      sendOpts.fileLang = pendingFile.lang;
      sendOpts.content  = pendingFile.content;
      pendingFile = null;
    }

    console.log(); // blank line before AI response
    process.stdout.write(chalk.bold.green('ai') + chalk.gray(' › '));

    try {
      const result = await client.send(sendOpts);
      lastDot = result.dotPayload;
      console.log('\n');

      if (cfg.showTokens) {
        const usage = result.usage;
        const budgetInfo = client.budgetObject.max
          ? chalk.yellow(` budget:${client.budgetObject.remaining}rem`)
          : '';
        console.log(
          chalk.dim(`  ↑${usage.input_tokens}tok ↓${usage.output_tokens}tok${budgetInfo}`)
        );
      }
    } catch (err) {
      console.log('\n');
      console.log(chalk.red(`  error: ${err.message}`));
    }

    console.log();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(chalk.gray('\n  ' + client.tokenSummary + '\n'));
    process.exit(0);
  });
}

function progressBar(used, max, width) {
  const pct   = Math.min(1, used / max);
  const filled = Math.round(pct * width);
  const empty  = width - filled;
  const color  = pct > 0.8 ? chalk.red : pct > 0.5 ? chalk.yellow : chalk.green;
  return color('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}
