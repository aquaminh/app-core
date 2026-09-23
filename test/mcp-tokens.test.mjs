import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  createMcpTokens,
  defineScopes,
  extractBearer,
  paginate,
  McpTokenInputError,
} from '../dist/mcp/index.js';

const T0 = Date.parse('2026-09-23T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SCOPES = defineScopes(['catalog:read', 'account:read', 'sites:read', 'installs:write']);

// Independent vectors: computed with `printf '%s' <raw> | shasum -a 256` and
// cross-checked with `openssl dgst -sha256`, NOT with the code under test.
// The zbr_mcp_ vector pins compatibility with tokens zeebrar already issued:
// its hashMcpToken is sha256(raw) hex with no pepper.
const GOLDEN_BODY = 'Q2xhdWRlQ29kZUdvbGRlblZlY3Rvcl8wMTIzNDU2Nzg'; // 43 chars, like a real token
const GOLDEN = {
  zbr: { raw: `zbr_mcp_${GOLDEN_BODY}`, hash: '90502fe7135a67eb92e0f08a95a3e482547568ad086f07fce3fd2058451cb759' },
  gcf: { raw: `gcf_mcp_${GOLDEN_BODY}`, hash: '4280570b5eab674a5062b8559fa9fb3647a7a46e53e5173e09915b746c7a362b' },
};

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** In-memory stand-in for prisma.mcpToken covering exactly the where-shapes the module sends. */
function fakeDelegate(clock) {
  const rows = [];
  const calls = { findUnique: [], findMany: [], create: [], update: [], updateMany: [], count: [] };
  let seq = 0;
  return {
    rows,
    calls,
    insert(fields) {
      const row = {
        id: `tok_${++seq}`,
        customerId: 'cust_1',
        name: 'seeded',
        prefix: fields.raw.slice(0, 14),
        tokenHash: sha256(fields.raw),
        scopes: ['catalog:read'],
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: new Date(clock.t),
        ...fields,
      };
      delete row.raw;
      rows.push(row);
      return row;
    },
    async findUnique(args) {
      calls.findUnique.push(args);
      const row = rows.find((r) => r.tokenHash === args.where.tokenHash);
      return row ? { ...row } : null;
    },
    async findMany(args) {
      calls.findMany.push(args);
      return rows
        .filter((r) => r.customerId === args.where.customerId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((r) => ({ ...r }));
    },
    async create(args) {
      calls.create.push(args);
      const row = {
        id: `tok_${++seq}`,
        ...args.data,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: new Date(clock.t),
      };
      rows.push(row);
      return { ...row };
    },
    async update(args) {
      calls.update.push(args);
      const row = rows.find((r) => r.id === args.where.id);
      if (!row) throw new Error('record not found');
      Object.assign(row, args.data);
      return { ...row };
    },
    async updateMany(args) {
      calls.updateMany.push(args);
      const w = args.where;
      let count = 0;
      for (const row of rows) {
        if ('id' in w && row.id !== w.id) continue;
        if (row.customerId !== w.customerId) continue;
        if (w.revokedAt === null && row.revokedAt !== null) continue;
        Object.assign(row, args.data);
        count++;
      }
      return { count };
    },
    async count(args) {
      calls.count.push(args);
      const w = args.where;
      return rows.filter(
        (r) =>
          r.customerId === w.customerId &&
          (w.revokedAt !== null || r.revokedAt === null) &&
          w.OR.some((c) => (c.expiresAt === null ? r.expiresAt === null : r.expiresAt && r.expiresAt > c.expiresAt.gt))
      ).length;
    },
  };
}

function setup({ resolvePrincipal, config = {} } = {}) {
  const clock = { t: T0 };
  const db = fakeDelegate(clock);
  const resolveCalls = [];
  const errors = [];
  const defaultResolve = async ({ token, storeId }) => ({
    ok: true,
    principal: { tokenId: token.id, customerId: token.customerId, scopes: token.scopes, expiresAt: token.expiresAt, storeId },
  });
  const tokens = createMcpTokens({
    tokens: db,
    tokenPrefix: 'gcf_mcp_',
    storeId: 'gplcoffee-store',
    scopes: SCOPES,
    maxExpiryDays: 365,
    resolvePrincipal: async (ctx) => {
      resolveCalls.push(ctx);
      return (resolvePrincipal ?? defaultResolve)(ctx);
    },
    now: () => new Date(clock.t),
    onError: (context, error) => errors.push({ context, error }),
    ...config,
  });
  return { clock, db, tokens, resolveCalls, errors };
}

// ---------------------------------------------------------------- generate / hash

test('generate: prefix + 43 base64url chars, 14-char display prefix, sha256 hash, unique', () => {
  const { tokens } = setup();
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const t = tokens.generate();
    assert.match(t.raw, /^gcf_mcp_[A-Za-z0-9_-]{43}$/);
    assert.equal(t.prefix, t.raw.slice(0, 14));
    assert.equal(t.tokenHash, sha256(t.raw));
    assert.match(t.tokenHash, /^[0-9a-f]{64}$/);
    seen.add(t.raw);
  }
  assert.equal(seen.size, 50);
});

test('generate: displayPrefixLength is configurable within bounds', () => {
  const { tokens } = setup({ config: { displayPrefixLength: 10 } });
  assert.equal(tokens.generate().prefix.length, 10);
});

test('hash: golden vectors match an independent sha256 (zeebrar live-token compatibility pin)', () => {
  const zbr = setup({ config: { tokenPrefix: 'zbr_mcp_' } }).tokens;
  const gcf = setup().tokens;
  assert.equal(GOLDEN.zbr.raw.length, 51);
  assert.equal(zbr.hash(GOLDEN.zbr.raw), GOLDEN.zbr.hash);
  assert.equal(gcf.hash(GOLDEN.gcf.raw), GOLDEN.gcf.hash);
  // The hash is prefix-agnostic: any instance hashes any string identically.
  assert.equal(gcf.hash(GOLDEN.zbr.raw), GOLDEN.zbr.hash);
});

test('verify: a zeebrar-issued token row is found by its stored hash', async () => {
  const { tokens, db } = setup({ config: { tokenPrefix: 'zbr_mcp_' } });
  db.rows.push({
    id: 'tok_zbr',
    customerId: 'cust_z',
    name: 'Claude Desktop',
    prefix: GOLDEN.zbr.raw.slice(0, 14),
    tokenHash: GOLDEN.zbr.hash, // exactly what zeebrar stored at issuance
    scopes: ['catalog:read', 'account:read'],
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date(T0 - DAY),
  });
  const result = await tokens.verify(`Bearer ${GOLDEN.zbr.raw}`);
  assert.equal(result.ok, true);
  assert.equal(result.principal.tokenId, 'tok_zbr');
  assert.deepEqual(db.calls.findUnique[0], { where: { tokenHash: GOLDEN.zbr.hash } });
});

// ---------------------------------------------------------------- config validation

test('createMcpTokens rejects invalid configuration', () => {
  const clock = { t: T0 };
  const base = {
    tokens: fakeDelegate(clock),
    tokenPrefix: 'gcf_mcp_',
    storeId: 'gplcoffee-store',
    scopes: SCOPES,
    maxExpiryDays: 365,
    resolvePrincipal: async () => ({ ok: false, error: 'INVALID', code: 'X', message: 'x' }),
  };
  for (const tokenPrefix of ['gcf_', 'GCF_mcp_', 'g_mcp_', 'toolongpfx_mcp_', 'gcf_mcp', 'gcf-mcp_']) {
    assert.throws(() => createMcpTokens({ ...base, tokenPrefix }), TypeError, tokenPrefix);
  }
  for (const maxExpiryDays of [0, -1, 1.5, undefined, '365']) {
    assert.throws(() => createMcpTokens({ ...base, maxExpiryDays }), TypeError, String(maxExpiryDays));
  }
  assert.throws(() => createMcpTokens({ ...base, displayPrefixLength: 7 }), TypeError);
  assert.throws(() => createMcpTokens({ ...base, displayPrefixLength: 21 }), TypeError);
  assert.throws(() => createMcpTokens({ ...base, storeId: '' }), TypeError);
  assert.throws(() => createMcpTokens({ ...base, resolvePrincipal: undefined }), TypeError);
  assert.throws(() => createMcpTokens({ ...base, scopes: ['catalog:read'] }), TypeError);
  assert.throws(() => createMcpTokens({ ...base, tokens: undefined }), TypeError);
  const { count, ...noCount } = base.tokens;
  assert.throws(() => createMcpTokens({ ...base, tokens: noCount }), /count is not a function/);
  assert.doesNotThrow(() => createMcpTokens({ ...base, maxExpiryDays: null }));
});

// ---------------------------------------------------------------- extractBearer

test('extractBearer: case-insensitive scheme, trims, rejects other schemes and empties', () => {
  assert.equal(extractBearer('Bearer abc'), 'abc');
  assert.equal(extractBearer('bearer   abc '), 'abc');
  assert.equal(extractBearer('BEARER\tabc'), 'abc');
  assert.equal(extractBearer('  Bearer abc  '), 'abc');
  assert.equal(extractBearer('Basic abc'), null);
  assert.equal(extractBearer('Bearerabc'), null);
  assert.equal(extractBearer('Bearer'), null);
  assert.equal(extractBearer('Bearer    '), null);
  assert.equal(extractBearer(''), null);
  assert.equal(extractBearer(null), null);
  assert.equal(extractBearer(undefined), null);
});

// ---------------------------------------------------------------- scopes

test('defineScopes: is / parse / has / missing', () => {
  const s = defineScopes(['a:read', 'b:read', 'c:write']);
  assert.deepEqual([...s.all], ['a:read', 'b:read', 'c:write']);
  assert.ok(Object.isFrozen(s.all));
  assert.equal(s.is('a:read'), true);
  assert.equal(s.is('z:read'), false);
  // Unknown dropped, duplicates removed, vocabulary order kept.
  assert.deepEqual(s.parse(['c:write', 'retired:scope', 'a:read', 'c:write']), ['a:read', 'c:write']);
  assert.deepEqual(s.parse([]), []);
  assert.equal(s.has(['a:read'], 'a:read'), true);
  assert.equal(s.has(['a:read'], 'c:write'), false);
  assert.deepEqual(s.missing(['a:read'], ['a:read', 'b:read', 'c:write']), ['b:read', 'c:write']);
  assert.deepEqual(s.missing(['a:read', 'b:read'], ['b:read']), []);
});

test('defineScopes rejects empty, duplicate and blank vocabularies', () => {
  assert.throws(() => defineScopes([]), TypeError);
  assert.throws(() => defineScopes(['a', 'a']), TypeError);
  assert.throws(() => defineScopes(['']), TypeError);
});

// ---------------------------------------------------------------- verify

test('verify: MISSING and MALFORMED never touch the database', async () => {
  const { tokens, db } = setup();
  for (const header of [null, undefined, '', 'Basic abc', 'Bearer']) {
    const r = await tokens.verify(header);
    assert.deepEqual(
      { ok: r.ok, error: r.error, code: r.code },
      { ok: false, error: 'MISSING', code: 'MISSING' },
      String(header)
    );
    assert.equal(typeof r.message, 'string');
  }
  const short = `gcf_mcp_${'a'.repeat(31)}`;
  for (const header of ['Bearer zb_notmcp', `Bearer ${GOLDEN.zbr.raw}`, `Bearer ${short}`]) {
    const r = await tokens.verify(header);
    assert.equal(r.error, 'MALFORMED', header);
    assert.equal('customerId' in r, false);
  }
  assert.equal(db.calls.findUnique.length, 0);
});

test('verify: INVALID when the hash is unknown, looked up by sha256 of the raw token', async () => {
  const { tokens, db, resolveCalls } = setup();
  const { raw, tokenHash } = tokens.generate();
  const r = await tokens.verify(`Bearer ${raw}`);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'INVALID');
  assert.equal('customerId' in r, false);
  assert.deepEqual(db.calls.findUnique, [{ where: { tokenHash } }]);
  assert.equal(resolveCalls.length, 0);
});

