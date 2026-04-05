/**
 * Interactive REPL — chat mode for zipai.
 * Supports multi-turn conversation with token tracking.
 */

import * as readline from 'readline';
import { Writable } from 'stream';
import chalk from 'chalk';
import { saveGlobalConfig } from './config.js';
import { prettyPrintDot, compareFormats } from './dot.js';
import { readFileContext } from './files.js';
import { listPlugins } from './plugins.js';
import {
  getProviderApiKey,
  getProviderDefinition,
  getProviderMap,
  listModels,
  listProviderStatus,
  normalizeProviderId,
} from './providers.js';
import { createSession, getSessionById, listSessions, setActiveSession } from './sessions.js';

const THEME_HEX = '#d77756';
const ASK_PROMPT = chalk.hex(THEME_HEX)('ask') + chalk.gray(' > ');
const CMD_PROMPT = chalk.hex(THEME_HEX)('cmd') + chalk.gray(' > ');
const ACCENT = chalk.hex(THEME_HEX);
const ACCENT_BOLD = chalk.bold.hex(THEME_HEX);
const ACCENT_SOFT = chalk.hex(THEME_HEX);
const ANSI_HIDE_CURSOR = '\x1b[?25l';
const ANSI_SHOW_CURSOR = '\x1b[?25h';
const ANSI_ALT_SCREEN_ENTER = '\x1b[?1049h';
const ANSI_ALT_SCREEN_EXIT = '\x1b[?1049l';

const MODE_PRESETS = [
  { mode: 'build', lang: 'zh-CN', modeLabel: 'Build', langLabel: 'Simplified Chinese' },
  { mode: 'plan',  lang: 'zh-CN', modeLabel: 'Plan',  langLabel: 'Simplified Chinese' },
  { mode: 'build', lang: 'en',    modeLabel: 'Build', langLabel: 'English' },
  { mode: 'plan',  lang: 'en',    modeLabel: 'Plan',  langLabel: 'English' },
];

const LOGO_LINES = [
  '███████╗██╗██████╗    █████╗ ██╗',
  '╚══███╔╝██║██╔══██╗  ██╔══██╗██║',
  '  ███╔╝ ██║██████╔╝  ███████║██║',
  ' ███╔╝  ██║██╔═══╝   ██╔══██║██║',
  '███████╗██║██║       ██║  ██║██║',
  '╚══════╝╚═╝╚═╝       ╚═╝  ╚═╝╚═╝',
  '              ZIP.AI',
];

const ASK_HINTS = [
  'Fix broken tests',
  'Refactor auth middleware',
  'Explain this stack trace',
  'Optimize token usage',
  'Review this module design',
];

const TIP_HINTS = [
  'Create JSON theme files in .opencode/themes/ directory',
  'Use /models to switch provider and model quickly',
  'Use /key save <provider> to persist API keys securely',
  'Use /file <path> then send a prompt to attach code context',
  'Use /session list and /session switch <id> to resume old work',
];

// Commands available in chat mode
const COMMANDS = {
  '/exit':    'Exit chat',
  '/clear':   'Clear conversation history',
  '/commands': 'Open command palette',
  '/ui':      'Redraw opencode-like home UI',
  '/tokens':  'Show token usage',
  '/budget':  'Show remaining token budget',
  '/session': 'Show current session id',
  '/session list': 'List local sessions',
  '/session switch <id>': 'Switch current session',
  '/providers': 'Open provider picker',
  '/provider <id|list>': 'Switch provider or open picker',
  '/models':  'Open provider+model picker',
  '/mode <build|plan>': 'Set current mode',
  '/model <id|next|list>': 'Switch model or open model picker',
  '/key [provider]': 'Set API key securely (session only)',
  '/key save [provider]': 'Set API key and persist to ~/.zipairc',
  '/file <path>': 'Attach a file to the next message',
  '/lang <code|toggle>': 'Switch output language (e.g. en, zh-CN)',
  '/max <n>': 'Set max output tokens per response',
  '/dot':     'Show last message in DOT format',
  '/cmp <msg>': 'Compare token costs: DOT vs JSON vs Markdown',
  '/help':    'Show this help',
};

function pickRandom(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items[Math.floor(Math.random() * items.length)];
}

