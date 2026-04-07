export interface Env {
  DB: D1Database;
  STATS?: KVNamespace;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
}

type WaitlistBody = {
  email?: string;
  turnstileToken?: string;
  website?: string;
  startedAt?: number | string;
};

type ApiResponse =
  | { success: true; position: number; already_joined?: boolean; message?: string }
  | { success: false; error: string };

const WAITLIST_IP_LIMIT = 12;
const WAITLIST_IP_WINDOW_SECONDS = 60 * 10;
const WAITLIST_EMAIL_LIMIT = 4;
const WAITLIST_EMAIL_WINDOW_SECONDS = 60 * 60;

const json = (body: ApiResponse, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });

const healthJson = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const isValidEmail = (email: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;

const MIN_FORM_FILL_MS = 1500;

const getClientIp = (request: Request) => {
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp;

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";

  return "unknown";
};

async function incrementCounter(
  kv: KVNamespace | undefined,
  key: string,
  expirationTtl: number
): Promise<number> {
  if (!kv) return 0;

  const current = Number((await kv.get(key)) || "0") || 0;
  const next = current + 1;
  await kv.put(key, String(next), { expirationTtl });
  return next;
}

async function enforceRateLimits(request: Request, env: Env, email: string): Promise<Response | null> {
  if (!env.STATS) return null;

  const ip = getClientIp(request);
  const ipCount = await incrementCounter(
    env.STATS,
    `rate:waitlist:ip:${ip}`,
    WAITLIST_IP_WINDOW_SECONDS
  );

  if (ipCount > WAITLIST_IP_LIMIT) {
    return healthJson(
      {
        success: false,
        error: "Too many attempts. Please try again in a few minutes.",
      },
      429
    );
  }

  const emailCount = await incrementCounter(
    env.STATS,
    `rate:waitlist:email:${email}`,
    WAITLIST_EMAIL_WINDOW_SECONDS
  );

  if (emailCount > WAITLIST_EMAIL_LIMIT) {
    return healthJson(
      {
        success: false,
        error: "Too many attempts for this email. Please try again later.",
      },
      429
    );
  }

  return null;
}

async function logWorkerEvent(
  env: Env,
  type: "waitlist_success" | "waitlist_duplicate" | "waitlist_error",
  details: Record<string, unknown>
): Promise<void> {
  if (!env.STATS) return;

  const now = new Date();
  const iso = now.toISOString();
  const day = iso.slice(0, 10);

  await env.STATS.put(`monitor:last_${type}`, JSON.stringify({ at: iso, ...details }), {
    expirationTtl: 60 * 60 * 24 * 7,
  });

  const dailyKey = `monitor:${type}:${day}`;
  const current = Number((await env.STATS.get(dailyKey)) || "0") || 0;
  await env.STATS.put(dailyKey, String(current + 1), { expirationTtl: 60 * 60 * 24 * 14 });
}

async function getWaitlistPosition(db: D1Database, email: string): Promise<number> {
  const result = await db
    .prepare(
      `SELECT COUNT(*) AS position
       FROM waitlist
       WHERE id <= (SELECT id FROM waitlist WHERE email = ?1)`
    )
    .bind(email)
    .first<{ position: number | string | null }>();

  const value = result?.position ?? 0;
  return typeof value === "string" ? parseInt(value, 10) : Number(value);
}

async function handleWaitlist(request: Request, env: Env): Promise<Response> {
  let body: WaitlistBody;

  try {
    body = (await request.json()) as WaitlistBody;
  } catch {
    return json({ success: false, error: "Invalid JSON body." }, 400);
  }

  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken : "";
  const honeypot = typeof body.website === "string" ? body.website.trim() : "";
  const startedAt = Number(body.startedAt);

  if (honeypot) {
    return json({ success: false, error: "Could not join the waitlist right now." }, 400);
  }

  if (!email) {
    return json({ success: false, error: "Email is required." }, 400);
  }

  if (!isValidEmail(email)) {
    return json({ success: false, error: "Please enter a valid email address." }, 400);
  }

  if (Number.isFinite(startedAt) && Date.now() - startedAt < MIN_FORM_FILL_MS) {
    return json({ success: false, error: "Please try again." }, 400);
  }

  const rateLimitResponse = await enforceRateLimits(request, env, email);
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  if (env.TURNSTILE_SECRET) {
    if (!turnstileToken) {
      return json({ success: false, error: "Please complete the security check." }, 400);
    }

    const verification = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET,
        response: turnstileToken,
        remoteip: getClientIp(request),
      }),
    });

    const verificationJson = await verification.json<{
      success?: boolean;
      "error-codes"?: string[];
    }>();

    if (!verification.ok || !verificationJson.success) {
      await logWorkerEvent(env, "waitlist_error", {
        message: "turnstile_failed",
        codes: verificationJson?.["error-codes"] || [],
        ip: getClientIp(request),
      });
      return json({ success: false, error: "Please complete the security check and try again." }, 400);
    }
  }

  try {
    await env.DB.prepare("INSERT INTO waitlist (email) VALUES (?1)").bind(email).run();
    const position = await getWaitlistPosition(env.DB, email);

    if (env.STATS) {
      void env.STATS.put(
        "waitlist_count",
        JSON.stringify({ count: position, updated_at: new Date().toISOString() }),
        { expirationTtl: 60 }
      );
    }

    await logWorkerEvent(env, "waitlist_success", {
      position,
      ip: getClientIp(request),
    });

    return json({
      success: true,
      position,
      message: "You're on the list.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.toLowerCase().includes("unique")) {
      const position = await getWaitlistPosition(env.DB, email);
      await logWorkerEvent(env, "waitlist_duplicate", {
        position,
        ip: getClientIp(request),
      });
      return json({
        success: true,
        position,
        already_joined: true,
        message: "You're already on the list.",
      });
    }

    console.error("waitlist_error", {
      message,
      ip: getClientIp(request),
    });
    await logWorkerEvent(env, "waitlist_error", {
      message,
      ip: getClientIp(request),
    });

    return json({ success: false, error: "Could not join the waitlist right now." }, 500);
  }
}

async function handleHealth(env: Env): Promise<Response> {
  const now = new Date().toISOString();
  let dbOk = false;
  let dbError: string | null = null;

  try {
    await env.DB.prepare("SELECT 1 AS ok").first();
    dbOk = true;
  } catch (error) {
    dbError = error instanceof Error ? error.message : String(error);
  }

  return healthJson({
    ok: dbOk,
    service: "veoclara-api",
    timestamp: now,
    checks: {
      db: dbOk,
      kvConfigured: Boolean(env.STATS),
      turnstileConfigured: Boolean(env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY),
    },
    error: dbError,
  });
}

function handleClientConfig(env: Env): Response {
  return healthJson({
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return json({ success: true, position: 0, message: "ok" });
    }

    if (url.pathname === "/api/waitlist" && request.method === "POST") {
      return handleWaitlist(request, env);
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return handleHealth(env);
    }

    if (url.pathname === "/api/client-config" && request.method === "GET") {
      return handleClientConfig(env);
    }

    return json({ success: false, error: "Not found." }, 404);
  },
};
