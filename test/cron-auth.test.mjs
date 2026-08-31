import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { verifyCronAuth } from '../dist/cron/auth.js';

const req = (header) => ({
  headers: { get: (n) => (n === 'authorization' ? header : null) },
});

const warns = [];
const originalWarn = console.warn;
console.warn = (...args) => warns.push(args.join(' '));
process.on('exit', () => {
  console.warn = originalWarn;
});

beforeEach(() => {
  delete process.env.CRON_SECRET;
});

// Order matters for the warn-once assertions: the module-level flag means the
// unset-secret tests must run before any test that sets CRON_SECRET.
test('unset CRON_SECRET rejects the literal "Bearer undefined" header', async () => {
  const result = await verifyCronAuth(req('Bearer undefined'));
  assert.equal(result.authorized, false);
  assert.equal(result.method, 'none');
});

test('unset CRON_SECRET warns exactly once across calls', async () => {
  await verifyCronAuth(req('Bearer undefined'));
  await verifyCronAuth(req(null));
  const secretWarns = warns.filter((w) => w.includes('CRON_SECRET is not set'));
  assert.equal(secretWarns.length, 1);
  assert.match(secretWarns[0], /\[app-core\/cron\]/);
});

test('empty-string CRON_SECRET rejects the "Bearer " header', async () => {
  process.env.CRON_SECRET = '';
  const result = await verifyCronAuth(req('Bearer '));
  assert.equal(result.authorized, false);
});

test('correct Bearer token authenticates', async () => {
  process.env.CRON_SECRET = 'test-secret-value';
  const result = await verifyCronAuth(req('Bearer test-secret-value'));
  assert.equal(result.authorized, true);
  assert.equal(result.method, 'bearer');
});

test('wrong Bearer token is rejected', async () => {
  process.env.CRON_SECRET = 'test-secret-value';
  const result = await verifyCronAuth(req('Bearer wrong-value'));
  assert.equal(result.authorized, false);
});

test('wrong-length Bearer token is rejected without throwing', async () => {
  process.env.CRON_SECRET = 'test-secret-value';
  const result = await verifyCronAuth(req('Bearer x'));
  assert.equal(result.authorized, false);
});

test('missing authorization header is rejected', async () => {
  process.env.CRON_SECRET = 'test-secret-value';
  const result = await verifyCronAuth(req(null));
  assert.equal(result.authorized, false);
});
