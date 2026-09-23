import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  createConfirmGate,
  canonicalJson,
  hashArgs,
  ConfirmUnavailableError,
} from '../dist/mcp/index.js';

const T0 = Date.parse('2026-09-23T00:00:00.000Z');
const SECRET = 'test-secret-not-a-credential';
const KEY_PREFIX = 'test:mcp:confirm:';
const TOOL = 'gplcoffee_queue_install';
const ARGS = { site_id: 's1', slugs: ['elementor-pro', 'wp-rocket'] };
const BINDING = { tokenId: 'tok_1', tool: TOOL, args: ARGS };

/** Map-backed stand-in for an Upstash no-store client: SET with EX, atomic DEL returning 1/0. */
function fakeRedis(clock) {
  const store = new Map(); // key -> expiry (epoch ms)
  const calls = { set: [], del: [] };
  return {
    store,
    calls,
    async set(key, value, opts) {
      calls.set.push([key, value, opts]);
      store.set(key, clock.t + opts.ex * 1000);
      return 'OK';
    },
    async del(key) {
      calls.del.push(key);
      const expiry = store.get(key);
      if (expiry === undefined) return 0;
      store.delete(key);
      return expiry > clock.t ? 1 : 0;
    },
  };
}

function setup({ noRedis = false, redisFactory = fakeRedis, config = {} } = {}) {
  const clock = { t: T0 };
  const redis = noRedis ? null : redisFactory(clock);
  const warns = [];
  const gate = createConfirmGate({
    redis,
    secret: SECRET,
    keyPrefix: KEY_PREFIX,
    whenRedisMissing: 'deny',
    now: () => clock.t,
    onWarn: (message) => warns.push(message),
    ...config,
  });
  return { clock, redis, gate, warns };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

const decode = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const derivedKey = (secret) => createHmac('sha256', secret).update('app-core:mcp-confirm:v1').digest();
const mac = (payload, key) => createHmac('sha256', key).update(payload).digest('base64url');

// ---------------------------------------------------------------- canonicalJson / hashArgs

test('canonicalJson: key-order independent, drops undefined (zeebrar vector)', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }], e: undefined }), '{"a":[{"c":3,"d":2}],"b":1}');
  assert.equal(hashArgs({ a: 1, b: 2 }), hashArgs({ b: 2, a: 1 }));
  assert.match(hashArgs(ARGS), /^[0-9a-f]{64}$/);
  const sorted = { a: 1, b: [true, null, 's'], c: { x: 1.5 } };
  assert.equal(canonicalJson(sorted), JSON.stringify(sorted));
});

test('canonicalJson: JSON.stringify semantics for undefined, functions and toJSON', () => {
  assert.equal(canonicalJson(undefined), 'null');
  assert.equal(canonicalJson([1, undefined, () => 1]), '[1,null,null]');
  assert.equal(canonicalJson({ f: () => 1, s: Symbol('x'), k: 'v' }), '{"k":"v"}');
  assert.equal(canonicalJson({ d: new Date(0) }), '{"d":"1970-01-01T00:00:00.000Z"}');
  // Dates bind by value: two different dates must not hash alike.
  assert.notEqual(hashArgs({ since: new Date(0) }), hashArgs({ since: new Date(1) }));
  assert.equal(canonicalJson('x'), '"x"');
  assert.equal(canonicalJson(null), 'null');
});

// ---------------------------------------------------------------- issue

test('issue: stores the nonce under keyPrefix with EX = ttl and binds the claims', async () => {
  const { gate, redis } = setup();
  assert.equal(gate.ttlSeconds, 300);
  const { token, expiresIn } = await gate.issue(BINDING);
  assert.equal(expiresIn, 300);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const claims = decode(token);
  assert.deepEqual(Object.keys(claims).sort(), ['ah', 'exp', 'iat', 'n', 'tid', 'tool', 'v']);
  assert.equal(claims.v, 1);
  assert.equal(claims.tid, 'tok_1');
  assert.equal(claims.tool, TOOL);
  assert.equal(claims.ah, hashArgs(ARGS));
  assert.equal(claims.iat, T0);
  assert.equal(claims.exp, T0 + 300_000);
  assert.equal(Buffer.from(claims.n, 'base64url').length, 16);
  assert.deepEqual(redis.calls.set, [[KEY_PREFIX + claims.n, '1', { ex: 300 }]]);
});

