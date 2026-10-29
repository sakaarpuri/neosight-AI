export interface PledgeEnv {
  DB: D1Database;
  PLEDGE_IP_SECRET?: string;
  PLEDGE_TURNSTILE_SECRET?: string;
  PLEDGE_TURNSTILE_SITE_KEY?: string;
}

export const STATES = new Set([
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka',
  'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
  'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
  'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman & Nicobar Islands', 'Chandigarh',
  'Dadra & Nagar Haveli and Daman & Diu', 'Delhi', 'Jammu & Kashmir', 'Ladakh',
  'Lakshadweep', 'Puducherry',
]);

type StateCount = { state: string; count: number };
type SavedPledge = { request_id: string; name: string; state: string; city: string | null };
const MAX_BODY_BYTES = 4096;
const WINDOW_SECONDS = 600;
const ATTEMPT_LIMIT = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cleanText = (value: unknown) => typeof value === 'string'
  ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ') : '';
const validText = (value: string) => [...value].length <= 50 && !/[\p{Cc}\p{Cf}<>]/u.test(value);

function response(body: Record<string, unknown>, status = 200, headers = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  }});
}
const failure = (error: string, status = 400, headers = {}) => response({ success: false, error }, status, headers);

async function readBody(request: Request): Promise<unknown> {
  if (!request.body || Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) {
    throw new RangeError('Request is too large or empty.');
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError('Request is too large.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function fingerprint(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

function stats(rows: StateCount[]) {
  const by_state = rows.map(row => ({ state: row.state, count: Number(row.count) }));
  return { total: by_state.reduce((sum, row) => sum + row.count, 0), by_state };
}
const statsQuery = (db: D1Database) => db.prepare(
  'SELECT state, count FROM pledge_totals WHERE count > 0 ORDER BY count DESC, state ASC'
);

async function savedResponse(request: Request, body: Record<string, unknown>): Promise<Response> {
  const updated_at = new Date().toISOString();
  // Refresh this data center's public snapshot before returning. An immediate reload
  // must not show the pre-save total. Other locations refresh within the 60s TTL.
  try {
    if (typeof caches !== 'undefined') {
      await caches.default.put(new Request(new URL('/api/stats', request.url).toString()),
        response({ success: true, total: body.total, by_state: body.by_state, updated_at }, 200,
          { 'cache-control': 'public, max-age=0, s-maxage=60' }));
    }
  } catch { /* Cache failure cannot turn a confirmed database write into a failure. */ }
  return response({ ...body, updated_at });
}

export async function handlePledgeStats(request: Request, env: PledgeEnv, ctx?: ExecutionContext): Promise<Response> {
  const cache = typeof caches === 'undefined' ? undefined : caches.default;
  // Strip query strings so arbitrary URLs cannot multiply database/cache misses.
  const cacheKey = new Request(new URL('/api/stats', request.url).toString());
  try {
    const cached = await cache?.match(cacheKey);
    if (cached) return cached;
  } catch { /* Cache availability must not affect the database response. */ }
  try {
    const { results } = await statsQuery(env.DB).all<StateCount>();
    const result = response({ success: true, ...stats(results), updated_at: new Date().toISOString() }, 200,
      { 'cache-control': 'public, max-age=0, s-maxage=60' });
    if (cache && ctx) ctx.waitUntil(cache.put(cacheKey, result.clone()).catch(() => {}));
    return result;
  } catch {
    console.error('pledge_stats_unavailable');
    return failure('Pledge totals are temporarily unavailable. Please try again shortly.', 503);
  }
}

export async function handlePledge(request: Request, env: PledgeEnv): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return failure('Please submit the pledge from this website.', 403);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return failure('Send a JSON request.', 415);
  }
  let parsed: unknown;
  try { parsed = await readBody(request); }
  catch (error) { return failure(error instanceof RangeError ? 'Request is too large.' : 'Invalid JSON body.', error instanceof RangeError ? 413 : 400); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return failure('Invalid pledge details.');
  const body = parsed as Record<string, unknown>;
  const name = cleanText(body.name);
  const state = cleanText(body.state);
  const city = cleanText(body.city) || null;
  if (!name || !validText(name)) return failure('Please enter a name of up to 50 characters.');
  if (!STATES.has(state)) return failure('Please select a valid state or union territory.');
  if (body.city !== undefined && body.city !== null && typeof body.city !== 'string') return failure('Please enter a valid city.');
  if (city && !validText(city)) return failure('Please enter a city of up to 50 characters.');
  if (body.pledgeAccepted !== true) return failure('Please tick the pledge to confirm your support.');
  if (typeof body.requestId !== 'string' || !UUID.test(body.requestId)) return failure('Please reload the page and try again.');
  if (body.website !== '' || typeof body.startedAt !== 'number' || !Number.isFinite(body.startedAt)
      || body.startedAt <= 0 || Date.now() - body.startedAt < 1500) return failure('Please take a moment, then try again.');

  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (!env.PLEDGE_IP_SECRET || env.PLEDGE_IP_SECRET.length < 32 || !env.PLEDGE_TURNSTILE_SECRET || !env.PLEDGE_TURNSTILE_SITE_KEY
      || (!local && (/^[123]x0{10}/.test(env.PLEDGE_TURNSTILE_SECRET) || /^[123]x0{10}/.test(env.PLEDGE_TURNSTILE_SITE_KEY)))) {
    return failure('Pledge signup is temporarily unavailable. Please try again shortly.', 503);
  }
  const ip = request.headers.get('cf-connecting-ip') || (local ? 'local-development' : '');
  if (!ip) return failure('Pledge signup is temporarily unavailable. Please try again shortly.', 503);

  try {
    const ipHash = await fingerprint(env.PLEDGE_IP_SECRET, `ip:${ip}`);
    const dedupKey = await fingerprint(env.PLEDGE_IP_SECRET, `pledge:${ipHash}\0${name.toLowerCase()}\0${state}`);
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / WINDOW_SECONDS) * WINDOW_SECONDS;
    const rate = await env.DB.prepare(`
      INSERT INTO pledge_rate_limits(ip_hash, window_start, attempts) VALUES (?1, ?2, 1)
      ON CONFLICT(ip_hash) DO UPDATE SET
        attempts = CASE WHEN window_start = excluded.window_start THEN attempts + 1 ELSE 1 END,
        window_start = excluded.window_start
      RETURNING attempts
    `).bind(ipHash, windowStart).first<{ attempts: number }>();
    if (!rate || rate.attempts > ATTEMPT_LIMIT) {
      return failure('Too many attempts. Please try again in a few minutes.', 429,
        { 'retry-after': String(windowStart + WINDOW_SECONDS - now) });
    }
    // Bound retention of short-lived rate-limit identifiers without a separate cron job.
    await env.DB.prepare(`DELETE FROM pledge_rate_limits WHERE ip_hash IN
      (SELECT ip_hash FROM pledge_rate_limits WHERE window_start < ?1 LIMIT 100)`)
      .bind(now - 86400).run();

    const existing = await env.DB.prepare(
      'SELECT request_id, name, state, city FROM pledges WHERE request_id = ?1 OR dedup_key = ?2 ORDER BY request_id = ?1 DESC LIMIT 1'
    ).bind(body.requestId, dedupKey).first<SavedPledge>();
    if (existing?.request_id === body.requestId
        && (existing.name !== name || existing.state !== state || existing.city !== city)) {
      return failure('These pledge details have changed. Please reload the page and try again.', 409);
    }
    // A retry of a saved request does not need to reuse an already-consumed CAPTCHA token.
    if (existing) {
      const { results } = await statsQuery(env.DB).all<StateCount>();
      return savedResponse(request, { success: true, already_joined: true, state: existing.state, ...stats(results) });
    }
    if (typeof body.turnstileToken !== 'string' || !body.turnstileToken || body.turnstileToken.length > 2048) {
      return failure('Please complete the security check and try again.');
    }
    let verification: { success?: boolean; hostname?: string; action?: string };
    try {
      const verified = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: new URLSearchParams({ secret: env.PLEDGE_TURNSTILE_SECRET, response: body.turnstileToken, remoteip: ip }),
        signal: AbortSignal.timeout(8000),
      });
      if (!verified.ok) throw new Error('verification unavailable');
      verification = await verified.json();
    } catch { return failure('The security check is temporarily unavailable. Please try again.', 503); }
    if (!verification.success || (!local && (verification.hostname !== url.hostname || verification.action !== 'pledge'))) {
      return failure('Please complete the security check and try again.');
    }

    // D1 batch executes atomically: insert, identity read and totals share one transaction.
    // Unique keys make network retries and concurrent duplicate submissions count once.
    const result = await env.DB.batch([
      env.DB.prepare('INSERT INTO pledges (request_id, dedup_key, name, state, city) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING')
        .bind(body.requestId, dedupKey, name, state, city),
      env.DB.prepare('SELECT request_id, name, state, city FROM pledges WHERE request_id = ?1 OR dedup_key = ?2 ORDER BY request_id = ?1 DESC LIMIT 1')
        .bind(body.requestId, dedupKey),
      statsQuery(env.DB),
    ]);
    const saved = result[1].results[0] as SavedPledge | undefined;
    if (!saved) throw new Error('insert not confirmed');
    if (saved.request_id === body.requestId && (saved.name !== name || saved.state !== state || saved.city !== city)) {
      return failure('These pledge details have changed. Please reload the page and try again.', 409);
    }
    return savedResponse(request, { success: true, already_joined: result[0].meta.changes === 0,
      state: saved.state, ...stats(result[2].results as StateCount[]) });
  } catch {
    // Never put names, request bodies, raw IPs, city or provider responses in logs.
    console.error('pledge_save_unavailable');
    return failure('We could not confirm your pledge. Please retry with the same details; you will only be counted once.', 503);
  }
}
