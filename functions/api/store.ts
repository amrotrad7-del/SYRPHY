interface Env {
  DB: D1Database;
}

const ADMIN_CRED = "Amro:Amro@##123";

const PRICING_KEY = "saraya_pricing";
const ORDERS_KEY = "saraya_orders";
const VISITORS_KEY = "saraya_visitors";
const SETTINGS_KEY = "saraya_settings";

type Pricing = { basic: number; full: number; vip: number };
type Order = {
  id: string;
  ts: number;
  name: string;
  phone: string;
  template: string;
  tier: string;
  notes: string;
  status: "pending" | "accepted" | "rejected" | "contacted";
};
type Visitors = { total: number; devs: string[] };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-pin",
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS, ...(init.headers || {}) },
  });
}

async function ensureTable(env: Env) {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS store_items (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)"
  );
}

async function readKey<T>(env: Env, key: string, fallback: T): Promise<T> {
  try {
    const row = await env.DB.prepare("SELECT value FROM store_items WHERE key = ?").bind(key).first<{ value: string }>();
    if (!row) return fallback;
    return JSON.parse(row.value) as T;
  } catch (_) {
    return fallback;
  }
}

async function writeKey(env: Env, key: string, value: unknown) {
  await env.DB.prepare(
    "INSERT INTO store_items (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(key, JSON.stringify(value), Date.now()).run();
}

function checkPin(req: Request): "admin" | "guest" {
  const pin = (req.headers.get("x-admin-pin") || "").trim();
  return pin === ADMIN_CRED ? "admin" : "guest";
}

function clientIP(req: Request): string {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown";
}

const DEFAULT_PRICING: Pricing = { basic: 15, full: 27, vip: 45 };

export const onRequest: PagesFunction<Env> = async (context) => {
  try {
    return await handleAll(context);
  } catch (e) {
    const err = e as Error;
    return json({ error: "crash", detail: String(err?.message || e), at: String(err?.stack || "").split("\n")[1] || "" }, { status: 500 });
  }
};

const handleAll: PagesFunction<Env> = async (context) => {
  const req = context.request;
  const env = context.env;

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  await ensureTable(env);
  const role = checkPin(req);

  if (req.method === "GET") {
    const pricing = await readKey<Pricing>(env, PRICING_KEY, DEFAULT_PRICING);
    const visitors = await readKey<Visitors>(env, VISITORS_KEY, { total: 0, devs: [] });
    const settings = await readKey<Record<string, unknown>>(env, SETTINGS_KEY, {});
    const base: Record<string, unknown> = { ok: true, pricing, visitors: visitors.total, settings, role };
    if (role === "admin") {
      const orders = await readKey<Order[]>(env, ORDERS_KEY, []);
      base.orders = orders.slice().reverse();
    }
    return json(base);
  }

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch (_) {
    return json({ error: "bad_json" }, { status: 400 });
  }
  const type = String(body.type || "");

  if (type === "visit") {
    const dev = String(body.dev || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
    const key = dev || "ip:" + clientIP(req);
    const visitors = await readKey<Visitors>(env, VISITORS_KEY, { total: 0, devs: [] });
    if (!visitors.devs.includes(key)) {
      visitors.devs.push(key);
      if (visitors.devs.length > 20000) visitors.devs.shift();
      visitors.total = (visitors.total || 0) + 1;
      await writeKey(env, VISITORS_KEY, visitors);
    }
    return json({ ok: true, total: visitors.total });
  }

  if (type === "admin_check") {
    const pin = String(body.pin || "").trim();
    return json({ ok: pin === ADMIN_CRED });
  }

  if (type === "set_price") {
    if (role !== "admin") return json({ error: "unauthorized" }, { status: 401 });
    const tier = String(body.tier || "");
    if (!["basic", "full", "vip"].includes(tier)) return json({ error: "bad_tier" }, { status: 400 });
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) return json({ error: "bad_price" }, { status: 400 });
    const pricing = await readKey<Pricing>(env, PRICING_KEY, DEFAULT_PRICING);
    (pricing as unknown as Record<string, number>)[tier] = Math.round(price * 100) / 100;
    await writeKey(env, PRICING_KEY, pricing);
    return json({ ok: true, pricing });
  }

  if (type === "set_setting") {
    if (role !== "admin") return json({ error: "unauthorized" }, { status: 401 });
    const key = String(body.key || "").slice(0, 60);
    if (!key) return json({ error: "bad_key" }, { status: 400 });
    const settings = await readKey<Record<string, unknown>>(env, SETTINGS_KEY, {});
    settings[key] = body.value ?? "";
    await writeKey(env, SETTINGS_KEY, settings);
    return json({ ok: true, settings });
  }

  if (type === "order_create") {
    const name = String(body.name || "").trim().slice(0, 80);
    const phone = String(body.phone || "").trim().slice(0, 30);
    if (!name || !phone) return json({ error: "bad_request" }, { status: 400 });
    const order: Order = {
      id: "ORD-" + Date.now().toString(36).toUpperCase(),
      ts: Date.now(),
      name,
      phone,
      template: String(body.template || "").slice(0, 60),
      tier: String(body.tier || "").slice(0, 20),
      notes: String(body.notes || "").slice(0, 300),
      status: "pending",
    };
    const orders = await readKey<Order[]>(env, ORDERS_KEY, []);
    orders.push(order);
    while (orders.length > 500) orders.shift();
    await writeKey(env, ORDERS_KEY, orders);
    return json({ ok: true, id: order.id });
  }

  if (type === "order_status") {
    if (role !== "admin") return json({ error: "unauthorized" }, { status: 401 });
    const id = String(body.id || "");
    const status = String(body.status || "");
    if (!["pending", "accepted", "rejected", "contacted"].includes(status)) return json({ error: "bad_status" }, { status: 400 });
    const orders = await readKey<Order[]>(env, ORDERS_KEY, []);
    const o = orders.find((x) => x.id === id);
    if (!o) return json({ error: "not_found" }, { status: 404 });
    o.status = status as Order["status"];
    await writeKey(env, ORDERS_KEY, orders);
    return json({ ok: true });
  }

  return json({ error: "unknown_type" }, { status: 400 });
};
