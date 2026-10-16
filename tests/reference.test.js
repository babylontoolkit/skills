'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const reference = require('../lib/reference');
const { addAllowRule, removeAllowRule, hasAllowRule } = require('../lib/claude-settings');
const { install, uninstall } = require('../lib/install');
const { doctor } = require('../lib/doctor');
const { LEGACY_SENTINEL } = require('../lib/persona');

const URL = reference.REFERENCE_URL_PREFIX;
const ROOT_DIR = path.resolve(__dirname, '..');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-reference-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function skillLinkTargets() {
  const pattern = new RegExp(`${URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\s)\`"'<>\\]]+)`, 'g');
  const targets = new Set();
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.md')) for (const match of fs.readFileSync(full, 'utf8').matchAll(pattern)) targets.add(match[1].replace(/[.,;:!?]+$/, '').split('#')[0]);
  });
  walk(path.join(ROOT_DIR, 'skills'));
  return targets;
}

/** A small Reference checkout: links between documents, a download command, a script, a broken link. */
function fixture(t, { broken = false } = {}) {
  const dir = scratch(t);
  const files = {
    'reference.md': `# Reference\n\nSee [Scene Components](${URL}references/scene-components.md) and ${URL}training/api.d.ts.\n`,
    'references/scene-components.md': `Install:\n\n\`\`\`bash\ncurl -fsSL ${URL}references/scripts/setup.sh -o ~/.claude/toolkit/setup.sh\n\`\`\`\n${broken ? `[Gone](${URL}references/missing.md)\n` : ''}`,
    'references/scripts/setup.sh': '#!/bin/sh\necho setup\n',
    'training/api.d.ts': 'declare class Example {}\n',
    '.github/workflows/ci.yml': 'name: ci\n',
  };
  // Every Reference document the shipped skills link to, so their links resolve against the fixture.
  for (const target of skillLinkTargets()) files[target] = files[target] || `# ${target}\n`;
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), text);
  }
  return dir;
}

test('rewrites links, bare URLs and downloads to the local copy, and nothing else', () => {
  const dir = '/home/someone/.claude/toolkit/reference';
  const source = [
    `[Docs](${URL}references/node-esm.md)`,
    `Read ${URL}reference.md.`,
    `\`${URL}training/declarations/babylon.toolkit.d.ts\``,
    `[Section](${URL}references/ui.md#decision-matrix)`,
    `curl -fsSL ${URL}references/scripts/bt-stop-editor.sh -o ~/.claude/toolkit/bt-stop-editor.sh`,
    'https://raw.githubusercontent.com/babylontoolkit/skills/main/skills/bt-atlas/SKILL.md',
  ].join('\n');
  const { text, links, downloads } = reference.rewriteText(source, dir);
  assert.equal(downloads, 1);
  assert.equal(links, 4);
  assert.deepEqual(text.split('\n'), [
    `[Docs](${dir}/references/node-esm.md)`,
    `Read ${dir}/reference.md.`,
    `\`${dir}/training/declarations/babylon.toolkit.d.ts\``,
    `[Section](${dir}/references/ui.md#decision-matrix)`,
    `cp "${dir}/references/scripts/bt-stop-editor.sh" ~/.claude/toolkit/bt-stop-editor.sh`,
    'https://raw.githubusercontent.com/babylontoolkit/skills/main/skills/bt-atlas/SKILL.md',
  ]);
});

test('a markdown link into a folder with a space keeps parsing', () => {
  const { text } = reference.rewriteText(`[Docs](${URL}reference.md)`, '/Users/Jane Doe/.claude/toolkit/reference');
  assert.equal(text, '[Docs](</Users/Jane Doe/.claude/toolkit/reference/reference.md>)');
});

