'use strict';

/**
 * Convenience auto-install for `npm install -g @babylonjs-toolkit/agent`.
 *
 * Two rules:
 *  1. Only run for a global install. If this package is ever pulled in as a
 *     project dependency, writing to the user's home directory would be rude.
 *  2. Never fail. A skills-copy problem must not fail someone's npm install —
 *     it prints guidance and exits 0.
 *
 * npm's --ignore-scripts, pnpm, and some corporate configs skip this hook
 * entirely, which is why `bt-agent install` is the documented, guaranteed path.
 */

function isGlobalInstall() {
  const flag = process.env.npm_config_global;
  return flag === 'true' || flag === '1';
}

function main() {
  if (!isGlobalInstall()) {
    console.log('\n@babylonjs-toolkit/agent installed locally — run `npx bt-agent install` to set up your skills.\n');
    return;
  }

  const { install } = require('../lib/install');
  const { doctor } = require('../lib/doctor');

  const report = install({ mode: 'global' });
  const check = doctor({ mode: 'global' });

  console.log(`\nBabylon Toolkit — installed ${report.skills.length} agent skills.`);
  for (const entry of report.skillDirs) console.log(`  skills  ${entry.dir}`);
  for (const p of report.persona) console.log(`  persona ${p.file} — ${p.action}`);

  console.log(check.ok ? '\nINSTALL OK' : '\nINSTALL INCOMPLETE — run `bt-agent doctor` for details');
  console.log('\nRestart your agent session so the skills and persona are picked up.\n');
}

try {
  main();
} catch (err) {
  console.log('\n@babylonjs-toolkit/agent: automatic setup did not complete.');
  console.log(`  reason: ${err && err.message ? err.message : err}`);
  console.log('  run `bt-agent install` to finish setting up.\n');
}

process.exit(0);
