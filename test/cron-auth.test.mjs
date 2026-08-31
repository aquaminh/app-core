import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';

// The warn-once flag and receiver cache are module-level, so every test loads
// a fresh module instance (query-string cache bust) instead of depending on
// declaration order.
let moduleCounter = 0;
async function freshVerify() {
  const mod = await import(`../dist/cron/auth.js?fresh=${++moduleCounter}`);
  return mod.verifyCronAuth;
}

const req = (headers) => ({
  headers: { get: (n) => headers[n.toLowerCase()] ?? null },
});

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

function captureWarns(fn) {
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  return Promise.resolve()
    .then(fn)
    .then(() => warns)
    .finally(() => {
      console.warn = original;
    });
}

// Mirrors QStash's documented signature: HS256 JWT, issuer "Upstash",
// body claim = unpadded base64url(sha256(body)).
function qstashSign(body, key) {
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64(
    JSON.stringify({
      iss: 'Upstash',
      sub: 'https://example.test/api/cron/test',
      exp: now + 300,
      nbf: now - 300,
      iat: now,
      jti: 'test-jti',
      body: createHash('sha256').update(body).digest('base64url'),
    })
  );
  const sig = createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

const NO_QSTASH = { QSTASH_CURRENT_SIGNING_KEY: undefined, QSTASH_NEXT_SIGNING_KEY: undefined };

test('unset CRON_SECRET rejects the literal "Bearer undefined" header', async () => {
  await withEnv({ CRON_SECRET: undefined, ...NO_QSTASH }, async () => {
    const verify = await freshVerify();
    const result = await verify(req({ authorization: 'Bearer undefined' }));
    assert.equal(result.authorized, false);
    assert.equal(result.method, 'none');
  });
});

test('unset CRON_SECRET warns exactly once across calls', async () => {
  await withEnv({ CRON_SECRET: undefined, ...NO_QSTASH }, async () => {
    const verify = await freshVerify();
    const warns = await captureWarns(async () => {
      await verify(req({ authorization: 'Bearer undefined' }));
      await verify(req({}));
      await verify(req({}));
    });
    const secretWarns = warns.filter((w) => w.includes('CRON_SECRET is not set'));
    assert.equal(secretWarns.length, 1);
    assert.match(secretWarns[0], /\[app-core\/cron\]/);
  });
});

test('empty-string CRON_SECRET rejects the "Bearer " header', async () => {
  await withEnv({ CRON_SECRET: '', ...NO_QSTASH }, async () => {
    const verify = await freshVerify();
    const result = await verify(req({ authorization: 'Bearer ' }));
    assert.equal(result.authorized, false);
  });
});

test('correct Bearer token authenticates', async () => {
  await withEnv({ CRON_SECRET: 'test-secret-value', ...NO_QSTASH }, async () => {
    const verify = await freshVerify();
    const result = await verify(req({ authorization: 'Bearer test-secret-value' }));
    assert.equal(result.authorized, true);
    assert.equal(result.method, 'bearer');
  });
});

test('wrong and wrong-length Bearer tokens are rejected without throwing', async () => {
  await withEnv({ CRON_SECRET: 'test-secret-value', ...NO_QSTASH }, async () => {
    const verify = await freshVerify();
    assert.equal((await verify(req({ authorization: 'Bearer wrong-value-here' }))).authorized, false);
    assert.equal((await verify(req({ authorization: 'Bearer x' }))).authorized, false);
    assert.equal((await verify(req({}))).authorized, false);
  });
});

// The scenario an "auth behavior unchanged" claim actually has to survive:
// with CRON_SECRET unset, a validly-signed QStash request must still
// authenticate (QStash is the primary caller; Bearer is secondary).
test('valid QStash signature authenticates with CRON_SECRET unset', async () => {
  const key = 'sig_current_test_key_0123456789';
  await withEnv(
    {
      CRON_SECRET: undefined,
      QSTASH_CURRENT_SIGNING_KEY: key,
      QSTASH_NEXT_SIGNING_KEY: 'sig_next_test_key_0123456789',
    },
    async () => {
      const verify = await freshVerify();
      const body = JSON.stringify({ job: 'test' });
      const result = await verify(
        req({ 'upstash-signature': qstashSign(body, key) }),
        body
      );
      assert.equal(result.authorized, true);
      assert.equal(result.method, 'qstash');
    }
  );
});

test('tampered QStash signature is rejected', async () => {
  const key = 'sig_current_test_key_0123456789';
  await withEnv(
    {
      CRON_SECRET: undefined,
      QSTASH_CURRENT_SIGNING_KEY: key,
      QSTASH_NEXT_SIGNING_KEY: 'sig_next_test_key_0123456789',
    },
    async () => {
      const verify = await freshVerify();
      const body = JSON.stringify({ job: 'test' });
      const result = await verify(
        req({ 'upstash-signature': qstashSign(body, 'the-wrong-signing-key') }),
        body
      );
      assert.equal(result.authorized, false);
    }
  );
});