test('issue: rejects a binding without tokenId or tool', async () => {
  const { gate, redis } = setup();
  await assert.rejects(gate.issue({ tokenId: '', tool: TOOL, args: ARGS }), TypeError);
  await assert.rejects(gate.issue({ tokenId: 'tok_1', args: ARGS }), TypeError);
  assert.equal(redis.calls.set.length, 0);
});

// ---------------------------------------------------------------- verify: single use and binding

test('verify: consumes exactly once; a replay is ALREADY_USED', async () => {
  const { gate, redis } = setup();
  const { token } = await gate.issue(BINDING);
  assert.deepEqual(await gate.verify(token, BINDING), { ok: true });
  assert.deepEqual(await gate.verify(token, BINDING), { ok: false, reason: 'ALREADY_USED' });
  const nonce = decode(token).n;
  assert.deepEqual(redis.calls.del, [KEY_PREFIX + nonce, KEY_PREFIX + nonce]);
});

test('verify: ARGS_CHANGED, WRONG_TOOL and WRONG_TOKEN do not consume the token', async () => {
  const { gate, redis } = setup();
  const { token } = await gate.issue(BINDING);
  assert.deepEqual(await gate.verify(token, { ...BINDING, args: { ...ARGS, site_id: 's2' } }), {
    ok: false,
    reason: 'ARGS_CHANGED',
  });
  assert.deepEqual(await gate.verify(token, { ...BINDING, args: { ...ARGS, slugs: ['elementor-pro'] } }), {
    ok: false,
    reason: 'ARGS_CHANGED',
  });
  assert.deepEqual(await gate.verify(token, { ...BINDING, tool: 'gplcoffee_other_tool' }), {
    ok: false,
    reason: 'WRONG_TOOL',
  });
  assert.deepEqual(await gate.verify(token, { ...BINDING, tokenId: 'tok_2' }), { ok: false, reason: 'WRONG_TOKEN' });
  assert.equal(redis.calls.del.length, 0, 'mismatches return before the DEL');
  // Same args with a different key order are the same binding, and the token is still live.
  assert.deepEqual(
    await gate.verify(token, { ...BINDING, args: { slugs: ['elementor-pro', 'wp-rocket'], site_id: 's1' } }),
    { ok: true }
  );
});

test('verify: tampered payloads are BAD_SIGNATURE, garbage is MALFORMED, nothing consumed', async () => {
  const { gate, redis } = setup();
  const { token } = await gate.issue(BINDING);
  const [payload, sig] = token.split('.');

  const forged = b64({ ...decode(token), tid: 'tok_9' });
  assert.deepEqual(await gate.verify(`${forged}.${sig}`, { ...BINDING, tokenId: 'tok_9' }), {
    ok: false,
    reason: 'BAD_SIGNATURE',
  });
  const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
  assert.deepEqual(await gate.verify(`${payload}.${flipped}`, BINDING), { ok: false, reason: 'BAD_SIGNATURE' });
  assert.deepEqual(await gate.verify(`${payload}.${sig}x`, BINDING), { ok: false, reason: 'BAD_SIGNATURE' });

  for (const garbage of ['nope', '', '.', 'a.', '.b', `${payload}.${sig}.extra`, null, undefined, 42]) {
    assert.deepEqual(await gate.verify(garbage, BINDING), { ok: false, reason: 'MALFORMED' }, String(garbage));
  }
  assert.equal(redis.calls.del.length, 0);
  assert.deepEqual(await gate.verify(token, BINDING), { ok: true }, 'the genuine token survived all of that');
});

test('verify: MAC key is HMAC(secret, "app-core:mcp-confirm:v1"); the raw-secret scheme is rejected', async () => {
  const { gate } = setup();
  const { token } = await gate.issue(BINDING);
  const [payload, sig] = token.split('.');

  // Pins the derivation exactly.
  assert.equal(mac(payload, derivedKey(SECRET)), sig);
  // zeebrar's pre-core scheme signed with the raw secret: must not verify.
  assert.deepEqual(await gate.verify(`${payload}.${mac(payload, SECRET)}`, BINDING), {
    ok: false,
    reason: 'BAD_SIGNATURE',
  });

  // A correctly MACed payload with the old zeebrar claim shape or another version is MALFORMED.
  const key = derivedKey(SECRET);
  const zeebrarShape = b64({ tokenId: 'tok_1', tool: TOOL, argsHash: hashArgs(ARGS), nonce: 'n', issuedAt: T0 });
  const v2 = b64({ ...decode(token), v: 2 });
  const notJson = Buffer.from('not json').toString('base64url');
  for (const p of [zeebrarShape, v2, notJson]) {
    assert.deepEqual(await gate.verify(`${p}.${mac(p, key)}`, BINDING), { ok: false, reason: 'MALFORMED' });
  }
  assert.deepEqual(await gate.verify(token, BINDING), { ok: true });
});

