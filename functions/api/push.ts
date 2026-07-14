// إشعارات SYRPHY — Cloudflare Pages Function + WebCrypto Web Push
// المكتبة مدموجة محلياً — ما في أي تنزيل خارجي وقت البناء
// @ts-ignore
import { buildPushPayload } from "./webpush.js";

type PushSubscription = {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
};

export interface Env {
  DB: D1Database;
}

const SUBS_KEY = "push_subs";
const ADMIN_CREDS = ["AMRO:1573", "AMRO:971566135365"];
const VAPID = {
  subject: "mailto:syrphy@pages.dev",
  publicKey: "BPEfaUeEw5DAvQ_mtivM7Uvr3psOFZtrZVv6dNR91yFTS_pz4_9o-gZEmnSl6J86potg_kkNp5EpNJJrhE44CQs",
  privateKey: "x6btI5Qjmj0xiwsRWE0NrlPTB4znDHi3Fx1kRciBhy4",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-pin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
function json(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, { ...init, headers: { "Cache-Control": "no-store", ...CORS, ...(init.headers || {}) } });
}

let ready: Promise<unknown> | null = null;
function ensureTable(env: Env) {
  if (!ready) {
    ready = env.DB.exec(
      "CREATE TABLE IF NOT EXISTS store_items (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)"
    );
  }
  return ready;
}
async function readKey(env: Env, key: string, fallback: unknown) {
  const row = await env.DB.prepare("SELECT value FROM store_items WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row || row.value == null) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
async function writeKey(env: Env, key: string, value: unknown) {
  await env.DB.prepare(
    "INSERT INTO store_items (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(key, JSON.stringify(value), Date.now()).run();
}

type StoredSub = { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } };

export const onRequest: PagesFunction<Env> = async (context) => {
  const req = context.request;
  const env = context.env;

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!env.DB) return json({ error: "D1_binding_missing" }, { status: 500 });
  await ensureTable(env);

  if (req.method === "GET") return json({ publicKey: VAPID.publicKey });

  if (req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const type = String(body.type || "");

    if (type === "subscribe") {
      const sub = body.sub as StoredSub | undefined;
      if (!sub || !sub.endpoint || !sub.keys) return json({ error: "bad_request" }, { status: 400 });
      const subs = ((await readKey(env, SUBS_KEY, {})) || {}) as Record<string, StoredSub>;
      const id = btoa(sub.endpoint).slice(-40);
      subs[id] = sub;
      const ids = Object.keys(subs);
      while (ids.length > 2000) delete subs[ids.shift() as string];
      await writeKey(env, SUBS_KEY, subs);
      return json({ ok: true, count: Object.keys(subs).length });
    }

    if (type === "notify") {
      if (!ADMIN_CREDS.includes(String(req.headers.get("x-admin-pin") || "").replace(/\s+/g, "").toUpperCase())) return json({ error: "unauthorized" }, { status: 401 });
      const title = String(body.title || "SYRPHY 🇸🇾").slice(0, 80);
      const msg = String(body.body || "في خصومات قوية بالمتجر!").slice(0, 180);
      const subs = ((await readKey(env, SUBS_KEY, {})) || {}) as Record<string, StoredSub>;
      const message = { data: JSON.stringify({ title, body: msg, url: "/" }), options: { ttl: 86400 } };
      let sent = 0, dead = 0;
      await Promise.all(
        Object.entries(subs).map(async ([id, sub]) => {
          try {
            const subscription: PushSubscription = {
              endpoint: sub.endpoint,
              expirationTime: sub.expirationTime ?? null,
              keys: sub.keys,
            };
            const payload = await buildPushPayload(message, subscription, VAPID);
            const res = await fetch(sub.endpoint, payload);
            if (res.status === 404 || res.status === 410) { delete subs[id]; dead++; }
            else if (res.ok || res.status === 201) sent++;
          } catch (_) { /* تجاهل الاشتراك المعطوب */ }
        })
      );
      if (dead) await writeKey(env, SUBS_KEY, subs);
      return json({ ok: true, sent, total: Object.keys(subs).length });
    }

    return json({ error: "bad_request" }, { status: 400 });
  }
  return json({ error: "method_not_allowed" }, { status: 405 });
};