export async function startRepl(client, cfg) {
  const state = createUiState(cfg);

  // Route all readline output through a conditional sink.
  // When composerActive/paletteOpen our TUI owns stdout entirely — readline
  // must not write anything (prompt echo, _refreshLine, clearLine, etc.).
  // When suppressEcho is set (password input) we swallow character echoes too.
  const rlOutput = new Writable({
    write(chunk, _enc, cb) {
      if (!state.composerActive && !state.paletteOpen && !state.suppressEcho) {
        process.stdout.write(chunk);
      }
      cb();
    },
  });

  const rl = readline.createInterface({
    input:    process.stdin,
    output:   rlOutput,
    terminal: true,
    prompt:   ASK_PROMPT,
    completer: (line) => [[], line],
  });

  const cleanupKeybindings = setupKeybindings(rl, cfg, state, client);
  const exitImmersiveScreen = enterImmersiveScreen(state);

  renderHomeUi(cfg, state);

  rl.prompt();

  let pendingFile = null;
  let lastDot     = null;

  const exitRepl = () => {
    setNativeCursorHidden(state, false);
    exitImmersiveScreen();
    cleanupKeybindings();
    console.log(chalk.gray('\n  ' + client.tokenSummary + '\n'));
    process.exit(0);
  };

  rl.on('line', async (input) => {
    if (state.skipNextLine) {
      state.skipNextLine = false;
      clearReadlineBuffer(rl);
      return;
    }

    if (state.paletteOpen) {
      clearReadlineBuffer(rl);
      return;
    }

    const line = input.trim();
    state.draftInput = '';
    state.cursorPos = 0;
    state.pasteInfo = null;
    if (!line) {
      if (state.composerActive) {
        renderHomeUi(cfg, state);
      }
      rl.prompt();
      return;
    }

    // --- Handle slash commands ---
    if (line.startsWith('/')) {
      const [cmd, ...args] = line.split(' ');

      switch (cmd) {
        case '/exit':
        case '/quit':
          console.log(chalk.gray('  bye!'));
          exitRepl();
          break;

        case '/clear':
          client.clearHistory();
          state.composerActive = true;
          state.draftInput = '';
          state.cursorPos = 0;
          renderHomeUi(cfg, state);
          console.log(chalk.gray('  history cleared'));
          break;

        case '/commands':
          openCommandPalette(rl, cfg, state, client);
          return;

        case '/ui':
          state.composerActive = true;
          state.draftInput = '';
          state.cursorPos = 0;
          renderHomeUi(cfg, state);
          break;

        case '/tokens':
          console.log(chalk.gray('  ' + client.tokenSummary));
          break;

        case '/budget': {
          const b = client.budgetObject;
          if (b.max) {
            const bar = progressBar(b.total, b.max, 30);
            console.log(ACCENT_BOLD(`  budget: ${bar} ${b.total}/${b.max} (${b.summary().pct}%)`));
          } else {
            console.log(chalk.gray('  no budget set — unlimited'));
          }
          break;
        }

        case '/session':
          if (args[0] === 'list') {
            printSessionList();
            break;
          }

          if (args[0] === 'switch') {
            const sessionId = args[1];
            if (!sessionId) {
              console.log(chalk.red('  usage: /session switch <id>'));
              break;
            }

            try {
              const msg = switchSession(sessionId, cfg, client);
              console.log(ACCENT_BOLD(`  ${msg}`));
            } catch (err) {
              console.log(chalk.red(`  ${err.message}`));
            }
            break;
          }

          console.log(chalk.gray(`  session: ${cfg.session || 'none'}`));
          break;

        case '/mode':
          if (!args[0]) {
            console.log(chalk.gray(`  current mode: ${state.mode}`));
            break;
          }

          if (!['build', 'plan'].includes(args[0])) {
            console.log(chalk.red('  usage: /mode <build|plan>'));
            break;
          }

          state.mode = args[0];
          cfg.mode = state.mode;
          syncPresetIndex(cfg, state);
          renderHomeUi(cfg, state);
          console.log(ACCENT_BOLD(`  mode switched to: ${state.mode}`));
          break;

        case '/providers':
          openProviderPalette(rl, cfg, state, client);
          return;

        case '/provider':
          if (!args[0] || args[0] === 'list') {
            openProviderPalette(rl, cfg, state, client);
            return;
          }

          try {
            const msg = switchProvider(cfg, client, args[0]);
            renderHomeUi(cfg, state);
            console.log(ACCENT_BOLD(`  ${msg}`));
          } catch (err) {
            console.log(chalk.red(`  ${err.message}`));
          }
          break;

        case '/model':
          if (!args[0]) {
            openModelPalette(rl, cfg, state, client);
            return;
          } else {
            if (args[0] === 'list') {
              openModelPalette(rl, cfg, state, client);
              return;
            }

            if (args[0] === 'next') {
              console.log(ACCENT_BOLD(`  ${cycleModel(cfg, client)}`));
            } else {
              console.log(ACCENT_BOLD(`  ${setModel(cfg, client, args[0])}`));
            }
          }
          break;

        case '/models':
          openModelPalette(rl, cfg, state, client);
          return;

        case '/key': {
          const persist = args[0] === 'save';
          const providerArg = persist ? args[1] : args[0];

          try {
            const msg = await promptAndSetApiKey(rl, cfg, state, client, providerArg, { persist });
            if (msg) {
              console.log(ACCENT_BOLD(`  ${msg}`));
            }
          } catch (err) {
            console.log(chalk.red(`  ${err.message}`));
          }
          return;
        }

        case '/file':
          if (!args[0]) {
            console.log(chalk.red('  usage: /file <path>'));
          } else {
            try {
              pendingFile = readFileContext(args[0]);
              console.log(ACCENT_BOLD(`  attached: ${pendingFile.file} (${pendingFile.lang}, ${pendingFile.lines} lines)`));
            } catch (e) {
              console.log(chalk.red(`  ${e.message}`));
            }
          }
          break;

        case '/lang':
          if (!args[0] || args[0] === 'toggle') {
            console.log(ACCENT_BOLD(`  ${toggleLanguage(cfg, state, client)}`));
          } else {
            cfg.lang = args[0];
            if (client.cfg) {
              client.cfg.lang = args[0];
            }
            syncPresetIndex(cfg, state);
            console.log(ACCENT_BOLD(`  language set to: ${args[0]}`));
          }
          break;

        case '/max':
          if (!args[0] || isNaN(Number(args[0]))) {
            console.log(chalk.red('  usage: /max <number>'));
          } else {
            cfg.maxTokens = Number(args[0]);
            console.log(ACCENT_BOLD(`  max output set to: ${cfg.maxTokens} tokens`));
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
          console.log(ACCENT_BOLD(`  DOT      : ${cmp.dot.tokens} tokens`));
          console.log(ACCENT(`  Savings  : ${cmp.savings.vsJson}% vs JSON, ${cmp.savings.vsMarkdown}% vs Markdown`));
          console.log();
          break;
        }

        case '/help':
          console.log(chalk.bold('\n  Commands:'));
          for (const [c, desc] of Object.entries(COMMANDS)) {
            console.log(`  ${ACCENT(c.padEnd(20))} ${chalk.gray(desc)}`);
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
    const activeProvider = getProviderDefinition(cfg.provider);
    if (!activeProvider?.chatReady) {
      console.log(chalk.red(`  provider "${cfg.provider}" is not wired for runtime chat yet`));
      console.log(chalk.gray('  switch provider: /provider anthropic'));
      console.log(chalk.gray('  set key securely: /key anthropic'));
      rl.prompt();
      return;
    }

    state.composerActive = false;
    state.cursorPos = 0;
    setNativeCursorHidden(state, false);
    const sendOpts = { question: line, task: state.mode };

    if (pendingFile) {
      sendOpts.file     = pendingFile.file;
      sendOpts.fileLang = pendingFile.lang;
      sendOpts.content  = pendingFile.content;
      pendingFile = null;
    }

    console.log(); // blank line before AI response
    process.stdout.write(ACCENT_BOLD('ai') + chalk.gray(' › '));

    try {
      const result = await client.send(sendOpts);
      lastDot = result.dotPayload;
      console.log('\n');

      if (cfg.showTokens) {
        const usage = result.usage;
        const budgetInfo = client.budgetObject.max
          ? ACCENT(` budget:${client.budgetObject.remaining}rem`)
          : '';
        console.log(
          chalk.dim(`  ↑${usage.input_tokens}tok ↓${usage.output_tokens}tok${budgetInfo}  ${state.mode}/${cfg.lang}`)
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
    setNativeCursorHidden(state, false);
    exitImmersiveScreen();
    cleanupKeybindings();
    console.log(chalk.gray('\n  ' + client.tokenSummary + '\n'));
    process.exit(0);
  });
}

function createUiState(cfg) {
  const idx = MODE_PRESETS.findIndex((p) => p.mode === (cfg.mode || 'build') && p.lang === (cfg.lang || 'zh-CN'));
  const presetIndex = idx >= 0 ? idx : 0;
  const preset = MODE_PRESETS[presetIndex];

  cfg.mode = preset.mode;
  cfg.lang = preset.lang;

  return {
    mode: preset.mode,
    presetIndex,
    composerActive: true,
    askHint: pickRandom(ASK_HINTS),
    tipHint: pickRandom(TIP_HINTS),
    draftInput: '',
    cursorPos: 0,
    pasteInfo: null,      // { lines, chars } when paste detected
    suppressEcho: false,  // true during hidden password input
    nativeCursorHidden: false,
    altScreenActive: false,
    homeLayout: null,
    paletteOpen: false,
    paletteItems: [],
    paletteFiltered: [],
    paletteQuery: '',
    paletteSelection: 0,
    paletteScroll: 0,
    paletteLayout: null,
    paletteBusy: false,
    skipNextLine: false,
  };
}

function enterImmersiveScreen(state) {
  if (!process.stdout.isTTY || state.altScreenActive) {
    return () => {};
  }

  state.altScreenActive = true;
  process.stdout.write(ANSI_ALT_SCREEN_ENTER);
  process.stdout.write('\x1b[2J\x1b[H');

  const restore = () => {
    if (!state.altScreenActive) return;
    state.altScreenActive = false;
    process.stdout.write(ANSI_SHOW_CURSOR);
    process.stdout.write(ANSI_ALT_SCREEN_EXIT);
  };

  const onExit = () => restore();
  process.once('exit', onExit);

  return () => {
    process.removeListener('exit', onExit);
    restore();
  };
}

function setupKeybindings(rl, cfg, state, client) {
  const input = rl.input;

  readline.emitKeypressEvents(input, rl);

  const hadRawMode = Boolean(input.isTTY && input.isRaw);
  if (input.isTTY && !input.isRaw) {
    input.setRawMode(true);
  }

  const onKeypress = (_str, key) => {
    if (!key) return;

    if (key.ctrl && key.name === 'c') {
      rl.close();
      return;
    }

    if (state.paletteOpen) {
      handlePaletteKeypress(_str, key, rl, cfg, state, client);
      return;
    }

    if (!state.paletteOpen && key.ctrl && key.name === 'p') {
      openCommandPalette(rl, cfg, state, client);
      return;
    }

    if (!state.paletteOpen && key.name === 'tab') {
      state.mode = state.mode === 'build' ? 'plan' : 'build';
      cfg.mode = state.mode;
      syncPresetIndex(cfg, state);

      // Prevent inserting a real tab character into the composing input.
      if (typeof rl.line === 'string' && rl.line.includes('\t')) {
        rl.line = rl.line.replace(/\t+/g, '');
        rl.cursor = Math.min(rl.cursor, rl.line.length);
      }

      state.draftInput = rl.line || '';
      state.cursorPos = typeof rl.cursor === 'number' ? rl.cursor : state.draftInput.length;
      renderPanelInline(cfg, state);
      return;
    }

    if (!state.paletteOpen && state.composerActive && shouldRefreshComposer(_str, key)) {
      setImmediate(() => {
        if (state.paletteOpen || !state.composerActive) return;
        const prevLen = state.draftInput.length;
        state.draftInput = rl.line || '';
        state.cursorPos = typeof rl.cursor === 'number' ? rl.cursor : state.draftInput.length;

        const delta = state.draftInput.length - prevLen;
        if (delta > 30) {
          // Burst of >30 chars at once → treat as paste
          const lines = Math.max(1, Math.ceil(state.draftInput.length / 80));
          state.pasteInfo = { lines, chars: state.draftInput.length };
        } else if (delta <= 0) {
          // Deleting / moving — clear paste indicator
          state.pasteInfo = null;
        }

        renderPanelInline(cfg, state);
      });
    }
  };

  input.on('keypress', onKeypress);

  return () => {
    input.off('keypress', onKeypress);
    if (input.isTTY && !hadRawMode) {
      try {
        input.setRawMode(false);
      } catch {
        // ignore
      }
    }
  };
}

function cyclePreset(cfg, state, client) {
  state.presetIndex = (state.presetIndex + 1) % MODE_PRESETS.length;
  const next = MODE_PRESETS[state.presetIndex];

  state.mode = next.mode;
  cfg.mode = next.mode;
  cfg.lang = next.lang;

  if (client.cfg) {
    client.cfg.lang = next.lang;
  }
}

function syncPresetIndex(cfg, state) {
  const idx = MODE_PRESETS.findIndex((p) => p.mode === state.mode && p.lang === cfg.lang);
  state.presetIndex = idx >= 0 ? idx : state.presetIndex;
}

function toggleLanguage(cfg, state, client) {
  cfg.lang = cfg.lang === 'zh-CN' ? 'en' : 'zh-CN';
  if (client.cfg) {
    client.cfg.lang = cfg.lang;
  }
  syncPresetIndex(cfg, state);
  return `language switched to: ${cfg.lang}`;
}

function cycleModel(cfg, client) {
  const models = listModels(cfg.provider);
  if (models.length === 0) {
    return `no model catalog for provider: ${cfg.provider}`;
  }

  const index = models.indexOf(cfg.model);
  const next = models[(index + 1 + models.length) % models.length];

  return setModel(cfg, client, next);
}

function setModel(cfg, client, model) {
  cfg.model = model;
  if (client.cfg) {
    client.cfg.model = model;
  }
  return `model switched to: ${model}`;
}

function switchSession(sessionId, cfg, client) {
  setActiveSession(sessionId);
  const selected = getSessionById(sessionId);
  if (!selected) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  cfg.session = selected.id;
  if (cfg._sessionRef) {
    cfg._sessionRef.id = selected.id;
  }

  client.history = Array.isArray(selected.history) ? [...selected.history] : [];

  if (selected.model) {
    cfg.model = selected.model;
    if (client.cfg) {
      client.cfg.model = selected.model;
    }
  }

  return `session switched: ${selected.id}`;
}

function cycleSession(cfg, client) {
  const sessions = listSessions();
  if (sessions.length === 0) {
    const created = createSession({
      provider: cfg.provider,
      model: cfg.model,
    });
    return switchSession(created.id, cfg, client);
  }

  const index = Math.max(0, sessions.findIndex((s) => s.id === cfg.session));
  const next = sessions[(index + 1) % sessions.length];
  return switchSession(next.id, cfg, client);
}

function printSessionList() {
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log(chalk.gray('  no sessions'));
    return;
  }

  console.log(chalk.bold('\n  sessions\n'));
  for (const s of sessions) {
    const marker = s.active ? '*' : ' ';
    console.log(`  ${marker} ${s.id}  ${s.name}  (${s.turns} turns)`);
  }
  console.log();
}

function printPluginList() {
  const plugins = listPlugins();
  if (plugins.length === 0) {
    console.log(chalk.gray('  no plugins installed'));
    return;
  }

  console.log(chalk.bold('\n  plugins\n'));
  for (const p of plugins) {
    console.log(`  - ${p.module}`);
  }
  console.log();
}

function openCommandPalette(rl, cfg, state, client) {
  state.paletteOpen = true;
  state.ignoreCurrentKeypress = true;
  process.nextTick(() => { state.ignoreCurrentKeypress = false; });
  state.paletteItems = buildPaletteItems(cfg, state, client);
  state.paletteQuery = '';
  state.paletteSelection = 0;
  state.paletteScroll = 0;
  state.paletteLayout = null;
  state.paletteBusy = false;
  updatePaletteFilter(state);
  renderCommandPalette(state);
  clearReadlineBuffer(rl);
}

function openProviderPalette(rl, cfg, state, client) {
  const rows = listProviderStatus(cfg);
  if (rows.length === 0) {
    console.log(chalk.gray('  no providers available'));
    rl.prompt();
    return;
  }

  state.paletteOpen = true;
  state.ignoreCurrentKeypress = true;
  process.nextTick(() => { state.ignoreCurrentKeypress = false; });
  state.paletteItems = rows.map((row) => {
    const readiness = row.chatReady ? 'ready' : 'planned';
    const keyState = row.configured ? 'key' : 'no-key';
    return {
      id: `provider-${row.id}`,
      label: `${row.id} (${readiness})`,
      shortcut: row.active ? 'current' : keyState,
      section: 'Providers',
      run: () => switchProvider(cfg, client, row.id),
    };
  });

  state.paletteQuery = '';
  state.paletteSelection = Math.max(0, rows.findIndex((row) => row.active));
  state.paletteScroll = 0;
  state.paletteLayout = null;
  state.paletteBusy = false;
  updatePaletteFilter(state);
  renderCommandPalette(state);
  clearReadlineBuffer(rl);
}

function openModelPalette(rl, cfg, state, client) {
  const providers = listProviderStatus(cfg);
  const items = [];
  let selectedItemId = null;

  for (const provider of providers) {
    const providerId = provider.id;
    const providerName = provider.name || providerId;
    const providerModels = listModels(providerId);

    items.push({
      id: `model-provider-${providerId}`,
      label: `${providerName} (${providerId})`,
      displayLabel: ACCENT_BOLD(`${providerName} (${providerId})`),
      shortcut: provider.active ? 'current provider' : (provider.chatReady ? 'chat-ready' : 'planned'),
      section: 'Providers',
      run: () => switchProvider(cfg, client, providerId),
    });

    for (const modelId of providerModels) {
      const modelFamily = getModelFamilyLabel(providerId, modelId);
      const isActiveModel = cfg.provider === providerId && cfg.model === modelId;
      const itemId = `model-${providerId}-${modelId}`;

      items.push({
        id: itemId,
        label: `${providerName} ${modelFamily} ${modelId}`,
        displayLabel: `${ACCENT('  •')} ${ACCENT_SOFT(modelFamily)} ${chalk.gray(modelId)}`,
        shortcut: isActiveModel ? 'current model' : '',
        section: `${providerName} models`,
        run: () => setProviderAndModel(cfg, client, providerId, modelId),
      });

      if (isActiveModel) {
        selectedItemId = itemId;
      }
    }
  }

  if (items.length === 0) {
    console.log(chalk.gray('  no providers or model catalogs available'));
    rl.prompt();
    return;
  }

  state.paletteOpen = true;
  state.ignoreCurrentKeypress = true;
  process.nextTick(() => { state.ignoreCurrentKeypress = false; });
  state.paletteItems = items;
  state.paletteQuery = '';
  state.paletteSelection = Math.max(
    0,
    state.paletteItems.findIndex((item) => item.id === selectedItemId)
  );
  state.paletteScroll = 0;
  state.paletteLayout = null;
  state.paletteBusy = false;
  updatePaletteFilter(state);
  renderCommandPalette(state);
  clearReadlineBuffer(rl);
}

function closeCommandPalette(rl, cfg, state) {
  state.paletteOpen = false;
  state.paletteQuery = '';
  state.paletteFiltered = [];
  state.paletteSelection = 0;
  state.paletteScroll = 0;
  state.paletteLayout = null;
  state.paletteBusy = false;
  renderHomeUi(cfg, state);
  clearReadlineBuffer(rl);
  rl.setPrompt(ASK_PROMPT);
  rl.prompt();
}

function buildPaletteItems(cfg, state, client) {
  const items = [
    {
      id: 'switch-session',
      label: 'Switch session',
      shortcut: 'ctrl+x l',
      section: 'Suggested',
      run: () => cycleSession(cfg, client),
    },
    {
      id: 'switch-model',
      label: 'Switch model',
      shortcut: 'ctrl+x m',
      section: 'Suggested',
      run: () => cycleModel(cfg, client),
    },
    {
      id: 'open-model-picker',
      label: 'Open model picker',
      shortcut: '/models',
      section: 'Suggested',
      run: () => 'run /models to pick from available models',
    },
    {
      id: 'open-provider-picker',
      label: 'Open provider picker',
      shortcut: '/providers',
      section: 'Suggested',
      run: () => 'run /providers to pick from available providers',
    },
    {
      id: 'set-key-secure',
      label: 'Set API key securely',
      shortcut: '/key',
      section: 'Suggested',
      run: () => `run /key ${cfg.provider} to add key for ${cfg.provider}`,
    },
    {
      id: 'new-session',
      label: 'New session',
      shortcut: 'ctrl+x n',
      section: 'Session',
      run: () => {
        const created = createSession({ provider: cfg.provider, model: cfg.model });
        return switchSession(created.id, cfg, client);
      },
    },
    {
      id: 'list-sessions',
      label: 'List sessions',
      shortcut: 'ctrl+x s',
      section: 'Session',
      run: () => {
        printSessionList();
        return 'session list shown';
      },
    },
    {
      id: 'toggle-mode',
      label: 'Toggle mode (build/plan)',
      shortcut: 'tab',
      section: 'Prompt',
      run: () => {
        state.mode = state.mode === 'build' ? 'plan' : 'build';
        cfg.mode = state.mode;
        syncPresetIndex(cfg, state);
        return `mode switched to: ${state.mode}`;
      },
    },
    {
      id: 'toggle-language',
      label: 'Toggle language',
      shortcut: 'ctrl+l',
      section: 'Prompt',
      run: () => toggleLanguage(cfg, state, client),
    },
    {
      id: 'skills',
      label: 'Skills',
      shortcut: '',
      section: 'Prompt',
      run: () => {
        console.log(chalk.bold('\n  skills\n'));
        console.log('  - debug-fixer');
        console.log('  - code-review');
        console.log('  - spec-writer');
        console.log();
        return 'skills shown';
      },
    },
    {
      id: 'plugins',
      label: 'Plugins',
      shortcut: 'plugin_manager',
      section: 'System',
      run: () => {
        printPluginList();
        return 'plugins shown';
      },
    },
    {
      id: 'hide-tips',
      label: 'Hide tips',
      shortcut: 'ctrl+x h',
      section: 'System',
      run: () => {
        cfg.showTips = false;
        saveGlobalConfig({ showTips: false });
        return 'tips hidden';
      },
    },
    {
      id: 'view-status',
      label: 'View status',
      shortcut: 'ctrl+x s',
      section: 'System',
      run: () => {
        console.log(ACCENT_BOLD('\n  status\n'));
        console.log(ACCENT(`  provider: ${cfg.provider}`));
        console.log(ACCENT(`  model: ${cfg.model}`));
        console.log(ACCENT(`  mode: ${state.mode}`));
        console.log(ACCENT(`  lang: ${cfg.lang}`));
        console.log(ACCENT(`  session: ${cfg.session || 'none'}`));
        console.log();
        return 'status shown';
      },
    },
    {
      id: 'help',
      label: 'Help',
      shortcut: '',
      section: 'System',
      run: () => 'type /help to see all slash commands',
    },
    {
      id: 'exit',
      label: 'Exit the app',
      shortcut: 'esc',
      section: 'System',
      run: () => ({ exit: true, message: 'bye!' }),
    },
  ];

  const modelItems = listProviderStatus(cfg).flatMap((row) => {
    const providerId = row.id;
    const providerName = row.name || providerId;
    return listModels(providerId).map((model) => ({
      id: `use-model-${providerId}-${model}`,
      label: `Use ${providerName} / ${getModelFamilyLabel(providerId, model)}`,
      shortcut: cfg.provider === providerId && cfg.model === model ? 'current' : '',
      section: 'Models',
      run: () => setProviderAndModel(cfg, client, providerId, model),
    }));
  });

  const providerItems = listProviderStatus(cfg).map((row) => ({
    id: `use-provider-${row.id}`,
    label: `Use ${row.id}`,
    shortcut: row.active ? 'current' : (row.configured ? 'key' : 'no-key'),
    section: 'Providers',
    run: () => switchProvider(cfg, client, row.id),
  }));

  return items.concat(modelItems, providerItems);
}

function handlePaletteKeypress(str, key, rl, cfg, state, _client) {
  if (state.paletteBusy) return;
  if (state.ignoreCurrentKeypress) return;

  if (key.name === 'escape') {
    closeCommandPalette(rl, cfg, state);
    return;
  }

  if (key.name === 'up') {
    if (state.paletteFiltered.length > 0) {
      state.paletteSelection = Math.max(0, state.paletteSelection - 1);
      renderCommandPaletteViewportInline(state);
    }
    return;
  }

  if (key.name === 'down') {
    if (state.paletteFiltered.length > 0) {
      state.paletteSelection = Math.min(state.paletteFiltered.length - 1, state.paletteSelection + 1);
      renderCommandPaletteViewportInline(state);
    }
    return;
  }

  if (key.name === 'backspace') {
    state.paletteQuery = state.paletteQuery.slice(0, -1);
    updatePaletteFilter(state);
    renderCommandPalette(state);
    clearReadlineBuffer(rl);
    return;
  }

  if (key.name === 'return' || key.name === 'enter') {
    state.skipNextLine = true;
    void executePaletteSelection(rl, cfg, state);
    return;
  }

  if (isPrintableInput(str, key)) {
    state.paletteQuery += str;
    updatePaletteFilter(state);
    renderCommandPalette(state);
    clearReadlineBuffer(rl);
  }
}

async function executePaletteSelection(rl, cfg, state) {
  const picked = state.paletteFiltered[state.paletteSelection];
  if (!picked) {
    return;
  }

  state.paletteBusy = true;

  try {
    const result = await picked.run();

    if (result && typeof result === 'object' && result.exit) {
      console.log(chalk.gray(`  ${result.message || 'bye!'}`));
      rl.close();
      return;
    }

    state.paletteBusy = false;
    closeCommandPalette(rl, cfg, state);

    if (typeof result === 'string' && result) {
      console.log(ACCENT_BOLD(`  ${result}`));
    }
  } catch (err) {
    state.paletteBusy = false;
    closeCommandPalette(rl, cfg, state);
    console.log(chalk.red(`  ${err.message}`));
  }
}

function updatePaletteFilter(state) {
  const q = state.paletteQuery.trim().toLowerCase();
  if (!q) {
    state.paletteFiltered = [...state.paletteItems];
  } else {
    state.paletteFiltered = state.paletteItems.filter((item) => {
      return (
        item.label.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q) ||
        item.section.toLowerCase().includes(q)
      );
    });
  }

  state.paletteScroll = 0;

  if (state.paletteFiltered.length === 0) {
    state.paletteSelection = 0;
    return;
  }

  if (state.paletteSelection >= state.paletteFiltered.length) {
    state.paletteSelection = state.paletteFiltered.length - 1;
  }
}

function isPrintableInput(str, key) {
  if (!str) return false;
  if (key && (key.ctrl || key.meta)) return false;
  const code = str.charCodeAt(0);
  return code >= 32 && code !== 127;
}

function shouldRefreshComposer(str, key) {
  if (isPrintableInput(str, key)) return true;
  if (!key || !key.name) return false;
  return ['backspace', 'delete', 'left', 'right', 'home', 'end', 'up', 'down'].includes(key.name);
}

function clearReadlineBuffer(rl) {
  try {
    rl.write('', { ctrl: true, name: 'u' });
  } catch {
    // ignore
  }
}

function renderCommandPalette(state) {
  setNativeCursorHidden(state, true);

  const layout = buildPaletteLayout();
  state.paletteLayout = layout;

  const backdrop = (content = '') => chalk.bgBlack(padToVisible(content, layout.width));
  const canvas = Array.from({ length: layout.rows }, () => backdrop(''));
  const setRow = (rowNumber, text) => {
    if (rowNumber < 1 || rowNumber > layout.rows) return;
    canvas[rowNumber - 1] = backdrop(text);
  };

  setRow(layout.panelTopRow, formatPalettePanelLine(layout, alignRow(chalk.bold('Commands'), chalk.gray('esc'), layout.bodyWidth)));
  setRow(layout.panelTopRow + 1, formatPalettePanelLine(layout, ''));
  const searchLabel = state.paletteQuery
    ? `${ACCENT('Search')} ${state.paletteQuery}`
    : `${ACCENT('Search')} ${chalk.gray('type to filter...')}`;
  setRow(layout.panelTopRow + 2, formatPalettePanelLine(layout, searchLabel));
  setRow(layout.panelTopRow + 4, formatPalettePanelLine(layout, ''));

  const viewport = buildPaletteViewportRows(state, layout);
  setRow(layout.helpRow, formatPalettePanelLine(layout, viewport.helpLabel));

  for (let i = 0; i < layout.listRowCount; i += 1) {
    setRow(layout.listStartRow + i, viewport.lines[i] || formatPalettePanelLine(layout, ''));
  }

  process.stdout.write('\x1b[2J\x1b[H' + canvas.join('\n'));
}

function renderCommandPaletteViewportInline(state) {
  if (!state.paletteOpen || !state.paletteLayout) {
    return;
  }

  const layout = state.paletteLayout;
  const currentWidth = process.stdout.columns || 100;
  const currentRows = process.stdout.rows || 36;
  if (layout.width !== currentWidth || layout.rows !== currentRows) {
    renderCommandPalette(state);
    return;
  }

  const backdrop = (content = '') => chalk.bgBlack(padToVisible(content, layout.width));
  const viewport = buildPaletteViewportRows(state, layout);

  process.stdout.write('\x1b7');
  drawPaletteRowInline(layout, layout.helpRow, backdrop(formatPalettePanelLine(layout, viewport.helpLabel)));
  for (let i = 0; i < layout.listRowCount; i += 1) {
    const row = layout.listStartRow + i;
    const line = viewport.lines[i] || formatPalettePanelLine(layout, '');
    drawPaletteRowInline(layout, row, backdrop(line));
  }
  process.stdout.write('\x1b8');
}

function buildPaletteLayout() {
  const width = process.stdout.columns || 100;
  const rows = process.stdout.rows || 36;
  const panelWidth = Math.max(64, Math.min(98, width - 8));
  const bodyWidth = panelWidth - 4;
  const padLeft = Math.max(2, Math.floor((width - panelWidth) / 2));
  const panelTopRow = Math.max(2, Math.floor((rows - 24) / 2));
  const helpRow = panelTopRow + 3;
  const listStartRow = panelTopRow + 5;
  const listRowCount = Math.max(1, rows - listStartRow - 1);

  return {
    width,
    rows,
    panelWidth,
    bodyWidth,
    padLeft,
    panelTopRow,
    helpRow,
    listStartRow,
    listRowCount,
  };
}

function buildPaletteRenderEntries(state, bodyWidth) {
  const grouped = groupBySection(state.paletteFiltered);
  const selectedItemId = state.paletteFiltered[state.paletteSelection]?.id;
  const entries = [];
  let selectedEntryIndex = -1;
  let itemIndex = 0;

  for (const [section, items] of Object.entries(grouped)) {
    entries.push({ kind: 'section', content: ACCENT_BOLD(section), selected: false });

    for (const item of items) {
      itemIndex += 1;
      const indexLabel = String(itemIndex).padStart(2, '0');
      const leftLabel = item.displayLabel || item.label;
      const left = `${chalk.bold(indexLabel)} ${leftLabel}`;
      const right = item.shortcut ? ACCENT_SOFT(item.shortcut) : '';
      const selected = item.id === selectedItemId;

      entries.push({
        kind: 'item',
        content: alignRow(left, right, bodyWidth),
        selected,
      });

      if (selected) {
        selectedEntryIndex = entries.length - 1;
      }
    }

    entries.push({ kind: 'spacer', content: '', selected: false });
  }

  if (entries.length > 0 && entries[entries.length - 1].kind === 'spacer') {
    entries.pop();
  }

  return { entries, selectedEntryIndex };
}

function syncPaletteScroll(state, entriesLength, selectedEntryIndex, listRowCount) {
  const maxScroll = Math.max(0, entriesLength - listRowCount);
  let nextScroll = Math.max(0, Math.min(state.paletteScroll || 0, maxScroll));

  if (selectedEntryIndex >= 0) {
    if (selectedEntryIndex < nextScroll) {
      nextScroll = selectedEntryIndex;
    }
    if (selectedEntryIndex >= nextScroll + listRowCount) {
      nextScroll = selectedEntryIndex - listRowCount + 1;
    }
  }

  state.paletteScroll = Math.max(0, Math.min(nextScroll, maxScroll));
}

function buildPaletteViewportRows(state, layout) {
  const { entries, selectedEntryIndex } = buildPaletteRenderEntries(state, layout.bodyWidth);

  if (entries.length === 0) {
    state.paletteScroll = 0;
    const lines = Array.from({ length: layout.listRowCount }, (_x, i) => {
      const content = i === 0 ? ACCENT_SOFT('No matching commands') : '';
      return formatPalettePanelLine(layout, content);
    });

    return {
      lines,
      helpLabel: ACCENT_SOFT('Use ↑↓ to navigate, Enter to run · 0 results'),
    };
  }

  syncPaletteScroll(state, entries.length, selectedEntryIndex, layout.listRowCount);

  const start = state.paletteScroll;
  const end = Math.min(entries.length, start + layout.listRowCount);
  const lines = [];

  for (let i = 0; i < layout.listRowCount; i += 1) {
    const entry = entries[start + i];
    if (!entry) {
      lines.push(formatPalettePanelLine(layout, ''));
      continue;
    }

    lines.push(
      formatPalettePanelLine(layout, entry.content, { selected: entry.kind === 'item' && entry.selected })
    );
  }

  const selectedLabel = `${Math.max(0, state.paletteSelection + 1)}/${state.paletteFiltered.length}`;
  const viewLabel = entries.length > layout.listRowCount
    ? `${start + 1}-${end}/${entries.length}`
    : `${entries.length}`;

  return {
    lines,
    helpLabel: ACCENT_SOFT(`Use ↑↓ to navigate, Enter to run · ${selectedLabel} · view ${viewLabel}`),
  };
}

function formatPalettePanelLine(layout, content, { selected = false } = {}) {
  const pad = ' '.repeat(layout.padLeft);
  const body = padToVisible(content, layout.bodyWidth);
  if (selected) {
    // Strip existing colors so they don't clash with the highlight background
    const cleanBody = stripAnsi(body);
    return `${pad}${chalk.bgHex(THEME_HEX).white.bold(`  ${cleanBody}  `)}`;
  }
  return `${pad}${chalk.bgHex('#111317')(`  ${body}  `)}`;
}

function drawPaletteRowInline(layout, row, content) {
  if (row < 1 || row > layout.rows) {
    return;
  }
  process.stdout.write(`\x1b[${row};1H`);
  process.stdout.write(content);
}

function groupBySection(items) {
  const grouped = {};
  for (const item of items) {
    if (!grouped[item.section]) grouped[item.section] = [];
    grouped[item.section].push(item);
  }
  return grouped;
}

function getModelFamilyLabel(providerId, modelId) {
  const id = String(modelId || '');
  const lower = id.toLowerCase();

  if (providerId === 'anthropic') {
    if (lower.includes('opus')) return 'opus';
    if (lower.includes('sonnet')) return 'sonnet';
    if (lower.includes('haiku')) return 'haiku';
  }

  if (providerId === 'google' && lower.startsWith('gemini-')) {
    return lower.replace(/^gemini-/, 'gemini ');
  }

  if (providerId === 'zai' && lower.startsWith('glm-')) {
    return lower.replace(/^glm-/, 'glm ');
  }

  return id;
}

function setProviderAndModel(cfg, client, providerId, modelId) {
  switchProvider(cfg, client, providerId);
  setModel(cfg, client, modelId);
  return `switched to ${providerId}/${modelId}`;
}

function progressBar(used, max, width) {
  const pct   = Math.min(1, used / max);
  const filled = Math.round(pct * width);
  const empty  = width - filled;
  return ACCENT('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}

function switchProvider(cfg, client, providerInput) {
  const providerId = normalizeProviderId(providerInput || cfg.provider);
  if (!providerId) {
    const available = Object.keys(getProviderMap()).join(', ');
    throw new Error(`unknown provider: ${providerInput} (available: ${available})`);
  }

  cfg.provider = providerId;
  if (client.cfg) {
    client.cfg.provider = providerId;
  }

  const models = listModels(providerId);
  if (models.length > 0 && !models.includes(cfg.model)) {
    cfg.model = models[0];
    if (client.cfg) {
      client.cfg.model = models[0];
    }
  }

  const hasKey = Boolean(getProviderApiKey(cfg, providerId));
  const def = getProviderDefinition(providerId);
  const runtime = def?.chatReady ? 'chat-ready' : 'planned';
  const keyHint = hasKey
    ? 'key configured'
    : `missing key (run: /key ${providerId})`;

  return `provider switched to: ${providerId} | ${runtime} | ${keyHint}`;
}

async function promptAndSetApiKey(rl, cfg, state, client, providerInput, { persist = false } = {}) {
  const providerId = normalizeProviderId(providerInput || cfg.provider);
  if (!providerId) {
    const available = Object.keys(getProviderMap()).join(', ');
    throw new Error(`unknown provider: ${providerInput} (available: ${available})`);
  }

  const def = getProviderDefinition(providerId);
  if (!def) {
    throw new Error(`unknown provider: ${providerId}`);
  }

  const key = await promptHiddenInput(
    rl,
    cfg,
    state,
    `  Enter ${def.name} API key (hidden): `
  );

  if (!key) {
    renderHomeUi(cfg, state);
    rl.prompt();
    return 'API key setup cancelled';
  }

  cfg[def.keyField] = key;
  if (def.envKey) {
    process.env[def.envKey] = key;
  }

  if (client.cfg) {
    client.cfg[def.keyField] = key;
  }

  // Refresh active runtime provider client immediately when possible.
  if (providerId === 'anthropic') {
    cfg.apiKey = key;
    if (client.cfg) {
      client.cfg.apiKey = key;
    }
  }
  if (typeof client.setApiKey === 'function') {
    client.setApiKey(key, providerId);
  }

  if (persist) {
    saveGlobalConfig({ [def.keyField]: key });
    renderHomeUi(cfg, state);
    return `saved API key for ${providerId} to ~/.zipairc`;
  }

  renderHomeUi(cfg, state);
  return `API key set for ${providerId} (session only, not written to disk)`;
}

async function promptHiddenInput(rl, cfg, state, promptText) {
  const wasComposerActive = state.composerActive;
  const wasPaletteOpen = state.paletteOpen;

  state.composerActive = false;
  state.paletteOpen = false;
  state.suppressEcho = true;
  setNativeCursorHidden(state, false);

  // Show the prompt label directly on stdout (bypasses the null sink)
  process.stdout.write(promptText);

  try {
    const answer = await new Promise((resolve) => {
      rl.once('line', resolve);
    });
    return String(answer || '').trim();
  } finally {
    state.suppressEcho = false;
    state.composerActive = wasComposerActive;
    state.paletteOpen = wasPaletteOpen;
    state.draftInput = '';
    state.cursorPos = 0;

    if (state.composerActive || state.paletteOpen) {
      setNativeCursorHidden(state, true);
    } else {
      setNativeCursorHidden(state, false);
    }

    if (state.composerActive) {
      renderHomeUi(cfg, state);
    }
  }
}

function renderHomeUi(cfg, state) {
  setNativeCursorHidden(state, true);

  const width = process.stdout.columns || 100;
  const rows = process.stdout.rows || 36;
  const panelWidth = Math.max(56, Math.min(92, width - 16));
  const bodyWidth = panelWidth - 4;
  const padLeft = Math.max(2, Math.floor((width - panelWidth) / 2));

  const dynamic = buildHomeDynamicLines(cfg, state, bodyWidth);
  const backdrop = (content = '') => chalk.bgBlack(padToVisible(content, width));
  const canvas = Array.from({ length: rows }, () => backdrop(''));
  const setRow = (rowNumber, text) => {
    if (rowNumber < 1 || rowNumber > rows) return;
    canvas[rowNumber - 1] = backdrop(text);
  };

  // ── PANEL HELPERS ──────────────────────────────────────────────────────
  const bg = (text) => chalk.bgHex('#1b1d21')(text);
  const panel = (content) => {
    const pad = ' '.repeat(padLeft);
    const body = padToVisible(centerLine(content, bodyWidth), bodyWidth);
    return `${pad}${ACCENT('|')}${bg(` ${body} `)}${ACCENT('|')}`;
  };

  // ── SECTION 2: INPUT AREA — panel height grows with input ────────────
  // panelRows = 1 top-pad + N ask lines + 1 bottom-pad + 1 status + 1 status-pad
  const askLines = dynamic.askLines;            // array, length >= 1
  const panelRows = 1 + askLines.length + 1 + 1 + 1;

  // ── SECTION 1: HEADER (logo) — centered in the space above footer ─────
  const centerBlockHeight = LOGO_LINES.length + 1 + panelRows;
  const usableRows = rows - 5;                  // reserve 5 for footer
  const topPadding = Math.max(1, Math.floor((usableRows - centerBlockHeight) / 2));

  const logoStartRow = topPadding + 1;
  for (let i = 0; i < LOGO_LINES.length; i += 1) {
    const logoColor = chalk.bold.hex(THEME_HEX);
    setRow(logoStartRow + i, centerLine(logoColor(LOGO_LINES[i]), width));
  }

  const panelStartRow = logoStartRow + LOGO_LINES.length + 1; // 1 spacer after logo
  const askPadTopRow  = panelStartRow;
  const askStartRow   = panelStartRow + 1;      // first ask line
  const askPadBotRow  = askStartRow + askLines.length;
  const statusRow     = askPadBotRow + 1;
  const statusPadRow  = askPadBotRow + 2;

  setRow(askPadTopRow, panel(''));
  for (let i = 0; i < askLines.length; i += 1) {
    setRow(askStartRow + i, panel(askLines[i]));
  }
  setRow(askPadBotRow, panel(''));
  setRow(statusRow, panel(dynamic.statusLine));
  setRow(statusPadRow, panel(''));

  // ── SECTION 3: FOOTER — anchored to bottom ────────────────────────────
  const footerRow1 = rows - 3;
  const footerRow2 = rows - 1;
  const footerRow3 = rows;

  const hintLeft = `${ACCENT('tab')} ${chalk.gray('agents')}`;
  const hintRight = `${ACCENT('ctrl+p')} ${chalk.gray('commands')}`;
  setRow(footerRow1, alignRow(`  ${hintLeft}`, `${hintRight}  `, width));
  setRow(footerRow2, '');
  setRow(footerRow3, `  ${ACCENT('●')} ${ACCENT('Tip:')} ${chalk.gray(state.tipHint)}`);

  // ── SAVE LAYOUT for inline updates ────────────────────────────────────
  state.homeLayout = {
    width, rows, bodyWidth, padLeft,
    askPadTopRow,
    askStartRow,
    askLineCount: askLines.length,
    askPadBotRow,
    statusRow,
    statusPadRow,
    footerRow1, footerRow2, footerRow3,
  };

  process.stdout.write('\x1b[2J\x1b[H' + canvas.join('\n'));
}

function buildHomeDynamicLines(cfg, state, bodyWidth) {
  const providerLabel = formatProviderLabel(cfg.provider);
  const modeLabel = state.mode === 'plan' ? 'Plan' : 'Build';
  const askLines = formatAskLines(state, bodyWidth);
  const statusLine = `${ACCENT(modeLabel)} ${chalk.gray('|')} ${ACCENT_SOFT(cfg.model)} ${chalk.gray('|')} ${ACCENT(providerLabel)}`;

  return { askLines, statusLine };
}

function buildHomePanelLine(state, content) {
  if (!state.homeLayout) return content;
  const { bodyWidth, padLeft } = state.homeLayout;
  const pad = ' '.repeat(padLeft);
  const bg = (text) => chalk.bgHex('#1b1d21')(text);
  const body = padToVisible(centerLine(content, bodyWidth), bodyWidth);
  return `${pad}${ACCENT('|')}${bg(` ${body} `)}${ACCENT('|')}`;
}

/**
 * Redraw all panel rows atomically in a single stdout.write.
 * If the number of ask-lines changed (user typed/pasted enough to wrap),
 * trigger a full renderHomeUi instead so the whole canvas stays consistent.
 */
function renderPanelInline(cfg, state) {
  if (!state.composerActive || state.paletteOpen || !state.homeLayout) return;

  const { bodyWidth, width, askPadTopRow, askStartRow, askLineCount, askPadBotRow, statusRow, statusPadRow } = state.homeLayout;
  const dynamic = buildHomeDynamicLines(cfg, state, bodyWidth);
  const newAskLines = dynamic.askLines;

  // Line count changed → full redraw to reposition everything
  if (newAskLines.length !== askLineCount) {
    renderHomeUi(cfg, state);
    return;
  }

  const bg = (content) => chalk.bgBlack(padToVisible(content, width));
  const empty = bg(buildHomePanelLine(state, ''));
  const status = bg(buildHomePanelLine(state, dynamic.statusLine));

  let buf = '\x1b7';
  buf += `\x1b[${askPadTopRow};1H${empty}`;
  for (let i = 0; i < newAskLines.length; i += 1) {
    buf += `\x1b[${askStartRow + i};1H${bg(buildHomePanelLine(state, newAskLines[i]))}`;
  }
  buf += `\x1b[${askPadBotRow};1H${empty}`;
  buf += `\x1b[${statusRow};1H${status}`;
  buf += `\x1b[${statusPadRow};1H${empty}`;
  buf += '\x1b8';

  process.stdout.write(buf);
}

function formatProviderLabel(provider) {
  if (provider === 'zai') return 'Z.AI';
  if (!provider) return 'unknown';
  return String(provider);
}

function formatLangLabel(lang) {
  const match = MODE_PRESETS.find((preset) => preset.lang === lang);
  return match ? match.langLabel : String(lang || 'unknown');
}

/**
 * Returns an array of styled lines for the input panel.
 * - Empty input → [placeholder] (1 line)
 * - Paste detected → [compact paste indicator] (1 line)
 * - Typed text → wrapped across as many lines as needed
 */
function formatAskLines(state, bodyWidth) {
  const askHint = state.askHint || 'Fix broken tests';
  const cursorChar = chalk.bgWhite.black('A');
  const placeholder = [`${cursorChar}${ACCENT('sk anything...')} ${chalk.gray(`"${askHint}"`)}`];

  if (!state.composerActive) return placeholder;

  const rawInput = String(state.draftInput || '');
  if (!rawInput) return placeholder;

  // Paste indicator: compact summary instead of wrapping potentially huge text
  if (state.pasteInfo) {
    const { lines, chars } = state.pasteInfo;
    const preview = rawInput.slice(0, Math.min(24, bodyWidth - 26));
    const ellipsis = rawInput.length > preview.length ? '…' : '';
    return [
      `${ACCENT_BOLD('[Pasted')} ${chalk.white(`~${lines} line${lines === 1 ? '' : 's'}, ${chars} chars`)}${ACCENT_BOLD(']')} ${chalk.gray(preview)}${ellipsis}`,
    ];
  }

  // Wrap typed text across panel width with inline cursor
  return wrapInputLines(rawInput, state.cursorPos, Math.max(8, bodyWidth - 2));
}

/** Split raw input into panel-width chunks, placing the block cursor inline. */
function wrapInputLines(raw, cursorPos, maxWidth) {
  const safeCursor = Math.max(0, Math.min(
    Number.isInteger(cursorPos) ? cursorPos : raw.length,
    raw.length
  ));

  const chunks = [];
  let i = 0;
  while (i < raw.length) {
    chunks.push(raw.slice(i, i + maxWidth));
    i += maxWidth;
  }
  if (chunks.length === 0) chunks.push('');

  const cursorChunk = Math.floor(safeCursor / maxWidth);
  const cursorCol   = safeCursor % maxWidth;

  return chunks.map((chunk, idx) => {
    if (idx !== cursorChunk) return chalk.white(chunk);
    const before    = chunk.slice(0, cursorCol);
    const atCursor  = chunk[cursorCol];
    const after     = chunk.slice(cursorCol + 1);
    const glyph     = atCursor ? chalk.bgWhite.black(atCursor) : ACCENT_BOLD('▌');
    return chalk.white(before) + glyph + chalk.white(after);
  });
}

function formatComposerLine(state, bodyWidth) {
  const prefix = ACCENT('Write >');
  if (!state.composerActive) {
    return `${prefix} ${chalk.gray('type /ui to reopen input panel')}`;
  }

  const maxInputLen = Math.max(8, bodyWidth - visibleLength(prefix) - 2);
  const rawInput = String(state.draftInput || '');
  if (!rawInput) {
    return `${prefix} ${chalk.gray('type your message here ')}${ACCENT_BOLD('▌')}`;
  }

  const withCaret = clipInputAroundCursor(rawInput, state.cursorPos, maxInputLen);
  return `${prefix} ${withCaret}`;
}

function clipInputAroundCursor(text, cursorPos, maxLen) {
  const raw = String(text || '');
  const safeCursor = Math.max(0, Math.min(Number.isInteger(cursorPos) ? cursorPos : raw.length, raw.length));
  const caretToken = '\u0000';

  const maxRawLen = Math.max(1, maxLen - 1);
  if (raw.length <= maxRawLen) {
    const composed = raw.slice(0, safeCursor) + caretToken + raw.slice(safeCursor);
    return composed.replace(caretToken, ACCENT_BOLD('▌'));
  }

  let start = safeCursor - Math.floor(maxRawLen / 2);
  start = Math.max(0, Math.min(start, raw.length - maxRawLen));
  const end = start + maxRawLen;

  const segment = raw.slice(start, end);
  const localCursor = safeCursor - start;
  let composed = segment.slice(0, localCursor) + caretToken + segment.slice(localCursor);

  if (start > 0) {
    composed = `…${composed.slice(1)}`;
  }
  if (end < raw.length) {
    composed = `${composed.slice(0, -1)}…`;
  }

  return composed.replace(caretToken, ACCENT_BOLD('▌'));
}

function setNativeCursorHidden(state, hidden) {
  if (!process.stdout.isTTY) return;
  if (Boolean(state.nativeCursorHidden) === hidden) return;
  state.nativeCursorHidden = hidden;
  process.stdout.write(hidden ? ANSI_HIDE_CURSOR : ANSI_SHOW_CURSOR);
}

function centerLine(line, width) {
  const len = visibleLength(line);
  const left = Math.max(0, Math.floor((width - len) / 2));
  return `${' '.repeat(left)}${line}`;
}

function alignRow(left, right, width) {
  const gap = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return `${left}${' '.repeat(gap)}${right}`;
}

function padToVisible(text, width) {
  const len = visibleLength(text);
  if (len >= width) return text;
  return text + ' '.repeat(width - len);
}

function visibleLength(text) {
  return stripAnsi(text).length;
}

function stripAnsi(text) {
  return String(text).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}
