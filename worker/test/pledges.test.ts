import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import worker from '../src/index.ts';

// Real SQLite executes the production migration, constraints, triggers and SQL.
// The small adapter supplies the D1 statement API; no SQL results are invented.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0001_pledges.sql', import.meta.url), 'utf8'));
  function prepare(query) {
    let args = [];
    const positions = [];
    const sql = query.replace(/\?(\d+)/g, (_, index) => { positions.push(Number(index) - 1); return '?'; });
    const parameters = () => positions.map(index => args[index]);
    return {
      bind(...values) { args = values; return this; },
      async first() { return sqlite.prepare(sql).get(...parameters()) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...parameters()), success: true }; },
      async run() { const meta = sqlite.prepare(sql).run(...parameters()); return { success: true, results: [], meta }; },
      _execute() {
        const statement = sqlite.prepare(sql);
        const results = statement.columns().length ? statement.all(...parameters()) : [];
        if (!statement.columns().length) statement.run(...parameters());
        return { results, success: true, meta: { changes: Number(sqlite.prepare('SELECT changes() AS n').get().n) } };
      },
    };
  }
  return { sqlite, prepare, async batch(statements) {
    sqlite.exec('BEGIN');
    try { const results = statements.map(s => s._execute()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }};
}

const body = (overrides = {}) => ({ name: 'Asha', state: 'Delhi', city: 'New Delhi',
  pledgeAccepted: true, requestId: randomUUID(), startedAt: Date.now() - 5000,
  website: '', turnstileToken: 'valid-token', ...overrides });
function request(data, options = {}) {
  return new Request('https://veoclara.com/api/submit', {
    method: 'POST', headers: { 'content-type': 'application/json', 'origin': 'https://veoclara.com',
      'cf-connecting-ip': '203.0.113.7', ...options.headers },
    body: JSON.stringify(data),
  });
}
const environment = DB => ({ DB, PLEDGE_IP_SECRET: 'unit-test-secret-at-least-32-characters',
  PLEDGE_TURNSTILE_SITE_KEY: 'production-site-key', PLEDGE_TURNSTILE_SECRET: 'production-secret' });
const fetchStats = env => worker.fetch(new Request('https://veoclara.com/api/stats'), env).then(r => r.json());
const verify = () => Response.json({ success: true, hostname: 'veoclara.com', action: 'pledge' });

test('persistent pledge, retry, case-insensitive person dedup and genuine state totals', async t => {
  const DB = database(); t.after(() => DB.sqlite.close());
  t.mock.method(globalThis, 'fetch', async () => verify());
  const env = environment(DB);
  assert.equal((await fetchStats(env)).total, 0);
  const pledge = body();
  let response = await worker.fetch(request(pledge), env);
  assert.equal(response.status, 200);
  const { updated_at, ...saved } = await response.json();
  assert.ok(Number.isFinite(Date.parse(updated_at)));
  assert.deepEqual(saved, { success: true, already_joined: false, state: 'Delhi',
    total: 1, by_state: [{ state: 'Delhi', count: 1 }] });
  // Lost network responses can be retried with a spent/missing token.
  response = await worker.fetch(request({ ...pledge, turnstileToken: '' }), env);
  assert.equal((await response.json()).already_joined, true);
  response = await worker.fetch(request(body({ name: '  ASHA  ', city: '' })), env);
  assert.equal((await response.json()).already_joined, true);
  await worker.fetch(request(body({ name: 'Ravi' })), env);
  await worker.fetch(request(body({ name: 'Priya', state: 'Kerala' })), env);
  assert.deepEqual((await fetchStats(env)).by_state, [{ state: 'Delhi', count: 2 }, { state: 'Kerala', count: 1 }]);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM pledges').get().n, 3);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM waitlist').get().n, 0);
  assert.equal(globalThis.fetch.mock.calls.length, 3);
  const stored = JSON.stringify(DB.sqlite.prepare('SELECT * FROM pledges').all());
  assert.ok(!stored.includes('203.0.113.7'));
  assert.match(DB.sqlite.prepare('SELECT dedup_key FROM pledges LIMIT 1').get().dedup_key, /^[a-f0-9]{64}$/);
});

test('concurrent duplicate requests count once and deletion keeps aggregate totals correct', async t => {
  const DB = database(); t.after(() => DB.sqlite.close());
  t.mock.method(globalThis, 'fetch', async () => verify());
  const env = environment(DB), pledge = body();
  const results = await Promise.all(Array.from({ length: 8 }, () => worker.fetch(request(pledge), env)));
  for (const result of results) assert.equal(result.status, 200);
  assert.equal((await fetchStats(env)).total, 1);
  DB.sqlite.exec('DELETE FROM pledges');
  assert.equal((await fetchStats(env)).total, 0);
});