test('verify: a token from a gate with another secret is BAD_SIGNATURE', async () => {
  const a = setup();
  const b = setup({ config: { secret: 'a-different-secret' } });
  const { token } = await a.gate.issue(BINDING);
  assert.deepEqual(await b.gate.verify(token, BINDING), { ok: false, reason: 'BAD_SIGNATURE' });
});

// ---------------------------------------------------------------- expiry

test('verify: EXPIRED past the ttl even when the Redis key survived', async () => {
  // A Redis that never expires keys: the claim exp alone must stop it.
  const immortal = (clock) => {
    const r = fakeRedis(clock);
    const set = r.set;
    r.set = async (key, value, opts) => {
      await set(key, value, opts);
      r.store.set(key, Number.POSITIVE_INFINITY);
      return 'OK';
    };
    return r;
  };
  const { gate, clock, redis } = setup({ redisFactory: immortal });
  const first = await gate.issue(BINDING);
  const second = await gate.issue(BINDING);

  clock.t = T0 + 300_000; // exactly at exp: still valid
  assert.deepEqual(await gate.verify(first.token, BINDING), { ok: true });

  clock.t = T0 + 300_001;
  assert.deepEqual(await gate.verify(second.token, BINDING), { ok: false, reason: 'EXPIRED' });
  assert.equal(redis.calls.del.length, 1, 'an expired claim is rejected before the DEL');
});

test('verify: ALREADY_USED when the Redis key expired before the claim did', async () => {
  const { gate, redis, clock } = setup();
  const { token } = await gate.issue(BINDING);
  for (const key of redis.store.keys()) redis.store.set(key, clock.t - 1); // Redis TTL ran out first (clock skew)
  assert.deepEqual(await gate.verify(token, BINDING), { ok: false, reason: 'ALREADY_USED' });
});

test('ttlSeconds is configurable and flows into EX, expiresIn and the EXPIRED copy', async () => {
  const { gate, redis, clock } = setup({ config: { ttlSeconds: 60 } });
  const { token, expiresIn } = await gate.issue(BINDING);
  assert.equal(expiresIn, 60);
  assert.deepEqual(redis.calls.set[0][2], { ex: 60 });
  clock.t = T0 + 60_001;
  assert.deepEqual(await gate.verify(token, BINDING), { ok: false, reason: 'EXPIRED' });
  assert.match(gate.describe('EXPIRED'), /1 minute\)/);
  assert.match(setup().gate.describe('EXPIRED'), /5 minutes/);
  assert.match(setup({ config: { ttlSeconds: 90 } }).gate.describe('EXPIRED'), /90 seconds/);
});

// ---------------------------------------------------------------- fail closed

test("whenRedisMissing 'deny': issue throws ConfirmUnavailableError, verify is UNAVAILABLE", async () => {
  const withRedis = setup();
  const { token } = await withRedis.gate.issue(BINDING);

  const { gate, warns } = setup({ noRedis: true });
  await assert.rejects(gate.issue(BINDING), (err) => err instanceof ConfirmUnavailableError && err.name === 'ConfirmUnavailableError');
  assert.deepEqual(await gate.verify(token, BINDING), { ok: false, reason: 'UNAVAILABLE' });
  assert.equal(warns.length, 1, 'warns once, not per request');
  assert.match(warns[0], /disabled/);
});

test('Redis errors fail closed: SET failure throws, DEL failure is UNAVAILABLE and does not consume', async () => {
  const failingSet = (clock) => {
    const r = fakeRedis(clock);
    r.set = async () => {
      throw new Error('upstash timeout');
    };
    return r;
  };
  const s = setup({ redisFactory: failingSet });
  await assert.rejects(s.gate.issue(BINDING), (err) => {
    assert.ok(err instanceof ConfirmUnavailableError);
    assert.equal(err.cause.message, 'upstash timeout');
    return true;
  });

  const { gate, redis, warns } = setup();
  const { token } = await gate.issue(BINDING);
  const realDel = redis.del;
  redis.del = async () => {
    throw new Error('upstash 503');
  };
  assert.deepEqual(await gate.verify(token, BINDING), { ok: false, reason: 'UNAVAILABLE' });
  assert.match(warns.join('\n'), /upstash 503/);
  redis.del = realDel;
  assert.deepEqual(await gate.verify(token, BINDING), { ok: true }, 'the failed attempt did not burn the token');
});