/** A tarball laid out as GitHub serves one: pax global header with the commit, a top folder, a long path. */
function githubTarball(commit, files) {
  const blocks = [];
  const header = (name, size, type) => {
    const block = Buffer.alloc(512);
    block.write(name.slice(0, 99), 0);
    block.write('0000644\0', 100);
    block.write(size.toString(8).padStart(11, '0') + '\0', 124);
    block.write(type, 156);
    block.write('ustar\0' + '00', 257);
    block.fill(' ', 148, 156);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return block;
  };
  const padded = (data) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  const pax = (key, value) => {
    const body = ` ${key}=${value}\n`;
    let length = body.length + 2;
    if (String(length).length + body.length !== length) length = String(length).length + body.length;
    return Buffer.from(`${length}${body}`);
  };
  const global = pax('comment', commit);
  blocks.push(header('pax_global_header', global.length, 'g'), padded(global));
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const full = `agent-main/${name}`;
    if (full.length > 99) {
      const record = pax('path', full);
      blocks.push(header('PaxHeader', record.length, 'x'), padded(record));
    }
    blocks.push(header(full, data.length, '0'), padded(data));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test('reads a GitHub tarball: commit, stripped top folder, long paths', () => {
  const commit = 'a'.repeat(40);
  const longName = `training/${'nested/'.repeat(15)}deep.md`;
  const { commit: found, files } = reference.readTarball(githubTarball(commit, { 'reference.md': '# R\n', [longName]: 'deep\n' }));
  assert.equal(found, commit);
  assert.deepEqual(files.map((file) => file.path), ['reference.md', longName]);
  assert.equal(files[1].data.toString(), 'deep\n');
});

test('installs from a checkout: rewritten, link-checked, self-ignored, housekeeping dropped', (t) => {
  const projectRoot = scratch(t);
  const result = reference.installReference({ mode: 'project', projectRoot, from: fixture(t) });
  const dir = path.join(projectRoot, '.claude', 'toolkit', 'reference');
  assert.equal(result.status, 'installed');
  assert.equal(result.dir, dir);
  assert.equal(result.rewrittenLinks, 2);
  assert.equal(result.rewrittenDownloads, 1);
  assert.equal(fs.existsSync(path.join(dir, '.github')), false);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*\n');
  assert.match(fs.readFileSync(path.join(dir, 'references/scene-components.md'), 'utf8'), /cp ".*\/reference\/references\/scripts\/setup\.sh" ~\/\.claude\/toolkit\/setup\.sh/);
  assert.deepEqual(reference.checkLinks(dir, [dir]), { checked: 3, broken: [] });
});

test('a link to a document that does not exist is reported', (t) => {
  const projectRoot = scratch(t);
  const { dir } = reference.installReference({ mode: 'project', projectRoot, from: fixture(t, { broken: true }) });
  assert.deepEqual(reference.checkLinks(dir, [dir]).broken, ['references/scene-components.md → references/missing.md']);
});

test('a failed refresh keeps the existing copy; with none, it is unavailable', (t) => {
  const projectRoot = scratch(t);
  const missing = path.join(scratch(t), 'no-such-checkout');
  assert.equal(reference.installReference({ mode: 'project', projectRoot, from: missing }).status, 'unavailable');
  reference.installReference({ mode: 'project', projectRoot, from: fixture(t) });
  const kept = reference.installReference({ mode: 'project', projectRoot, from: missing });
  assert.equal(kept.status, 'kept');
  assert.match(kept.reason, /no reference\.md/);
  assert.equal(reference.isUsable(kept.dir), true);
});

test('project install points skills and persona at the copy; uninstall removes it', (t) => {
  const projectRoot = scratch(t);
  const opts = { mode: 'project', projectRoot, ids: ['claude'], referenceFrom: fixture(t) };
  const report = install(opts);
  const dir = path.join(projectRoot, '.claude', 'toolkit', 'reference');
  assert.equal(report.reference.status, 'installed');
  assert.deepEqual(report.reference.links.broken, []);

  const skill = fs.readFileSync(path.join(projectRoot, '.claude/skills/bt-execute/SKILL.md'), 'utf8');
  assert.equal(skill.includes(URL), false);
  assert.ok(skill.includes(`${reference.linkRoot(dir)}/reference.md`));

  const persona = fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf8');
  assert.ok(persona.includes(`read the \`Agent Reference\` at ${reference.linkRoot(dir)}/reference.md`));
  assert.ok(persona.includes(LEGACY_SENTINEL), 'the GitHub fallback keeps the persona recognisable');

  const check = doctor(opts);
  assert.equal(check.ok, true);
  assert.equal(check.reference.present, true);
  assert.deepEqual(check.reference.warnings, []);

  uninstall(opts);
  assert.equal(fs.existsSync(dir), false);
});

test('--no-reference keeps the GitHub addresses', (t) => {
  const projectRoot = scratch(t);
  install({ mode: 'project', projectRoot, ids: ['claude'], reference: false });
  assert.equal(fs.existsSync(path.join(projectRoot, '.claude', 'toolkit')), false);
  assert.ok(fs.readFileSync(path.join(projectRoot, '.claude/skills/bt-execute/SKILL.md'), 'utf8').includes(URL));
  assert.ok(fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf8').includes(`${URL}reference.md before doing anything else`));
});

test('allow rule: added once beside other settings, removed alone, invalid JSON left untouched', (t) => {
  const file = path.join(scratch(t), 'settings.json');
  const rule = reference.CLAUDE_READ_RULE;
  fs.writeFileSync(file, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls:*)'], deny: ['Read(./.env)'] } }));
  assert.equal(addAllowRule(file, rule).action, 'updated');
  assert.equal(addAllowRule(file, rule).action, 'unchanged');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'opus', permissions: { allow: ['Bash(ls:*)', rule], deny: ['Read(./.env)'] } });
  assert.equal(removeAllowRule(file, rule).action, 'removed');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).permissions.allow, ['Bash(ls:*)']);

  fs.writeFileSync(file, '{ "model": "opus", }');
  assert.equal(addAllowRule(file, rule).action, 'skipped');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "model": "opus", }');
  assert.equal(hasAllowRule(file, rule), false);
});

