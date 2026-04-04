#!/usr/bin/env node
/**
 * aicli — token-efficient AI CLI
 *
 * Usage:
 *   aicli                          # interactive chat (REPL)
 *   aicli ask "explain this"       # one-shot question
 *   aicli file src/app.js          # review a file
 *   aicli fix src/app.js           # ask AI to fix a file
 *   aicli explain src/app.js       # explain a file
 *   aicli config                   # show current config
 *   aicli config --set lang=en     # change a setting
 *   aicli dot "your message"       # show DOT encoding of a message
 *   aicli bench "your message"     # benchmark DOT vs JSON vs MD
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';

import { loadConfig, saveGlobalConfig } from '../src/config.js';
import { AIClient }     from '../src/client.js';
import { startRepl }    from '../src/repl.js';
import { readFileContext } from '../src/files.js';
import { encodeDot, compareFormats, prettyPrintDot } from '../src/dot.js';

const program = new Command();

program
  .name('aicli')
  .description('Token-efficient AI CLI — DOT format, token limits, Simplified Chinese by default')
  .version('1.0.0')
  .option('-k, --api-key <key>',    'Anthropic API key (or set ANTHROPIC_API_KEY)')
  .option('-m, --model <model>',    'Model to use (default: claude-sonnet-4-20250514)')
  .option('-l, --lang <lang>',      'Output language (default: zh-CN)')
  .option('-t, --max-tokens <n>',   'Max tokens per response', parseInt)
  .option('-b, --budget <n>',       'Session token budget (total)', parseInt)
  .option('--no-stream',            'Disable streaming')
  .option('--no-tokens',            'Hide token usage info')
  .option('--temp <n>',             'Temperature 0-1', parseFloat);

// ── CHAT (default / REPL) ─────────────────────────────────────────────────
program
  .command('chat', { isDefault: true })
  .description('Interactive chat (default command)')
  .action(async () => {
    const cfg    = buildCfg();
    const client = makeClient(cfg);
    await startRepl(client, cfg);
  });

// ── ASK ───────────────────────────────────────────────────────────────────
program
  .command('ask <message>')
  .description('One-shot question')
  .option('-f, --file <path>', 'Attach a file as context')
  .action(async (message, opts) => {
    const cfg    = buildCfg();
    const client = makeClient(cfg);

    const sendOpts = { question: message };

    if (opts.file) {
      const fc = readFileContext(opts.file);
      sendOpts.file     = fc.file;
      sendOpts.fileLang = fc.lang;
      sendOpts.content  = fc.content;
    }

    const spinner = cfg.streaming ? null : ora('Thinking…').start();
    if (!cfg.streaming) spinner?.start();

    try {
      process.stdout.write('\n');
      const result = await client.send(sendOpts);
      if (spinner) spinner.stop();
      process.stdout.write('\n');

      if (cfg.showTokens) {
        const u = result.usage;
        console.log(chalk.dim(`\n  ↑${u.input_tokens} ↓${u.output_tokens}  total: ${client.tokenSummary}`));
      }
    } catch (err) {
      if (spinner) spinner.fail(err.message);
      else console.error(chalk.red(err.message));
      process.exit(1);
    }
  });

// ── FILE ──────────────────────────────────────────────────────────────────
program
  .command('file <path>')
  .description('Review a file (general analysis)')
  .option('--start <n>', 'Start line', parseInt)
  .option('--end <n>',   'End line', parseInt)
  .action(async (filePath, opts) => {
    await fileCommand(filePath, 'review', opts);
  });

// ── FIX ───────────────────────────────────────────────────────────────────
program
  .command('fix <path>')
  .description('Ask AI to fix bugs in a file')
  .option('-e, --error <msg>', 'Paste error message')
  .option('--start <n>', 'Start line', parseInt)
  .option('--end <n>',   'End line', parseInt)
  .action(async (filePath, opts) => {
    await fileCommand(filePath, 'fix', opts);
  });

// ── EXPLAIN ───────────────────────────────────────────────────────────────
program
  .command('explain <path>')
  .description('Explain what a file does')
  .option('--start <n>', 'Start line', parseInt)
  .option('--end <n>',   'End line', parseInt)
  .action(async (filePath, opts) => {
    await fileCommand(filePath, 'explain', opts);
  });

// ── REFACTOR ──────────────────────────────────────────────────────────────
program
  .command('refactor <path>')
  .description('Ask AI to refactor/improve a file')
  .option('--start <n>', 'Start line', parseInt)
  .option('--end <n>',   'End line', parseInt)
  .action(async (filePath, opts) => {
    await fileCommand(filePath, 'refactor', opts);
  });

// ── DOT ───────────────────────────────────────────────────────────────────
program
  .command('dot <message>')
  .description('Show how a message looks in DOT format')
  .option('-f, --file <path>', 'Include a file in the encoding')
  .action((message, opts) => {
    const data = { question: message, task: 'ask' };
    if (opts.file) {
      try {
        const fc = readFileContext(opts.file);
        data.file    = fc.file;
        data.lang    = fc.lang;
        data.content = fc.content;
      } catch (e) {
        console.error(chalk.red(e.message));
        process.exit(1);
      }
    }

    const dot = encodeDot(data);
    console.log(chalk.bold('\nDOT payload:'));
    console.log(chalk.cyan(dot));
    console.log(chalk.bold('\nDecoded:'));
    console.log(prettyPrintDot(dot));
    console.log(chalk.dim(`\nestimated tokens: ~${Math.ceil(dot.length / 3.5)}`));
  });

// ── BENCH ─────────────────────────────────────────────────────────────────
program
  .command('bench <message>')
  .description('Compare token cost: DOT vs JSON vs Markdown')
  .option('-f, --file <path>', 'Include a file for a realistic benchmark')
  .action((message, opts) => {
    const data = { question: message, task: 'explain' };
    if (opts.file) {
      try {
        const fc     = readFileContext(opts.file);
        data.file    = fc.file;
        data.lang    = fc.lang;
        data.content = fc.content.slice(0, 500); // limit for display
      } catch (e) {
        console.error(chalk.red(e.message));
        process.exit(1);
      }
    }

    const cmp = compareFormats(data);
    console.log(chalk.bold('\n  Token cost comparison\n'));
    console.log(`  ${chalk.gray('JSON     ')}  ${chalk.red(String(cmp.json.tokens).padStart(6))} tokens`);
    console.log(`  ${chalk.gray('Markdown ')}  ${chalk.yellow(String(cmp.markdown.tokens).padStart(6))} tokens`);
    console.log(`  ${chalk.gray('DOT      ')}  ${chalk.green(String(cmp.dot.tokens).padStart(6))} tokens`);
    console.log();
    console.log(`  DOT saves ${chalk.green(cmp.savings.vsJson + '%')} vs JSON`);
    console.log(`  DOT saves ${chalk.green(cmp.savings.vsMarkdown + '%')} vs Markdown`);
    console.log();
    console.log(chalk.dim('  DOT string:'));
    console.log(chalk.dim('  ' + cmp.dot.str.slice(0, 120) + (cmp.dot.str.length > 120 ? '…' : '')));
  });

// ── CONFIG ────────────────────────────────────────────────────────────────
program
  .command('config')
  .description('View or change configuration')
  .option('--set <keyval>', 'Set a config value, e.g. --set lang=en')
  .option('--global',       'Apply to global config (~/.aiclirc)')
  .action((opts) => {
    if (opts.set) {
      const [k, ...vparts] = opts.set.split('=');
      const v = vparts.join('=');
      if (!k || !v) {
        console.error(chalk.red('  usage: aicli config --set key=value'));
        process.exit(1);
      }
      saveGlobalConfig({ [k.trim()]: v.trim() });
      console.log(chalk.green(`  saved: ${k} = ${v}`));
      return;
    }

    const cfg = loadConfig();
    console.log(chalk.bold('\n  aicli config\n'));
    const keys = ['model', 'lang', 'maxTokens', 'budget', 'format', 'streaming', 'showTokens', 'temperature'];
    for (const k of keys) {
      const val = cfg[k] === null ? chalk.gray('null') : chalk.cyan(String(cfg[k]));
      console.log(`  ${k.padEnd(14)} ${val}`);
    }
    console.log();
    console.log(chalk.dim('  Config files:'));
    console.log(chalk.dim(`    global: ~/.aiclirc`));
    console.log(chalk.dim(`    local:  .aicli  (in current directory)`));
    console.log();
  });

// ── helpers ───────────────────────────────────────────────────────────────
function buildCfg() {
  const opts = program.opts();
  const overrides = {};

  if (opts.apiKey)    overrides.apiKey     = opts.apiKey;
  if (opts.model)     overrides.model      = opts.model;
  if (opts.lang)      overrides.lang       = opts.lang;
  if (opts.maxTokens) overrides.maxTokens  = opts.maxTokens;
  if (opts.budget)    overrides.budget     = opts.budget;
  if (opts.noStream)  overrides.streaming  = false;
  if (opts.noTokens)  overrides.showTokens = false;
  if (opts.temp)      overrides.temperature = opts.temp;

  return loadConfig(overrides);
}

function makeClient(cfg) {
  try {
    return new AIClient(cfg);
  } catch (e) {
    console.error(chalk.red('\n  ' + e.message));
    console.error(chalk.gray('  set it: export ANTHROPIC_API_KEY=sk-ant-...\n'));
    process.exit(1);
  }
}

async function fileCommand(filePath, task, opts) {
  const cfg = buildCfg();
  const client = makeClient(cfg);

  let fc;
  try {
    fc = readFileContext(filePath, {
      startLine: opts.start,
      endLine:   opts.end,
    });
  } catch (e) {
    console.error(chalk.red(e.message));
    process.exit(1);
  }

  console.log(chalk.gray(`\n  ${task}: ${fc.file} (${fc.lang}, ${fc.lines} lines)\n`));
  process.stdout.write(chalk.bold.green('ai') + chalk.gray(' › '));

  try {
    const result = await client.send({
      task,
      file:     fc.file,
      fileLang: fc.lang,
      content:  fc.content,
      error:    opts.error,
    });

    process.stdout.write('\n');

    if (cfg.showTokens) {
      const u = result.usage;
      console.log(chalk.dim(`\n  ↑${u.input_tokens} ↓${u.output_tokens}  ${client.tokenSummary}`));
    }

    if (fc.truncated) {
      console.log(chalk.yellow(`\n  ⚠ file was truncated to first 8000 chars`));
    }
  } catch (err) {
    console.error(chalk.red('\n  ' + err.message));
    process.exit(1);
  }
}

program.parse(process.argv);
