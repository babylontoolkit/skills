'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseBridgeArgs, DEFAULT_SERVER } = require('../lib/bridge/args');

test('collects repeated --unity paths', () => {
  const a = parseBridgeArgs(['--server', 'https://x', '--unity', 'a', '--unity', 'b'], {});
  assert.deepEqual(a.unity, ['a', 'b']);
  assert.deepEqual(a.errors, []);
  assert.equal(a.command, 'run');
  assert.equal(a.server, 'https://x');
});

test('without --server or BTK_BRIDGE_SERVER the production App Builder is the default (D55)', () => {
  const a = parseBridgeArgs([], {});
  assert.deepEqual(a.errors, []);
  assert.equal(DEFAULT_SERVER, 'https://app.babylontoolkit.com');
  assert.deepEqual(a.servers, [DEFAULT_SERVER]);
  assert.equal(a.server, DEFAULT_SERVER);
  assert.equal(a.serverExplicit, false);
});

test('--server is repeatable (several App Builders), de-duplicated, and each must be HTTPS or localhost', () => {
  const a = parseBridgeArgs(['--server', 'http://localhost:5173/', '--server', 'https://app.babylontoolkit.com', '--server', 'http://localhost:5173'], {});
  assert.deepEqual(a.errors, []);
  assert.deepEqual(a.servers, ['http://localhost:5173', 'https://app.babylontoolkit.com']);
  assert.equal(a.serverExplicit, true);
  const bad = parseBridgeArgs(['--server', 'https://ok.example', '--server', 'http://evil.com'], {});
  assert.deepEqual(bad.errors, ['refusing a non-HTTPS server: http://evil.com']);
  assert.deepEqual(bad.servers, ['https://ok.example']);
});

test('--server wins over BTK_BRIDGE_SERVER', () => {
  const a = parseBridgeArgs(['--server', 'https://flag.example'], { BTK_BRIDGE_SERVER: 'https://env.example' });
  assert.deepEqual(a.servers, ['https://flag.example']);
});

test('the server comes from BTK_BRIDGE_SERVER, trailing slash stripped', () => {
  const a = parseBridgeArgs([], { BTK_BRIDGE_SERVER: 'https://builder.example/' });
  assert.deepEqual(a.errors, []);
  assert.equal(a.server, 'https://builder.example');
});

test('refuses plain http to anything but this machine', () => {
  const a = parseBridgeArgs(['--server', 'http://evil.com'], {});
  assert.deepEqual(a.errors, ['refusing a non-HTTPS server: http://evil.com']);
});

test('accepts http://localhost with a port', () => {
  const a = parseBridgeArgs(['--server', 'http://localhost:5173'], {});
  assert.deepEqual(a.errors, []);
  assert.equal(a.server, 'http://localhost:5173');
  assert.deepEqual(parseBridgeArgs(['--server', 'http://127.0.0.1:5173/'], {}).errors, []);
});

test('status needs no server', () => {
  const a = parseBridgeArgs(['status'], {});
  assert.equal(a.command, 'status');
  assert.deepEqual(a.errors, []);
});

test('logout and status without --server mean every paired App Builder', () => {
  const a = parseBridgeArgs(['logout'], {});
  assert.equal(a.command, 'logout');
  assert.deepEqual(a.errors, []);
  assert.equal(a.serverExplicit, false);
  const b = parseBridgeArgs(['status', '--server', 'http://localhost:5173'], {});
  assert.equal(b.command, 'status');
  assert.equal(b.serverExplicit, true);
});

test('--pair takes the install code (case and dash forgiven); anything else is an error', () => {
  assert.equal(parseBridgeArgs(['--pair', 'k7qm-2xwd'], {}).pair, 'K7QM-2XWD');
  assert.equal(parseBridgeArgs(['--pair', 'K7QM2XWD'], {}).pair, 'K7QM2XWD');
  const bad = parseBridgeArgs(['--pair', 'nope'], {});
  assert.equal(bad.pair, undefined);
  assert.ok(bad.errors.some((e) => e.startsWith('--pair needs the install code')));
  assert.ok(parseBridgeArgs(['--pair'], {}).errors.includes('--pair needs a value'));
});

test('--install-service / --uninstall-service / --service pick the command; they do not combine', () => {
  const i = parseBridgeArgs(['--install-service', '--pair', 'K7QM-2XWD', '--server', 'http://localhost:5173'], {});
  assert.equal(i.command, 'install-service');
  assert.deepEqual(i.errors, []);
  assert.equal(i.pair, 'K7QM-2XWD');
  assert.equal(parseBridgeArgs(['--uninstall-service'], {}).command, 'uninstall-service');
  assert.equal(parseBridgeArgs(['--service'], {}).command, 'service');
  assert.ok(parseBridgeArgs(['--install-service', '--uninstall-service'], {}).errors.length > 0);
  assert.ok(parseBridgeArgs(['status', '--install-service'], {}).errors.length > 0);
  // the same flag twice is harmless
  assert.deepEqual(parseBridgeArgs(['--service', '--service'], {}).errors, []);
});

test('unknown options are reported', () => {
  const a = parseBridgeArgs(['--bogus'], {});
  assert.ok(a.errors.includes('Unknown option: --bogus'));
});

test('--help wins and --no-scripts is read', () => {
  assert.equal(parseBridgeArgs(['--help'], {}).command, 'help');
  assert.equal(parseBridgeArgs(['-h'], {}).command, 'help');
  const a = parseBridgeArgs(['--server', 'https://x', '--no-scripts', '--blender', '/b'], {});
  assert.equal(a.noScripts, true);
  assert.equal(a.blender, '/b');
});

test('--projects <folder> is read; without a value it is an error', () => {
  const a = parseBridgeArgs(['--server', 'https://x', '--projects', '/Users/me/Unity'], {});
  assert.deepEqual(a.projects, ['/Users/me/Unity']);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(parseBridgeArgs(['--projects', 'A', '--projects', 'B'], {}).projects, ['A', 'B']);
  assert.ok(parseBridgeArgs(['--server', 'https://x', '--projects'], {}).errors.includes('--projects needs a value'));
});