test('verify: REVOKED and EXPIRED carry customerId and never call resolvePrincipal or touch', async () => {
  const { tokens, db, resolveCalls } = setup();
  const revoked = tokens.generate().raw;
  db.insert({ raw: revoked, customerId: 'cust_r', revokedAt: new Date(T0 - HOUR) });
  const expired = tokens.generate().raw;
  db.insert({ raw: expired, customerId: 'cust_e', expiresAt: new Date(T0 - 1) });

  const r1 = await tokens.verify(`Bearer ${revoked}`);
  assert.deepEqual(
    { ok: r1.ok, error: r1.error, code: r1.code, customerId: r1.customerId },
    { ok: false, error: 'REVOKED', code: 'REVOKED', customerId: 'cust_r' }
  );
  const r2 = await tokens.verify(`Bearer ${expired}`);
  assert.deepEqual(
    { ok: r2.ok, error: r2.error, customerId: r2.customerId },
    { ok: false, error: 'EXPIRED', customerId: 'cust_e' }
  );
  assert.equal(resolveCalls.length, 0);
  assert.equal(db.calls.update.length, 0);
});

test('verify: ok path hands resolvePrincipal parsed scopes and storeId, never the hash', async () => {
  const { tokens, db, resolveCalls } = setup();
  const raw = tokens.generate().raw;
  db.insert({
    raw,
    id: 'tok_ok',
    customerId: 'cust_1',
    scopes: ['sites:read', 'retired:scope', 'catalog:read', 'sites:read'],
    expiresAt: new Date(T0 + DAY),
  });

  const r = await tokens.verify(`bearer  ${raw} `);
  assert.equal(r.ok, true);
  assert.deepEqual(r.principal, {
    tokenId: 'tok_ok',
    customerId: 'cust_1',
    scopes: ['catalog:read', 'sites:read'],
    expiresAt: new Date(T0 + DAY),
    storeId: 'gplcoffee-store',
  });
  assert.equal(resolveCalls.length, 1);
  assert.equal(resolveCalls[0].storeId, 'gplcoffee-store');
  assert.deepEqual(resolveCalls[0].token.scopes, ['catalog:read', 'sites:read']);
  assert.equal('tokenHash' in resolveCalls[0].token, false);
});

