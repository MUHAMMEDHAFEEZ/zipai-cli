/**
 * Interactive REPL — chat mode for zipai.
 * Supports multi-turn conversation with token tracking.
 */

import * as readline from 'readline';
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
  '/models':  'Open model picker',
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

export async function startRepl(client, cfg) {
  const state = createUiState(cfg);

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: ASK_PROMPT,
    completer: (line) => [[], line],
  });

  // While custom UI is active, we render input ourselves inside the panel.
  const defaultWriteToOutput = typeof rl._writeToOutput === 'function'
    ? rl._writeToOutput.bind(rl)
    : null;
  if (defaultWriteToOutput) {
    rl._writeToOutput = (chunk) => {
      if (state.composerActive || state.paletteOpen) return;
      defaultWriteToOutput(chunk);
    };
  }

  const cleanupKeybindings = setupKeybindings(rl, cfg, state, client);

  renderHomeUi(cfg, state);

  rl.prompt();

  let pendingFile = null;
  let lastDot     = null;

  const exitRepl = () => {
    setNativeCursorHidden(state, false);
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
    draftInput: '',
    cursorPos: 0,
    nativeCursorHidden: false,
    paletteOpen: false,
    paletteItems: [],
    paletteFiltered: [],
    paletteQuery: '',
    paletteSelection: 0,
    paletteBusy: false,
    skipNextLine: false,
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
      cyclePreset(cfg, state, client);
      renderHomeUi(cfg, state);
      rl.setPrompt(ASK_PROMPT);
      rl.prompt();
      return;
    }

    if (!state.paletteOpen && state.composerActive && shouldRefreshComposer(_str, key)) {
      setImmediate(() => {
        if (state.paletteOpen || !state.composerActive) return;
        state.draftInput = rl.line || '';
        state.cursorPos = typeof rl.cursor === 'number' ? rl.cursor : state.draftInput.length;
        renderHomeUi(cfg, state);
        rl.prompt(true);
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
  state.paletteItems = buildPaletteItems(cfg, state, client);
  state.paletteQuery = '';
  state.paletteSelection = 0;
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
  state.paletteBusy = false;
  updatePaletteFilter(state);
  renderCommandPalette(state);
  clearReadlineBuffer(rl);
}

function openModelPalette(rl, cfg, state, client) {
  const models = listModels(cfg.provider);
  if (models.length === 0) {
    console.log(chalk.gray(`  no model catalog for provider: ${cfg.provider}`));
    rl.prompt();
    return;
  }

  state.paletteOpen = true;
  state.paletteItems = models.map((model) => ({
    id: `model-${model}`,
    label: model,
    shortcut: cfg.model === model ? 'current' : '',
    section: `Models (${cfg.provider})`,
    run: () => setModel(cfg, client, model),
  }));
  state.paletteQuery = '';
  state.paletteSelection = Math.max(0, models.indexOf(cfg.model));
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

  const modelItems = listModels(cfg.provider).map((model) => ({
    id: `use-model-${model}`,
    label: `Use ${model}`,
    shortcut: cfg.model === model ? 'current' : '',
    section: 'Models',
    run: () => setModel(cfg, client, model),
  }));

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

  if (key.name === 'escape') {
    closeCommandPalette(rl, cfg, state);
    return;
  }

  if (key.name === 'up') {
    if (state.paletteFiltered.length > 0) {
      state.paletteSelection = Math.max(0, state.paletteSelection - 1);
      renderCommandPalette(state);
    }
    return;
  }

  if (key.name === 'down') {
    if (state.paletteFiltered.length > 0) {
      state.paletteSelection = Math.min(state.paletteFiltered.length - 1, state.paletteSelection + 1);
      renderCommandPalette(state);
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

  const width = process.stdout.columns || 100;
  const panelWidth = Math.max(64, Math.min(98, width - 8));
  const bodyWidth = panelWidth - 4;
  const padLeft = Math.max(2, Math.floor((width - panelWidth) / 2));
  const pad = ' '.repeat(padLeft);

  const bg = (text) => chalk.bgHex('#111317')(text);
  const panel = (content) => {
    const body = padToVisible(content, bodyWidth);
    return `${pad}${bg(`  ${body}  `)}`;
  };

  const grouped = groupBySection(state.paletteFiltered);

  process.stdout.write('\x1b[2J\x1b[H');
  console.log();
  console.log(panel(alignRow(chalk.bold('Commands'), chalk.gray('esc'), bodyWidth)));
  console.log(panel(''));
  const searchLabel = state.paletteQuery
    ? `${ACCENT('Search')} ${state.paletteQuery}`
    : `${ACCENT('Search')} ${chalk.gray('type to filter...')}`;
  console.log(panel(searchLabel));
  console.log(panel(ACCENT_SOFT('Use ↑↓ to navigate, Enter to run')));
  console.log(panel(''));

  if (state.paletteFiltered.length === 0) {
    console.log(panel(ACCENT_SOFT('No matching commands')));
    console.log(panel(''));
    return;
  }

  let itemIndex = 0;
  for (const [section, items] of Object.entries(grouped)) {
    console.log(panel(ACCENT_BOLD(section)));
    for (const item of items) {
      itemIndex += 1;
      const indexLabel = String(itemIndex).padStart(2, '0');
      const left = `${chalk.bold(indexLabel)} ${item.label}`;
      const right = item.shortcut ? ACCENT_SOFT(item.shortcut) : '';
      const row = alignRow(left, right, bodyWidth);
      const selected = state.paletteFiltered[state.paletteSelection]?.id === item.id;
      if (selected) {
        console.log(`${pad}${chalk.bgHex(THEME_HEX).hex('#0f1518')(`  ${padToVisible(row, bodyWidth)}  `)}`);
      } else {
        console.log(panel(row));
      }
    }
    console.log(panel(''));
  }
}

function groupBySection(items) {
  const grouped = {};
  for (const item of items) {
    if (!grouped[item.section]) grouped[item.section] = [];
    grouped[item.section].push(item);
  }
  return grouped;
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
  setNativeCursorHidden(state, false);

  const previousWrite = rl._writeToOutput;
  rl._writeToOutput = (chunk) => {
    // Keep newline behavior, but suppress typed characters.
    if (chunk.includes('\n') || chunk.includes('\r')) {
      rl.output.write(chunk);
    }
  };

  try {
    const answer = await new Promise((resolve) => {
      rl.question(promptText, resolve);
    });
    return String(answer || '').trim();
  } finally {
    rl._writeToOutput = previousWrite;
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
  const panelWidth = Math.max(56, Math.min(92, width - 16));
  const bodyWidth = panelWidth - 4;
  const padLeft = Math.max(2, Math.floor((width - panelWidth) / 2));
  const pad = ' '.repeat(padLeft);

  const providerLabel = formatProviderLabel(cfg.provider);
  const modeLabel = state.mode === 'plan' ? 'Plan' : 'Build';
  const modelLine = `${ACCENT(modeLabel)}  ${cfg.model} ${chalk.gray(providerLabel)}`;
  const askLine = `${ACCENT('A')}sk anything... ${chalk.gray('"Fix a TODO in the codebase"')}`;
  const composerLine = formatComposerLine(state, bodyWidth);
  const preset = MODE_PRESETS[state.presetIndex] || MODE_PRESETS[0];
  const quickActionsLeft = `${ACCENT('/models')} ${chalk.gray('pick')}  ${ACCENT('tab')} ${chalk.gray(`${preset.modeLabel}/${preset.langLabel}`)}`;
  const quickActionsRight = `${ACCENT('/providers')} ${chalk.gray('pick')}  ${ACCENT('/key')} ${chalk.gray('secure')}`;
  const quickActionsLine = alignRow(quickActionsLeft, quickActionsRight, bodyWidth);
  const tipLine = `${ACCENT('Tip')} ${chalk.gray('Use /providers, /models, /key, /session, /help')}`;

  const bg = (text) => chalk.bgHex('#1b1d21')(text);
  const panel = (content) => {
    const body = padToVisible(content, bodyWidth);
    return `${pad}${ACCENT('|')}${bg(` ${body} `)}${ACCENT('|')}`;
  };

  process.stdout.write('\x1b[2J\x1b[H');
  console.log('\n');
  render3dLogo(width);
  console.log();
  console.log(panel(askLine));
  console.log(panel(modelLine));
  console.log(panel(composerLine));
  console.log(panel(quickActionsLine));
  console.log();
  if (cfg.showTips) {
    console.log(centerLine(tipLine, width));
    console.log();
  }
  console.log(ACCENT_SOFT(`  provider: ${cfg.provider}  |  session: ${cfg.session || 'none'}  |  mode: ${state.mode}  |  /help`));
  console.log();
}

function render3dLogo(width) {
  const logoColor = chalk.bold.hex(THEME_HEX);

  for (const line of LOGO_LINES) {
    console.log(centerLine(logoColor(line), width));
  }
}

function formatProviderLabel(provider) {
  if (provider === 'zai') return 'Z.AI';
  if (!provider) return 'unknown';
  return String(provider);
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

function alignRight(line, width) {
  const len = visibleLength(line);
  const left = Math.max(0, width - len);
  return `${' '.repeat(left)}${line}`;
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
