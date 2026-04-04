#!/usr/bin/env node
/**
 * zipai — token-efficient AI CLI
 *
 * Usage:
 *   zipai                          # interactive chat (REPL)
 *   zipai ask "explain this"       # one-shot question
 *   zipai file src/app.js          # review a file
 *   zipai fix src/app.js           # ask AI to fix a file
 *   zipai explain src/app.js       # explain a file
 *   zipai config                   # show current config
 *   zipai config --set lang=en     # change a setting
 *   zipai dot "your message"       # show DOT encoding of a message
 *   zipai bench "your message"     # benchmark DOT vs JSON vs MD
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';

import { loadConfig, saveGlobalConfig } from '../src/config.js';
import { AIClient }     from '../src/client.js';
import { startRepl }    from '../src/repl.js';
import { readFileContext } from '../src/files.js';
import { encodeDot, compareFormats, prettyPrintDot } from '../src/dot.js';
import {
  getProviderDefinition,
  getProviderMap,
  inferProviderForModel,
  listModels as listProviderModels,
  listProviderStatus,
  normalizeProviderId,
  resolveProviderId,
} from '../src/providers.js';
import {
  createSpecFile,
  listSpecFiles,
  readSpecFile,
} from '../src/specs.js';
import {
  createSession,
  getActiveSession,
  getOrCreateSession,
  listSessions,
  setActiveSession,
  updateSessionHistory,
} from '../src/sessions.js';
import {
  installPlugin,
  listPlugins,
} from '../src/plugins.js';

const THEME_HEX = '#d77756';
const ACCENT = chalk.hex(THEME_HEX);
const ACCENT_BOLD = chalk.bold.hex(THEME_HEX);
const ACCENT_SOFT = chalk.hex(THEME_HEX);

const program = new Command();

program
  .name('zipai')
  .description('Token-efficient AI CLI — DOT format, token limits, Simplified Chinese by default')
  .version('1.0.0')
  .option('-k, --api-key <key>',    'API key for active provider (or provider env var)')
  .option('-p, --provider <provider>', 'Provider to use (default: anthropic)')
  .option('-m, --model <model>',    'Model to use (default: claude-sonnet-4-20250514)')
  .option('-c, --continue',         'Continue active session')
  .option('-s, --session <id>',     'Session id to continue')
  .option('--new-session',          'Create a new session for this run')
  .option('-l, --lang <lang>',      'Output language (default: zh-CN)')
  .option('-t, --max-tokens <n>',   'Max tokens per response', parseInt)
  .option('-b, --budget <n>',       'Session token budget (total)', parseInt)
  .option('--no-stream',            'Disable streaming')
  .option('--no-tokens',            'Hide token usage info')
  .option('--temp <n>',             'Temperature 0-1', parseFloat);

// ── RUN (opencode-style) ────────────────────────────────────────────────
program
  .command('run [message...]')
  .description('Run with a message, or start chat if no message is provided')
  .option('-f, --file <path>', 'Attach a file as context')
  .action(async (messageParts, opts) => {
    const message = Array.isArray(messageParts)
      ? messageParts.join(' ').trim()
      : String(messageParts || '').trim();

    if (!message) {
      const { cfg, client } = createRuntime();
      await startRepl(client, cfg);
      return;
    }

    await askCommand(message, opts);
  });

// ── CHAT (default / REPL) ─────────────────────────────────────────────────
program
  .command('chat', { isDefault: true })
  .description('Interactive chat (default command)')
  .action(async () => {
    const { cfg, client } = createRuntime();
    await startRepl(client, cfg);
  });

// ── ASK ───────────────────────────────────────────────────────────────────
program
  .command('ask <message>')
  .description('One-shot question')
  .option('-f, --file <path>', 'Attach a file as context')
  .action(async (message, opts) => {
    await askCommand(message, opts);
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
    console.log(ACCENT_BOLD('\nDOT payload:'));
    console.log(ACCENT(dot));
    console.log(ACCENT_BOLD('\nDecoded:'));
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
    console.log(ACCENT_BOLD('\n  Token cost comparison\n'));
    console.log(`  ${chalk.gray('JSON     ')}  ${ACCENT(String(cmp.json.tokens).padStart(6))} tokens`);
    console.log(`  ${chalk.gray('Markdown ')}  ${ACCENT(String(cmp.markdown.tokens).padStart(6))} tokens`);
    console.log(`  ${chalk.gray('DOT      ')}  ${ACCENT(String(cmp.dot.tokens).padStart(6))} tokens`);
    console.log();
    console.log(`  DOT saves ${ACCENT_BOLD(cmp.savings.vsJson + '%')} vs JSON`);
    console.log(`  DOT saves ${ACCENT_BOLD(cmp.savings.vsMarkdown + '%')} vs Markdown`);
    console.log();
    console.log(chalk.dim('  DOT string:'));
    console.log(chalk.dim('  ' + cmp.dot.str.slice(0, 120) + (cmp.dot.str.length > 120 ? '…' : '')));
  });

// ── PROVIDERS / AUTH ─────────────────────────────────────────────────────
program
  .command('providers')
  .alias('auth')
  .description('Manage AI providers and credentials')
  .option('--set <provider>', 'Set default provider')
  .option('--key <apiKey>', 'Set API key for provider')
  .option('--for <provider>', 'Provider to store the key for')
  .action((opts) => {
    const providerMap = getProviderMap();

    if (opts.set) {
      const providerId = normalizeProviderId(opts.set);
      if (!providerId) {
        console.error(chalk.red(`  unknown provider: ${opts.set}`));
        console.error(chalk.gray(`  available: ${Object.keys(providerMap).join(', ')}`));
        process.exit(1);
      }

      saveGlobalConfig({ provider: providerId });
      console.log(ACCENT_BOLD(`  default provider set: ${providerId}`));
    }

    if (opts.key) {
      const cfg = loadConfig();
      const targetRaw = opts.for || opts.set || cfg.provider;
      const providerId = normalizeProviderId(targetRaw);

      if (!providerId) {
        console.error(chalk.red(`  unknown provider for key storage: ${targetRaw}`));
        process.exit(1);
      }

      const def = getProviderDefinition(providerId);
      if (!def) {
        console.error(chalk.red(`  unknown provider: ${providerId}`));
        process.exit(1);
      }

      saveGlobalConfig({ [def.keyField]: String(opts.key).trim() });
      console.log(ACCENT_BOLD(`  saved credential for ${providerId} (${def.keyField})`));
    }

    const cfg = loadConfig();
    const rows = listProviderStatus(cfg);

    console.log(ACCENT_BOLD('\n  providers\n'));
    for (const row of rows) {
      const marker = row.active ? '*' : ' ';
      const keyState = row.configured
        ? ACCENT('configured')
        : ACCENT_SOFT(`missing (${row.envKey})`);
      const runtimeState = row.chatReady
        ? ACCENT('chat-ready')
        : chalk.gray('planned');

      console.log(
        `  ${marker} ${row.id.padEnd(10)} ${row.name.padEnd(12)} ${keyState.padEnd(30)} ${runtimeState}`
      );
    }

    console.log();
    console.log(chalk.dim('  * active provider'));
    console.log(chalk.dim('  note: runtime chat currently supports anthropic and zai\n'));
  });

// ── MODELS ───────────────────────────────────────────────────────────────
program
  .command('models [provider]')
  .description('List known models for a provider')
  .action((providerArg) => {
    const cfg = buildCfg();
    const providerId = normalizeProviderId(providerArg || cfg.provider);

    if (!providerId) {
      const available = Object.keys(getProviderMap()).join(', ');
      console.error(chalk.red(`  unknown provider: ${providerArg}`));
      console.error(chalk.gray(`  available: ${available}`));
      process.exit(1);
    }

    const models = listProviderModels(providerId);
    console.log(ACCENT_BOLD(`\n  models (${providerId})\n`));
    for (const model of models) {
      console.log(`  - ${model}`);
    }
    console.log();
  });

// ── MODEL / SWITCH-MODEL ────────────────────────────────────────────────
program
  .command('model [nextModel]')
  .description('Show current model or set a new default model')
  .action((nextModel) => {
    if (!nextModel) {
      const cfg = loadConfig();
      console.log(ACCENT_BOLD('\n  model\n'));
      console.log(`  provider: ${cfg.provider}`);
      console.log(`  model:    ${cfg.model}\n`);
      return;
    }

    const raw = String(nextModel).trim();
    const inferredProvider = inferProviderForModel(raw);

    if (raw.includes('/')) {
      const [providerPart, ...modelParts] = raw.split('/');
      const providerId = normalizeProviderId(providerPart);
      const cleanModel = modelParts.join('/').trim();

      if (!providerId || !cleanModel) {
        console.error(chalk.red('\n  expected model format: provider/model\n'));
        process.exit(1);
      }

      saveGlobalConfig({ provider: providerId, model: cleanModel });
      console.log(ACCENT_BOLD(`\n  default provider/model set: ${providerId}/${cleanModel}\n`));
      return;
    }

    if (inferredProvider) {
      saveGlobalConfig({ provider: inferredProvider, model: raw });
      console.log(ACCENT_BOLD(`\n  default model set: ${raw}`));
      console.log(chalk.gray(`  inferred provider: ${inferredProvider}\n`));
      return;
    }

    saveGlobalConfig({ model: raw });
    console.log(ACCENT_BOLD(`\n  default model set: ${raw}\n`));
  });

program
  .command('switch-model <nextModel>')
  .description('Switch default model (shortcut)')
  .action((nextModel) => {
    const raw = String(nextModel).trim();
    const inferredProvider = inferProviderForModel(raw);

    if (raw.includes('/')) {
      const [providerPart, ...modelParts] = raw.split('/');
      const providerId = normalizeProviderId(providerPart);
      const cleanModel = modelParts.join('/').trim();

      if (!providerId || !cleanModel) {
        console.error(chalk.red('\n  expected model format: provider/model\n'));
        process.exit(1);
      }

      saveGlobalConfig({ provider: providerId, model: cleanModel });
      console.log(ACCENT_BOLD(`\n  switched provider/model: ${providerId}/${cleanModel}\n`));
      return;
    }

    if (inferredProvider) {
      saveGlobalConfig({ provider: inferredProvider, model: raw });
      console.log(ACCENT_BOLD(`\n  switched model: ${raw}`));
      console.log(chalk.gray(`  inferred provider: ${inferredProvider}\n`));
      return;
    }

    saveGlobalConfig({ model: raw });
    console.log(ACCENT_BOLD(`\n  switched model: ${raw}\n`));
  });

// ── SESSION / SWITCH-SESSION ────────────────────────────────────────────
const session = program
  .command('session')
  .description('Manage chat sessions');

session
  .command('list')
  .description('List sessions')
  .action(() => {
    const sessions = listSessions();
    if (sessions.length === 0) {
      console.log(chalk.gray('\n  no sessions yet. start with: zipai run\n'));
      return;
    }

    console.log(ACCENT_BOLD('\n  sessions\n'));
    for (const s of sessions) {
      const marker = s.active ? '*' : ' ';
      const meta = [s.provider || 'n/a', s.model || 'n/a'].join(' | ');
      console.log(`  ${marker} ${s.id}  ${s.name}  (${s.turns} turns, ${meta})`);
    }
    console.log();
  });

session
  .command('new [name]')
  .description('Create and switch to a new session')
  .action((name) => {
    const cfg = buildCfg();
    const created = createSession({
      name,
      provider: cfg.provider,
      model: cfg.model,
    });

    console.log(ACCENT_BOLD(`\n  new session: ${created.id}`));
    console.log(chalk.gray(`  name: ${created.name}`));
    console.log(chalk.gray('  run: zipai run --continue\n'));
  });

session
  .command('switch <sessionId>')
  .description('Switch active session')
  .action((sessionId) => {
    try {
      const switched = setActiveSession(sessionId);
      console.log(ACCENT_BOLD(`\n  active session: ${switched.id}`));
      console.log(chalk.gray(`  name: ${switched.name}\n`));
    } catch (err) {
      console.error(chalk.red(`\n  ${err.message}\n`));
      process.exit(1);
    }
  });

session
  .command('current')
  .description('Show current active session')
  .action(() => {
    const active = getActiveSession();
    if (!active) {
      console.log(chalk.gray('\n  no active session\n'));
      return;
    }

    console.log(ACCENT_BOLD('\n  active session\n'));
    console.log(`  id: ${active.id}`);
    console.log(`  name: ${active.name}`);
    console.log(`  provider: ${active.provider || 'n/a'}`);
    console.log(`  model: ${active.model || 'n/a'}`);
    console.log(`  turns: ${Math.floor((active.history || []).length / 2)}\n`);
  });

program
  .command('switch-session <sessionId>')
  .description('Switch active session (shortcut)')
  .action((sessionId) => {
    try {
      const switched = setActiveSession(sessionId);
      console.log(ACCENT_BOLD(`\n  switched to session: ${switched.id}\n`));
    } catch (err) {
      console.error(chalk.red(`\n  ${err.message}\n`));
      process.exit(1);
    }
  });

// ── SKILLS ───────────────────────────────────────────────────────────────
program
  .command('skills')
  .description('List built-in prompt skills')
  .action(() => {
    const skills = [
      'debug-fixer',
      'code-review',
      'refactor-optimizer',
      'spec-writer',
      'token-saver-dot',
    ];

    console.log(ACCENT_BOLD('\n  skills\n'));
    for (const skill of skills) {
      console.log(`  - ${skill}`);
    }
    console.log();
  });

// ── PLUGINS / PLUGIN ─────────────────────────────────────────────────────
program
  .command('plugins')
  .description('List installed plugins')
  .action(() => {
    const plugins = listPlugins();
    if (plugins.length === 0) {
      console.log(chalk.gray('\n  no plugins installed\n'));
      return;
    }

    console.log(ACCENT_BOLD('\n  plugins\n'));
    for (const plugin of plugins) {
      const installedAt = plugin.installedAt || 'unknown date';
      console.log(`  - ${plugin.module} (${installedAt})`);
    }
    console.log();
  });

program
  .command('plugin <module>')
  .alias('plug')
  .description('Install plugin')
  .option('--force', 'Overwrite plugin if already installed')
  .action((moduleName, opts) => {
    try {
      const result = installPlugin(moduleName, { force: Boolean(opts.force) });
      const verb = result.overwritten ? 'updated' : 'installed';
      console.log(ACCENT_BOLD(`\n  ${verb}: ${result.module}`));
      console.log(chalk.gray(`  manifest: ${result.manifestPath}\n`));
    } catch (err) {
      console.error(chalk.red(`\n  ${err.message}\n`));
      process.exit(1);
    }
  });

// ── TIPS ─────────────────────────────────────────────────────────────────
const tips = program
  .command('tips')
  .description('Manage startup tips');

tips
  .command('hide')
  .description('Hide tips in chat startup')
  .action(() => {
    saveGlobalConfig({ showTips: false });
    console.log(ACCENT_BOLD('\n  tips hidden\n'));
  });

tips
  .command('show')
  .description('Show tips in chat startup')
  .action(() => {
    saveGlobalConfig({ showTips: true });
    console.log(ACCENT_BOLD('\n  tips enabled\n'));
  });

// ── SPEC (speckit-style workflow) ────────────────────────────────────────
const spec = program
  .command('spec')
  .description('Specification workflow (list, init, show)');

spec
  .command('list')
  .description('List spec documents under ./specs')
  .action(() => {
    const files = listSpecFiles();
    if (files.length === 0) {
      console.log(chalk.gray('\n  no specs found in ./specs\n'));
      return;
    }

    console.log(ACCENT_BOLD('\n  specs\n'));
    for (const file of files) {
      console.log(`  - ${file}`);
    }
    console.log();
  });

spec
  .command('init <name>')
  .description('Create a new spec from template')
  .option('--title <title>', 'Title override')
  .option('--desc <description>', 'Summary line in spec')
  .option('--force', 'Overwrite if spec already exists')
  .action((name, opts) => {
    try {
      const created = createSpecFile(name, {
        force: Boolean(opts.force),
        title: opts.title,
        description: opts.desc,
      });

      const verb = created.overwritten ? 'overwritten' : 'created';
      console.log(ACCENT_BOLD(`\n  ${verb}: specs/${created.fileName}\n`));
    } catch (err) {
      console.error(chalk.red(`\n  ${err.message}\n`));
      process.exit(1);
    }
  });

spec
  .command('show <name>')
  .description('Print a spec file by name')
  .action((name) => {
    try {
      const content = readSpecFile(name);
      console.log();
      process.stdout.write(content);
      if (!content.endsWith('\n')) process.stdout.write('\n');
      console.log();
    } catch (err) {
      console.error(chalk.red(`\n  ${err.message}\n`));
      process.exit(1);
    }
  });

// ── CONFIG ────────────────────────────────────────────────────────────────
program
  .command('config')
  .description('View or change configuration')
  .option('--set <keyval>', 'Set a config value, e.g. --set lang=en')
  .option('--global',       'Apply to global config (~/.zipairc)')
  .action((opts) => {
    if (opts.set) {
      const [k, ...vparts] = opts.set.split('=');
      const v = vparts.join('=');
      if (!k || !v) {
        console.error(chalk.red('  usage: zipai config --set key=value'));
        process.exit(1);
      }
      saveGlobalConfig({ [k.trim()]: v.trim() });
      console.log(ACCENT_BOLD(`  saved: ${k} = ${v}`));
      return;
    }

    const cfg = loadConfig();
    console.log(ACCENT_BOLD('\n  zipai config\n'));
    const keys = ['provider', 'mode', 'model', 'lang', 'maxTokens', 'budget', 'format', 'streaming', 'showTokens', 'showTips', 'temperature'];
    for (const k of keys) {
      const val = cfg[k] === null ? chalk.gray('null') : ACCENT(String(cfg[k]));
      console.log(`  ${k.padEnd(14)} ${val}`);
    }
    console.log();
    console.log(chalk.dim('  Config files:'));
    console.log(chalk.dim(`    global: ~/.zipairc`));
    console.log(chalk.dim(`    local:  .zipai  (in current directory)`));
    console.log();
  });

// ── helpers ───────────────────────────────────────────────────────────────
function createRuntime() {
  const cfg = buildCfg();

  let session;
  try {
    session = cfg.newSession
      ? createSession({
        provider: cfg.provider,
        model: cfg.model,
      })
      : getOrCreateSession({
        sessionId: cfg.session,
        provider: cfg.provider,
        model: cfg.model,
        createIfMissing: true,
      });
  } catch (err) {
    console.error(chalk.red(`\n  ${err.message}\n`));
    process.exit(1);
  }

  cfg.session = session.id;
  const sessionRef = { id: session.id };
  cfg._sessionRef = sessionRef;

  const client = makeClient(cfg);
  client.history = Array.isArray(session.history) ? [...session.history] : [];
  client.setHistoryChangeHandler((history) => {
    try {
      updateSessionHistory(sessionRef.id, history);
    } catch (err) {
      console.error(ACCENT_SOFT(`\n  warning: failed to save session: ${err.message}\n`));
    }
  });

  return { cfg, client, session };
}

async function askCommand(message, opts = {}) {
  const { cfg, client } = createRuntime();

  const sendOpts = { question: message };

  if (opts.file) {
    const fc = readFileContext(opts.file);
    sendOpts.file = fc.file;
    sendOpts.fileLang = fc.lang;
    sendOpts.content = fc.content;
  }

  const spinner = cfg.streaming ? null : ora('Thinking...').start();
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
}

function buildCfg() {
  const opts = program.opts();
  const overrides = {};

  if (opts.provider) {
    const providerId = normalizeProviderId(opts.provider);
    if (!providerId) {
      const available = Object.keys(getProviderMap()).join(', ');
      console.error(chalk.red(`\n  unknown provider: ${opts.provider}`));
      console.error(chalk.gray(`  available: ${available}\n`));
      process.exit(1);
    }
    overrides.provider = providerId;
  }

  if (opts.apiKey) {
    const resolvedForKey = overrides.provider || resolveProviderId(loadConfig());
    const def = getProviderDefinition(resolvedForKey);
    if (def) {
      overrides[def.keyField] = String(opts.apiKey).trim();
      if (def.keyField === 'apiKey') {
        overrides.apiKey = String(opts.apiKey).trim();
      }
    } else {
      overrides.apiKey = String(opts.apiKey).trim();
    }
  }
  if (opts.model)     overrides.model      = opts.model;
  if (opts.session)   overrides.session    = String(opts.session).trim();
  if (opts.newSession) overrides.newSession = true;
  if (opts.continue)  overrides.continueSession = true;
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
    const providerId = resolveProviderId(cfg);
    const def = getProviderDefinition(providerId);

    console.error(chalk.red('\n  ' + e.message));
    if (def) {
      console.error(chalk.gray(`  set it: zipai providers --for ${providerId} --key <key>`));
      if (def.envKey) {
        console.error(chalk.gray(`          or (PowerShell) $env:${def.envKey}="<key>"`));
      }
    }
    console.error(chalk.gray(`          or from REPL: /key ${providerId}\n`));
    process.exit(1);
  }
}

async function fileCommand(filePath, task, opts) {
  const { cfg, client } = createRuntime();

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
  process.stdout.write(ACCENT_BOLD('ai') + chalk.gray(' › '));

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
      console.log(ACCENT_SOFT(`\n  file was truncated to first 8000 chars`));
    }
  } catch (err) {
    console.error(chalk.red('\n  ' + err.message));
    process.exit(1);
  }
}

program.parse(process.argv);