test('verify: resolvePrincipal failure passes through with customerId attached', async () => {
  const { tokens, db } = setup({
    resolvePrincipal: async () => ({
      ok: false,
      error: 'FORBIDDEN',
      code: 'SUBSCRIPTION_REQUIRED',
      message: 'A paid plan is required',
    }),
  });
  const raw = tokens.generate().raw;
  db.insert({ raw, customerId: 'cust_free' });
  assert.deepEqual(await tokens.verify(`Bearer ${raw}`), {
    ok: false,
    error: 'FORBIDDEN',
    code: 'SUBSCRIPTION_REQUIRED',
    message: 'A paid plan is required',
    customerId: 'cust_free',
  });
  assert.equal(db.calls.update.length, 0, 'a refused principal is not a use');
});

test('verify: app messages override the defaults', async () => {
  const { tokens, db } = setup({
    config: { messages: { REVOKED: 'Revoked - create a new token on the Connector page', MISSING: 'Send a token' } },
  });
  const raw = tokens.generate().raw;
  db.insert({ raw, revokedAt: new Date(T0) });
  assert.equal((await tokens.verify(`Bearer ${raw}`)).message, 'Revoked - create a new token on the Connector page');
  assert.equal((await tokens.verify(null)).message, 'Send a token');
  assert.equal((await tokens.verify('Bearer x')).message, 'Not a valid MCP token');
});

