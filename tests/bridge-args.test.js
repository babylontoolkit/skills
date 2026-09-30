'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseBridgeArgs } = require('../lib/bridge/args');

test('collects repeated --unity paths', () => {
  const a = parseBridgeArgs(['--server', 'https://x', '--unity', 'a', '--unity', 'b'], {});
  assert.deepEqual(a.unity, ['a', 'b']);
  assert.deepEqual(a.errors, []);
  assert.equal(a.command, 'run');
  assert.equal(a.server, 'https://x');
});

test('run without a server is an error', () => {
  const a = parseBridgeArgs([], {});
  assert.ok(a.errors.some((e) => e.startsWith('--server is required')));
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

test('logout needs a server', () => {
  const a = parseBridgeArgs(['logout'], {});
  assert.equal(a.command, 'logout');
  assert.ok(a.errors.some((e) => e.startsWith('--server is required')));
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