test('malformed values, missing consent, honeypot and oversized requests never save', async t => {
  const DB = database(); t.after(() => DB.sqlite.close());
  const env = environment(DB);
  for (const data of [null, [], {}, body({ name: '' }), body({ name: 'A'.repeat(51) }),
    body({ state: 'Not a state' }), body({ city: 42 }), body({ city: 'X'.repeat(51) }), body({ pledgeAccepted: false }),
    body({ requestId: 'wrong' }), body({ website: 'bot' }), body({ startedAt: Date.now() + 10000 }),
    body({ startedAt: undefined }), body({ turnstileToken: '' })]) {
    const response = await worker.fetch(request(data), env);
    assert.equal(response.status, 400, JSON.stringify(data));
    assert.equal((await response.json()).success, false);
  }
  const malformed = new Request('https://veoclara.com/api/submit', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal((await worker.fetch(malformed, env)).status, 400);
  assert.equal((await worker.fetch(request(body({ name: 'X'.repeat(5000) })), env)).status, 413);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM pledges').get().n, 0);
});

test('foreign origin, content type and wrong methods are rejected', async t => {
  const DB = database(); t.after(() => DB.sqlite.close()); const env = environment(DB);
  assert.equal((await worker.fetch(request(body(), { headers: { origin: 'https://other.example' } }), env)).status, 403);
  assert.equal((await worker.fetch(request(body(), { headers: { 'content-type': 'text/plain' } }), env)).status, 415);
  assert.equal((await worker.fetch(new Request('https://veoclara.com/api/submit'), env)).status, 405);
  assert.equal((await worker.fetch(new Request('https://veoclara.com/api/stats', { method: 'POST' }), env)).status, 405);
});

test('missing configuration and failed/wrong-host/wrong-action verification fail closed', async t => {
  const DB = database(); t.after(() => DB.sqlite.close()); const env = environment(DB);
  for (const key of ['PLEDGE_IP_SECRET', 'PLEDGE_TURNSTILE_SECRET', 'PLEDGE_TURNSTILE_SITE_KEY']) {
    assert.equal((await worker.fetch(request(body()), { ...env, [key]: '' })).status, 503);
  }
  assert.equal((await worker.fetch(request(body()), { ...env, PLEDGE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' })).status, 503);
  const mocked = t.mock.method(globalThis, 'fetch', async () => Response.json({ success: false }));
  assert.equal((await worker.fetch(request(body()), env)).status, 400);
  for (const data of [{ success: true, hostname: 'other.example', action: 'pledge' },
    { success: true, hostname: 'veoclara.com', action: 'login' }]) {
    mocked.mock.mockImplementation(async () => Response.json(data));
    assert.equal((await worker.fetch(request(body()), env)).status, 400);
  }
  mocked.mock.mockImplementation(async () => { throw new Error('provider down'); });
  assert.equal((await worker.fetch(request(body()), env)).status, 503);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM pledges').get().n, 0);
});

test('atomic fixed-window rate limiter rejects bursts with Retry-After', async t => {
  const DB = database(); t.after(() => DB.sqlite.close()); const env = environment(DB);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ success: false }));
  const results = await Promise.all(Array.from({ length: 18 }, () => worker.fetch(request(body()), env)));
  assert.equal(results.filter(r => r.status === 429).length, 6);
  const limited = results.find(r => r.status === 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(DB.sqlite.prepare('SELECT attempts FROM pledge_rate_limits').get().attempts, 18);
});

test('request id cannot be reused with changed details', async t => {
  const DB = database(); t.after(() => DB.sqlite.close()); const env = environment(DB);
  t.mock.method(globalThis, 'fetch', async () => verify()); const pledge = body();
  await worker.fetch(request(pledge), env);
  const response = await worker.fetch(request({ ...pledge, name: 'Someone else' }), env);
  assert.equal(response.status, 409);
  assert.equal((await fetchStats(env)).total, 1);
});

test('database outage gives visible-safe structured errors without leaking details', async () => {
  const brokenDB = { prepare() { throw new Error('private database details'); } };
  const env = environment(brokenDB);
  for (const response of [await worker.fetch(request(body()), env),
    await worker.fetch(new Request('https://veoclara.com/api/stats'), env)]) {
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes('private database details'));
  }
});

test('existing waitlist and client configuration retain their API contract', async t => {
  const DB = database(); t.after(() => DB.sqlite.close()); const env = environment(DB);
  const config = await worker.fetch(new Request('https://veoclara.com/api/client-config'), env);
  const clientConfig = await config.json();
  assert.equal(clientConfig.pledgeTurnstileSiteKey, env.PLEDGE_TURNSTILE_SITE_KEY);
  assert.equal(clientConfig.turnstileSiteKey, null);
  const nullBody = new Request('https://veoclara.com/api/waitlist', { method: 'POST', body: 'null' });
  assert.equal((await worker.fetch(nullBody, env)).status, 400);
  const waitlistEnv = { DB };
  const req = () => new Request('https://veoclara.com/api/waitlist', { method: 'POST',
    body: JSON.stringify({ email: 'audit@example.invalid', website: '', startedAt: Date.now() - 5000 }) });
  assert.equal((await (await worker.fetch(req(), waitlistEnv)).json()).position, 1);
  assert.equal((await (await worker.fetch(req(), waitlistEnv)).json()).already_joined, true);
});

test('saved pledge refreshes the public cache, and cache failure cannot undo a successful save', async t => {
  const DB = database(); t.after(() => DB.sqlite.close()); const env = environment(DB);
  t.mock.method(globalThis, 'fetch', async () => verify());
  const entries = new Map();
  let cacheFailed = false;
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
    async match(key) { if (cacheFailed) throw new Error('cache down'); return entries.get(key.url)?.clone(); },
    async put(key, value) { if (cacheFailed) throw new Error('cache down'); entries.set(key.url, value.clone()); },
  }}});
  t.after(() => { delete globalThis.caches; });
  const ctx = { waitUntil(promise) { return promise; } };
  await worker.fetch(new Request('https://veoclara.com/api/stats?ignored=one'), env, ctx);
  assert.equal(entries.size, 1);
  assert.equal((await fetchStats(env)).total, 0);
  assert.equal((await worker.fetch(request(body()), env)).status, 200);
  const refreshed = await fetchStats(env);
  assert.equal(refreshed.total, 1);
  assert.ok(!JSON.stringify(refreshed).includes('Asha'));
  cacheFailed = true;
  assert.equal((await worker.fetch(request(body({ name: 'Second pledge' })), env)).status, 200);
  assert.equal((await fetchStats(env)).total, 2);
});