test('verify: lastUsedAt is written only when stale, fire-and-forget', async () => {
  const { tokens, db, clock } = setup();
  const fresh = tokens.generate().raw;
  db.insert({ raw: fresh, id: 'tok_fresh', lastUsedAt: new Date(T0 - 30 * 60 * 1000) });
  const stale = tokens.generate().raw;
  db.insert({ raw: stale, id: 'tok_stale', lastUsedAt: new Date(T0 - 2 * HOUR) });
  const never = tokens.generate().raw;
  db.insert({ raw: never, id: 'tok_never', lastUsedAt: null });

  assert.equal((await tokens.verify(`Bearer ${fresh}`)).ok, true);
  assert.equal(db.calls.update.length, 0);

  assert.equal((await tokens.verify(`Bearer ${stale}`)).ok, true);
  assert.equal((await tokens.verify(`Bearer ${never}`)).ok, true);
  assert.deepEqual(db.calls.update, [
    { where: { id: 'tok_stale' }, data: { lastUsedAt: new Date(T0) } },
    { where: { id: 'tok_never' }, data: { lastUsedAt: new Date(T0) } },
  ]);

  // Just touched: an immediate second call does not write again.
  await tick();
  await tokens.verify(`Bearer ${never}`);
  assert.equal(db.calls.update.length, 2);
  // An hour and a bit later it does.
  clock.t += HOUR + 1;
  await tokens.verify(`Bearer ${never}`);
  assert.equal(db.calls.update.length, 3);
});

