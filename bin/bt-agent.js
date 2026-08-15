#!/usr/bin/env node
'use strict';

const { install, uninstall } = require('../lib/install');
const { doctor } = require('../lib/doctor');
const { TARGETS, targetIds } = require('../lib/targets');
const { prettyPath } = require('../lib/paths');
const { version } = require('../package.json');

const USAGE = `
@babylonjs-toolkit/agent ${version}

  Installs the Babylon Toolkit agent skills and Agent Persona for every
  supported AI client, on macOS, Linux and Windows.

Usage
  bt-agent [command] [options]

Commands
  install      Install skills + persona into every target        (default)
  update       Same as install, and remove skills no longer shipped
  uninstall    Remove what this tool installed, and nothing else
  doctor       Verify the install; prints INSTALL OK or INSTALL FAILED
  targets      List the available targets and their paths

Options
  --project            Install into the current directory instead of $HOME
  --targets a,b        Only these targets (default: ${TARGETS.filter((t) => t.default).map((t) => t.id).join(',')})
  --legacy-codex       Also install into ~/.codex/skills for old Codex builds
  --no-persona         Install skills only; do not touch instruction files
  --persona-only       Install/refresh the Agent Persona only; do not copy skills
  --no-migrate         Leave a legacy unmarked persona in place, do not convert it
  --dry-run            Print what would happen; change nothing
  --json               Machine-readable output
  -h, --help           Show this help
  -v, --version        Print the version

Examples
  npx @babylonjs-toolkit/agent install
  bt-agent install --legacy-codex
  bt-agent install --project
  bt-agent doctor
`;

function parseArgs(argv) {
  const opts = {
    command: null,
    mode: 'global',
    ids: null,
    legacyCodex: false,
    persona: true,
    skills: true,
    migrate: true,
    dryRun: false,
    json: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-v':
      case '--version':
        opts.version = true;
        break;
      case '--project':
        opts.mode = 'project';
        break;
      case '--legacy-codex':
        opts.legacyCodex = true;
        break;
      case '--no-persona':
        opts.persona = false;
        break;
      case '--persona-only':
        opts.skills = false;
        break;
      case '--no-migrate':
        opts.migrate = false;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--targets':
        opts.ids = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
        break;
      default:
        if (arg.startsWith('--targets=')) {
          opts.ids = arg.slice('--targets='.length).split(',').map((s) => s.trim()).filter(Boolean);
        } else if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`);
        } else if (!opts.command) {
          opts.command = arg;
        } else {
          throw new Error(`Unexpected argument: ${arg}`);
        }
    }
  }

  opts.command = opts.command || 'install';
  return opts;
}

const ACTION_LABEL = {
  created: 'created',
  updated: 'updated',
  unchanged: 'already current',
  migrated: 'migrated to managed block',
  prepended: 'persona prepended',
  'legacy-unrecognized': 'SKIPPED — reworded persona, left untouched',
};

function printInstall(report) {
  const what = report.dryRun ? 'Would install' : 'Installed';

  if (report.skillsInstalled === false) {
    console.log(`\n${what} the Agent Persona only (v${report.version}) — skills untouched.`);
  } else {
    console.log(`\n${what} ${report.skills.length} skills (v${report.version})\n`);
    for (const entry of report.skillDirs) {
      console.log(`  skills  ${prettyPath(entry.dir)}  [${entry.targets.join(', ')}]`);
    }
  }

  if (report.pruned.length) {
    console.log('');
    for (const p of report.pruned) console.log(`  pruned  ${prettyPath(p)} (no longer shipped)`);
  }

  if (report.persona.length) {
    console.log('');
    for (const p of report.persona) {
      const label = ACTION_LABEL[p.action] || p.action;
      console.log(`  persona ${prettyPath(p.file)} — ${label}`);
      if (p.note) console.log(`          ${p.note}`);
      if (p.backup) console.log(`          backup: ${prettyPath(p.backup)}`);
    }
  }
}

function printDoctor(result) {
  const { checked } = result;
  console.log(
    `\nChecked ${checked.skills} skills / ${checked.files} files across ` +
      `${checked.skillDirs.length} skill dir(s) and ${checked.instructionFiles.length} instruction file(s).\n`
  );
  if (result.ok) {
    console.log('INSTALL OK');
  } else {
    console.log('INSTALL FAILED — missing:');
    for (const m of result.missing) console.log(`  ${prettyPath(m)}`);
  }
}

function printTargets(mode) {
  console.log('');
  for (const t of TARGETS) {
    const spec = mode === 'project' ? t.project : t.global;
    const flag = t.default ? 'default' : 'opt-in ';
    console.log(`  [${flag}] ${t.id.padEnd(13)} ${t.label}`);
    if (spec.skills) console.log(`              skills:       ${spec.skills}`);
    if (spec.instructions) console.log(`              instructions: ${spec.instructions}`);
  }
  console.log('');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\nRun \`bt-agent --help\` for usage.`);
    process.exit(2);
  }

  if (opts.help) return void console.log(USAGE);
  if (opts.version) return void console.log(version);

  const common = {
    mode: opts.mode,
    projectRoot: process.cwd(),
    ids: opts.ids,
    legacyCodex: opts.legacyCodex,
    persona: opts.persona,
    skills: opts.skills,
    migrate: opts.migrate,
    dryRun: opts.dryRun,
  };

  try {
    switch (opts.command) {
      case 'install':
      case 'update': {
        const report = install(common);
        const check = doctor(common);

        if (opts.json) {
          console.log(JSON.stringify({ ...report, doctor: check }, null, 2));
        } else {
          printInstall(report);
          if (!opts.dryRun) {
            console.log('');
            if (check.ok) {
              console.log('INSTALL OK');
              console.log('\nRestart your agent session (Claude Code, Codex, Copilot, Gemini CLI)');
              console.log('so the skills and persona are picked up.\n');
            } else {
              printDoctor(check);
            }
          } else {
            console.log('\nDry run — nothing was written.\n');
          }
        }
        process.exit(opts.dryRun || check.ok ? 0 : 1);
        break;
      }

      case 'uninstall': {
        const report = uninstall(common);
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
        } else if (!report.manifestFound) {
          console.log('\nNothing to uninstall — no install manifest found.\n');
        } else {
          console.log(`\n${opts.dryRun ? 'Would remove' : 'Removed'} ${report.removed.length} skill folder(s).`);
          for (const p of report.persona) console.log(`  persona ${prettyPath(p.file)} — ${p.action}`);
          console.log('');
        }
        break;
      }

      case 'doctor': {
        const result = doctor(common);
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else printDoctor(result);
        process.exit(result.ok ? 0 : 1);
        break;
      }

      case 'targets':
        printTargets(opts.mode);
        break;

      case 'help':
        console.log(USAGE);
        break;

      default:
        console.error(`Unknown command: ${opts.command}\n\nRun \`bt-agent --help\` for usage.`);
        process.exit(2);
    }
  } catch (err) {
    console.error(`\nbt-agent: ${err.message}\n`);
    process.exit(1);
  }
}

main();
