export interface Env {
  DB: D1Database;
  STATS?: KVNamespace;
}

type WaitlistBody = {
  email?: string;
};

type ApiResponse =
  | { success: true; position: number; already_joined?: boolean; message?: string }
  | { success: false; error: string };

const json = (body: ApiResponse, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const isValidEmail = (email: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;

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

  if (!email) {
    return json({ success: false, error: "Email is required." }, 400);
  }

  if (!isValidEmail(email)) {
    return json({ success: false, error: "Please enter a valid email address." }, 400);
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

    return json({
      success: true,
      position,
      message: "You're on the list.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.toLowerCase().includes("unique")) {
      const position = await getWaitlistPosition(env.DB, email);
      return json({
        success: true,
        position,
        already_joined: true,
        message: "You're already on the list.",
      });
    }

    return json({ success: false, error: "Could not join the waitlist right now." }, 500);
  }
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
      return new Response("ok", {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      });
    }

    return json({ success: false, error: "Not found." }, 404);
  },
};