test('verify: a failing lastUsedAt write is swallowed and reported via onError', async () => {
  const { tokens, db, errors } = setup();
  const raw = tokens.generate().raw;
  db.insert({ raw });
  db.update = async () => {
    throw new Error('db down');
  };
  assert.equal((await tokens.verify(`Bearer ${raw}`)).ok, true);
  await tick();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].context, 'lastUsedAt update failed');
  assert.equal(errors[0].error.message, 'db down');

  db.update = () => {
    throw new Error('sync throw');
  };
  assert.equal((await tokens.verify(`Bearer ${raw}`)).ok, true);
  assert.equal(errors.length, 2);
  assert.equal(errors[1].error.message, 'sync throw');
});

test('verify: a row missing a field fails closed (throws) instead of passing as live', async () => {
  const { tokens, db } = setup();
  const raw = tokens.generate().raw;
  const row = db.insert({ raw });
  delete row.revokedAt; // e.g. a wrapper whose select forgot revokedAt
  await assert.rejects(tokens.verify(`Bearer ${raw}`), (err) => err instanceof TypeError && /revokedAt/.test(err.message));
});

test('verify: database errors propagate (no silent INVALID)', async () => {
  const { tokens, db } = setup();
  db.findUnique = async () => {
    throw new Error('connection refused');
  };
  await assert.rejects(tokens.verify(`Bearer ${tokens.generate().raw}`), /connection refused/);
});

// ---------------------------------------------------------------- create

test('create: stores only the hash and display prefix, returns the raw token once', async () => {
  const { tokens, db } = setup();
  const created = await tokens.create({
    customerId: 'cust_1',
    name: '  Claude Desktop  ',
    scopes: ['sites:read', 'catalog:read', 'sites:read'],
    expiresInDays: 30,
  });

  assert.match(created.raw, /^gcf_mcp_[A-Za-z0-9_-]{43}$/);
  const { data } = db.calls.create[0];
  assert.deepEqual(data, {
    customerId: 'cust_1',
    name: 'Claude Desktop',
    prefix: created.raw.slice(0, 14),
    tokenHash: sha256(created.raw),
    scopes: ['catalog:read', 'sites:read'],
    expiresAt: new Date(T0 + 30 * DAY),
  });
  assert.equal(JSON.stringify(db.rows).includes(created.raw), false, 'raw token must never be stored');

  assert.deepEqual(Object.keys(created).sort(), [
    'createdAt',
    'expiresAt',
    'id',
    'lastUsedAt',
    'name',
    'prefix',
    'raw',
    'revokedAt',
    'scopes',
  ]);
  assert.equal(created.name, 'Claude Desktop');

  // The created token verifies end to end.
  const verified = await tokens.verify(`Bearer ${created.raw}`);
  assert.equal(verified.ok, true);
  assert.equal(verified.principal.tokenId, created.id);
});

test('create: expiry policy - capped at maxExpiryDays, null only when uncapped', async () => {
  const { tokens, db } = setup();
  const input = { customerId: 'cust_1', name: 'agent', scopes: ['catalog:read'] };
  for (const expiresInDays of [366, null, 0, -5, 1.5, '30', undefined, Number.NaN]) {
    await assert.rejects(
      tokens.create({ ...input, expiresInDays }),
      (err) => err instanceof McpTokenInputError && err.field === 'expiresInDays',
      String(expiresInDays)
    );
  }
  assert.equal(db.calls.create.length, 0);
  assert.equal((await tokens.create({ ...input, expiresInDays: 365 })).expiresAt.getTime(), T0 + 365 * DAY);

  const uncapped = setup({ config: { maxExpiryDays: null } });
  assert.equal((await uncapped.tokens.create({ ...input, expiresInDays: null })).expiresAt, null);
  assert.equal((await uncapped.tokens.create({ ...input, expiresInDays: 10_000 })).expiresAt.getTime(), T0 + 10_000 * DAY);
});