/** A global install in a child process whose home folder is a scratch folder, so the real one is never touched. */
function globalRun(home, script) {
  const result = spawnSync(process.execPath, ['-e', script], { cwd: ROOT_DIR, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('global install adds the Claude Code allow rule; uninstall removes only a rule it added', (t) => {
  const home = scratch(t);
  const from = fixture(t);
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const run = (call) => globalRun(home, `const { install, uninstall } = require('./lib/install'); ${call}`);

  run(`install({ ids: ['claude'], referenceFrom: ${JSON.stringify(from)} });`);
  assert.equal(hasAllowRule(settingsFile, reference.CLAUDE_READ_RULE), true);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'toolkit', 'reference', 'reference.md')), true);
  run(`install({ ids: ['claude'], referenceFrom: ${JSON.stringify(from)} });`);
  run(`uninstall({ ids: ['claude'] });`);
  assert.equal(hasAllowRule(settingsFile, reference.CLAUDE_READ_RULE), false);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'toolkit', 'reference')), false);

  // A rule the user already had is theirs: it stays after uninstall.
  fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { allow: [reference.CLAUDE_READ_RULE] } }));
  run(`install({ ids: ['claude'], referenceFrom: ${JSON.stringify(from)} });`);
  run(`uninstall({ ids: ['claude'] });`);
  assert.equal(hasAllowRule(settingsFile, reference.CLAUDE_READ_RULE), true);
});

test('the helper scripts beside the copy survive install and uninstall', (t) => {
  const projectRoot = scratch(t);
  const helper = path.join(projectRoot, '.claude', 'toolkit', 'bt-stop-editor.sh');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, '#!/bin/sh\n');
  const opts = { mode: 'project', projectRoot, ids: ['claude'], referenceFrom: fixture(t) };
  install(opts);
  install(opts);
  uninstall(opts);
  assert.equal(fs.readFileSync(helper, 'utf8'), '#!/bin/sh\n');
});