test("whenRedisMissing 'memory' outside production: process-local, single use, warns once", async () => {
  await withEnv({ NODE_ENV: 'development' }, async () => {
    const { gate, warns, clock } = setup({ noRedis: true, config: { whenRedisMissing: 'memory' } });
    const { token } = await gate.issue(BINDING);
    assert.deepEqual(await gate.verify(token, { ...BINDING, tool: 'other' }), { ok: false, reason: 'WRONG_TOOL' });
    assert.deepEqual(await gate.verify(token, BINDING), { ok: true });
    assert.deepEqual(await gate.verify(token, BINDING), { ok: false, reason: 'ALREADY_USED' });

    const late = await gate.issue(BINDING);
    clock.t += 300_001;
    assert.deepEqual(await gate.verify(late.token, BINDING), { ok: false, reason: 'EXPIRED' });
    assert.equal(warns.length, 1);
    assert.match(warns[0], /process-local/);
  });
});

test("NODE_ENV=production refuses 'memory': no Redis means fail closed", async () => {
  await withEnv({ NODE_ENV: 'production' }, async () => {
    const { gate, warns } = setup({ noRedis: true, config: { whenRedisMissing: 'memory' } });
    await assert.rejects(gate.issue(BINDING), ConfirmUnavailableError);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /production/);

    // With a Redis client, production works normally.
    const ok = setup({ config: { whenRedisMissing: 'memory' } });
    const { token } = await ok.gate.issue(BINDING);
    assert.deepEqual(await ok.gate.verify(token, BINDING), { ok: true });
  });
});

// ---------------------------------------------------------------- configuration

test('createConfirmGate requires an explicit topology and sane settings', () => {
  const base = { redis: null, secret: SECRET, keyPrefix: KEY_PREFIX, whenRedisMissing: 'deny' };
  assert.throws(() => createConfirmGate({ ...base, whenRedisMissing: undefined }), /whenRedisMissing is required/);
  assert.throws(() => createConfirmGate({ ...base, whenRedisMissing: 'maybe' }), TypeError);
  assert.throws(() => createConfirmGate({ ...base, keyPrefix: '' }), TypeError);
  assert.throws(() => createConfirmGate({ ...base, ttlSeconds: 0 }), TypeError);
  assert.throws(() => createConfirmGate({ ...base, ttlSeconds: 1.5 }), TypeError);
  assert.throws(() => createConfirmGate({ ...base, secret: 42 }), TypeError);
  assert.throws(() => createConfirmGate({ ...base, redis: { set: async () => 'OK' } }), TypeError);
  assert.doesNotThrow(() => createConfirmGate({ ...base, redis: undefined }));
});

test('the secret is read lazily: construction never throws, first use does', async () => {
  let reads = 0;
  const { gate } = setup({
    config: {
      secret: () => {
        reads++;
        return process.env.APP_CORE_TEST_MISSING_SECRET ?? '';
      },
    },
  });
  assert.equal(reads, 0);
  await assert.rejects(gate.issue(BINDING), /secret is empty or not configured/);
  await assert.rejects(gate.verify('a.b', BINDING), /secret is empty or not configured/);
  assert.equal(reads, 2);
});

test('describe: every failure has copy, and each is distinct where it matters', () => {
  const { gate } = setup();
  const reasons = ['MALFORMED', 'BAD_SIGNATURE', 'WRONG_TOKEN', 'WRONG_TOOL', 'ARGS_CHANGED', 'EXPIRED', 'ALREADY_USED', 'UNAVAILABLE'];
  for (const reason of reasons) {
    const text = gate.describe(reason);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 10, reason);
    assert.doesNotMatch(text, /[\u2013\u2014]/, `${reason}: plain hyphens only`);
  }
  assert.match(gate.describe('UNAVAILABLE'), /nothing was executed/);
  assert.notEqual(gate.describe('ARGS_CHANGED'), gate.describe('ALREADY_USED'));
});