test('create: validates name, scopes and customerId before any write', async () => {
  const { tokens, db } = setup();
  const ok = { customerId: 'cust_1', name: 'agent', scopes: ['catalog:read'], expiresInDays: 30 };
  const cases = [
    [{ name: '' }, 'name'],
    [{ name: '    ' }, 'name'],
    [{ name: 'x'.repeat(61) }, 'name'],
    [{ name: 42 }, 'name'],
    [{ scopes: [] }, 'scopes'],
    [{ scopes: ['catalog:read', 'bogus'] }, 'scopes'],
    [{ scopes: 'catalog:read' }, 'scopes'],
    [{ customerId: '' }, 'customerId'],
    [{ customerId: undefined }, 'customerId'],
  ];
  for (const [patch, field] of cases) {
    await assert.rejects(
      tokens.create({ ...ok, ...patch }),
      (err) => err instanceof McpTokenInputError && err.field === field,
      JSON.stringify(patch)
    );
  }
  assert.equal(db.calls.create.length, 0);
  assert.equal((await tokens.create({ ...ok, name: 'x'.repeat(60) })).name.length, 60);
});

// ---------------------------------------------------------------- list / countActive

test('list: the customer\'s tokens newest first, never tokenHash or customerId', async () => {
  const { tokens, db, clock } = setup();
  await tokens.create({ customerId: 'cust_1', name: 'first', scopes: ['catalog:read'], expiresInDays: 30 });
  clock.t += 1000;
  await tokens.create({ customerId: 'cust_1', name: 'second', scopes: ['catalog:read'], expiresInDays: 30 });
  await tokens.create({ customerId: 'cust_2', name: 'someone else', scopes: ['catalog:read'], expiresInDays: 30 });

  const items = await tokens.list('cust_1');
  assert.deepEqual(db.calls.findMany[0], { where: { customerId: 'cust_1' }, orderBy: { createdAt: 'desc' } });
  assert.deepEqual(items.map((i) => i.name), ['second', 'first']);
  for (const item of items) {
    assert.equal('tokenHash' in item, false);
    assert.equal('customerId' in item, false);
    assert.equal('raw' in item, false);
  }
  await assert.rejects(tokens.list(''), McpTokenInputError);
});

test('countActive: excludes revoked and expired, includes never-expiring', async () => {
  const { tokens, db } = setup();
  db.insert({ raw: tokens.generate().raw, expiresAt: null });
  db.insert({ raw: tokens.generate().raw, expiresAt: new Date(T0 + DAY) });
  db.insert({ raw: tokens.generate().raw, expiresAt: new Date(T0 - 1) });
  db.insert({ raw: tokens.generate().raw, revokedAt: new Date(T0 - 1) });
  db.insert({ raw: tokens.generate().raw, customerId: 'cust_2' });
  assert.equal(await tokens.countActive('cust_1'), 2);
  assert.deepEqual(db.calls.count[0], {
    where: {
      customerId: 'cust_1',
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(T0) } }],
    },
  });
});

// ---------------------------------------------------------------- revoke / revokeAll

test('revoke: scoped to the owner and to live rows; true exactly once', async () => {
  const { tokens, db } = setup();
  const row = db.insert({ raw: tokens.generate().raw, id: 'tok_1', customerId: 'cust_1' });

  assert.equal(await tokens.revoke('cust_2', 'tok_1'), false);
  assert.equal(row.revokedAt, null, 'another customer cannot revoke it');
  assert.deepEqual(db.calls.updateMany[0], {
    where: { id: 'tok_1', customerId: 'cust_2', revokedAt: null },
    data: { revokedAt: new Date(T0) },
  });

  assert.equal(await tokens.revoke('cust_1', 'tok_1'), true);
  assert.deepEqual(row.revokedAt, new Date(T0));
  assert.equal(await tokens.revoke('cust_1', 'tok_1'), false, 'already revoked');
});

test('revokeAll: revokes every live token of one customer and returns the count', async () => {
  const { tokens, db } = setup();
  db.insert({ raw: tokens.generate().raw, customerId: 'cust_1' });
  db.insert({ raw: tokens.generate().raw, customerId: 'cust_1' });
  db.insert({ raw: tokens.generate().raw, customerId: 'cust_1', revokedAt: new Date(T0 - DAY) });
  const other = db.insert({ raw: tokens.generate().raw, customerId: 'cust_2' });

  assert.equal(await tokens.revokeAll('cust_1'), 2);
  assert.deepEqual(db.calls.updateMany[0], {
    where: { customerId: 'cust_1', revokedAt: null },
    data: { revokedAt: new Date(T0) },
  });
  assert.equal('id' in db.calls.updateMany[0].where, false);
  assert.equal(other.revokedAt, null);
  assert.equal(await tokens.revokeAll('cust_1'), 0);
});

test('revoke/revokeAll: a missing id never reaches the where clause (no table-wide revoke)', async () => {
  const { tokens, db } = setup();
  db.insert({ raw: tokens.generate().raw, customerId: 'cust_1' });
  for (const bad of [undefined, null, '', 42]) {
    await assert.rejects(tokens.revokeAll(bad), (e) => e instanceof McpTokenInputError && e.field === 'customerId');
    await assert.rejects(tokens.revoke(bad, 'tok_1'), (e) => e instanceof McpTokenInputError && e.field === 'customerId');
    await assert.rejects(tokens.revoke('cust_1', bad), (e) => e instanceof McpTokenInputError && e.field === 'tokenId');
    await assert.rejects(tokens.countActive(bad), McpTokenInputError);
  }
  assert.equal(db.calls.updateMany.length, 0);
  assert.equal(db.calls.count.length, 0);
});

// ---------------------------------------------------------------- paginate

test('paginate: has_more and next_offset only when a next page exists', () => {
  assert.deepEqual(paginate(['a', 'b'], 5, 0), {
    total: 5,
    count: 2,
    offset: 0,
    items: ['a', 'b'],
    has_more: true,
    next_offset: 2,
  });
  const last = paginate(['e'], 5, 4);
  assert.deepEqual(last, { total: 5, count: 1, offset: 4, items: ['e'], has_more: false });
  assert.equal('next_offset' in last, false);
  assert.deepEqual(paginate([], 0, 0), { total: 0, count: 0, offset: 0, items: [], has_more: false });
});

// ---------------------------------------------------------------- Tier-1 hygiene and packaging

const here = dirname(fileURLToPath(import.meta.url));

test('import hygiene: dist/mcp imports only node:crypto and its own files', () => {
  const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
  for (const dir of ['../dist/mcp', '../dist/cjs/mcp']) {
    const abs = join(here, dir);
    const files = readdirSync(abs).filter((f) => f.endsWith('.js'));
    assert.ok(files.length >= 6, `${dir} has the built module files`);
    for (const file of files) {
      const source = readFileSync(join(abs, file), 'utf8');
      for (const [, spec] of source.matchAll(specifier)) {
        assert.ok(
          spec === 'node:crypto' || spec.startsWith('./'),
          `${dir}/${file} imports "${spec}" - Tier-1 allows node:crypto and relative files only`
        );
      }
      assert.doesNotMatch(source, /['"](?:next\/|@prisma\/|@upstash\/)/, `${dir}/${file}`);
    }
  }
});

const PUBLIC_NAMES = [
  'ConfirmUnavailableError',
  'McpTokenInputError',
  'canonicalJson',
  'createConfirmGate',
  'createMcpTokens',
  'defineScopes',
  'extractBearer',
  'hashArgs',
  'paginate',
];

test('exports map: @aquaminh/app-core/mcp resolves for import and require with the same API', async () => {
  const esm = await import('@aquaminh/app-core/mcp');
  const cjs = createRequire(import.meta.url)('@aquaminh/app-core/mcp');
  assert.deepEqual(Object.keys(esm).sort(), PUBLIC_NAMES);
  assert.deepEqual(Object.keys(cjs).filter((k) => k !== '__esModule').sort(), PUBLIC_NAMES);

  const root = await import('@aquaminh/app-core');
  for (const name of PUBLIC_NAMES) assert.equal(typeof root[name], 'function', `root barrel re-exports ${name}`);

  // The CJS build is functional, not just loadable.
  const cjsTokens = cjs.createMcpTokens({
    tokens: fakeDelegate({ t: T0 }),
    tokenPrefix: 'zbr_mcp_',
    storeId: 'zeebrar-store',
    scopes: cjs.defineScopes(['catalog:read']),
    maxExpiryDays: null,
    resolvePrincipal: async () => ({ ok: false, error: 'INVALID', code: 'INVALID', message: 'x' }),
  });
  assert.equal(cjsTokens.hash(GOLDEN.zbr.raw), GOLDEN.zbr.hash);
});
