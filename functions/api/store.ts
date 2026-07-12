// SYRPHY — Cloudflare Pages Function + D1
// كامل منطق المتجر: كتالوج، زيارات، تواجد، سلات متروكة، طلبات وتتبع،
// تقييمات، نقاط، أكواد لمرة وحدة، دولاب الحظ، قفل محاولات الدخول.

export interface Env {
  DB: D1Database;
}

type StoreData = { products: unknown[]; coupons: unknown[] };

const STORE_KEY = "catalog";
const ANALYTICS_KEY = "analytics";
const ABANDONED_KEY = "abandoned";
const PRESENCE_KEY = "presence";
const RATE_KEY = "ratelimit";
const ORDERS_KEY = "orders";
const SITE_REV_KEY = "site_reviews";
const PROD_REV_KEY = "prod_reviews";
const OTC_KEY = "otc_codes";
const WHEEL_KEY = "wheel_spins";
const POINTS_KEY = "points_ledger";
const REJECTED_KEY = "rejected_reviews";
const SOLD_KEY = "sold_counts";
const ACCOUNTS_KEY = "accounts";
const COMPLAINTS_KEY = "complaints";
const DIS_COUNTER_KEY = "dis_counter";
const REVIEW_DEVS_KEY = "review_reward_devs";
const BAD_WORDS = ["كس","طيز","شرموط","عرص","خرا","خرة","زبالة","زباله","حقير","نصاب","حرامي","حرامية","كذاب","احتيال","نصب عليكن","غشاش","سيء","سيئ","سئ","زفت","تعبان","خايس","فاشل","اسوأ","أسوأ","اسوء","لا انصح","لا أنصح","ما بنصح","احذرو","احذروا","حذاري","قذر","وسخ","تافه","بشع","fuck","shit","scam","fraud","fake","worst"];
function hasBadWords(t: string) {
  const s = (t || "").toLowerCase();
  return BAD_WORDS.some((w) => s.includes(w));
}

const ADMIN_CRED = "AMRO:1573";
const USER_CRED = "USER:157";
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const SPIN_COOLDOWN = 29 * 60 * 60 * 1000;
const STATUSES = ["بانتظار التأكيد", "تم التأكيد", "جاري التجهيز", "وصلت للمطار", "وصلت لسوريا", "تم التسليم"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-pin",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
};

function json(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, {
    ...init,
    headers: { "Cache-Control": "no-store", ...CORS, ...(init.headers || {}) },
  });
}

function rand4() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

/* ===== D1: إنشاء الجدول تلقائياً + قراءة/كتابة ===== */
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
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

async function writeKey(env: Env, key: string, value: unknown) {
  await env.DB.prepare(
    "INSERT INTO store_items (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  )
    .bind(key, JSON.stringify(value), Date.now())
    .run();
}

function normalizeStore(value: unknown): StoreData {
  const data = value && typeof value === "object" ? (value as Partial<StoreData>) : {};
  return {
    products: Array.isArray(data.products) ? data.products : [],
    coupons: Array.isArray(data.coupons) ? data.coupons : [],
  };
}

/* ===== قفل المحاولات ===== */
type RateMap = Record<string, { fails: number; until: number; t: number }>;

function clientIP(req: Request) {
  return (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
}

async function checkPin(env: Env, req: Request): Promise<"admin" | "user" | "none" | "locked"> {
  const pin = req.headers.get("x-admin-pin") || "";
  if (!pin) return "none";
  const ip = clientIP(req);
  const now = Date.now();
  const rl = ((await readKey(env, RATE_KEY, {})) || {}) as RateMap;
  const rec = rl[ip];
  if (rec && rec.until > now) return "locked";
  const cred = pin.replace(/\s+/g, "").toUpperCase();
  if (cred === ADMIN_CRED || cred === USER_CRED) {
    if (rec) {
      delete rl[ip];
      await writeKey(env, RATE_KEY, rl);
    }
    return cred === ADMIN_CRED ? "admin" : "user";
  }
  let fails = rec ? rec.fails : 0;
  if (rec && rec.until && rec.until <= now) fails = 0;
  fails += 1;
  const until = fails >= MAX_FAILS ? now + LOCK_MS : 0;
  rl[ip] = { fails: until ? 0 : fails, until, t: now };
  const ips = Object.keys(rl).sort((a, b) => rl[a].t - rl[b].t);
  while (ips.length > 200) delete rl[ips.shift() as string];
  await writeKey(env, RATE_KEY, rl);
  return "none";
}

type Analytics = {
  total: number;
  byDay: Record<string, number>;
  byCountry: Record<string, number>;
  orders?: {
    total: number;
    amount: number;
    byMonth: Record<string, number>;
    amountByMonth: Record<string, number>;
    ids: string[];
  };
};
type AbandonedMap = Record<
  string,
  { ts: number; name: string; phone: string; total: number; country: string; items: { name: string; qty: number; color: string }[] }
>;
const emptyAnalytics = (): Analytics => ({ total: 0, byDay: {}, byCountry: {} });

export const onRequest: PagesFunction<Env> = async (context) => {
  const req = context.request;
  const env = context.env;

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!env.DB) return json({ error: "D1_binding_missing" }, { status: 500 });
  await ensureTable(env);

  /* ============ GET ============ */
  if (req.method === "GET") {
    const role = await checkPin(env, req);

    // كاش الحافة للزوار العاديين — توفير هائل بالطلبات
    if (role !== "admin") {
      const cache = caches.default;
      const cacheKey = new Request(new URL(req.url).origin + "/api/store#public", { method: "GET" });
      const hit = await cache.match(cacheKey);
      if (hit) return hit;

      const catalog = normalizeStore(await readKey(env, STORE_KEY, {}));
      const pr = ((await readKey(env, PROD_REV_KEY, {})) || {}) as Record<string, { s: number; c: string; ts: number }[]>;
      const reviews: Record<string, { avg: number; count: number; last: { s: number; c: string; ts: number }[] }> = {};
      Object.keys(pr).forEach((pid) => {
        const list = pr[pid] || [];
        if (!list.length) return;
        const avg = list.reduce((a, r) => a + (r.s || 0), 0) / list.length;
        reviews[pid] = { avg: Math.round(avg * 10) / 10, count: list.length, last: list.slice(-5).reverse() };
      });
      const sold = await readKey(env, SOLD_KEY, {});
      const srAll = ((await readKey(env, SITE_REV_KEY, [])) || []) as { s: number; c: string; ts: number }[];
      const siteRev = srAll.slice(-12).reverse();
      const siteRevAvg = srAll.length ? Math.round((srAll.reduce((a, r) => a + (r.s || 0), 0) / srAll.length) * 10) / 10 : 0;
      const res = json({ ...catalog, reviews, sold, siteRev, siteRevAvg, siteRevCount: srAll.length }, { headers: { "Cache-Control": "public, s-maxage=120" } });
      context.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    // المدير: كل شي بلا كاش
    const catalog = normalizeStore(await readKey(env, STORE_KEY, {}));
    const pr = ((await readKey(env, PROD_REV_KEY, {})) || {}) as Record<string, { s: number; c: string; ts: number }[]>;
    const reviews: Record<string, { avg: number; count: number; last: { s: number; c: string; ts: number }[] }> = {};
    Object.keys(pr).forEach((pid) => {
      const list = pr[pid] || [];
      if (!list.length) return;
      const avg = list.reduce((a, r) => a + (r.s || 0), 0) / list.length;
      reviews[pid] = { avg: Math.round(avg * 10) / 10, count: list.length, last: list.slice(-5).reverse() };
    });
    const analytics = (await readKey(env, ANALYTICS_KEY, emptyAnalytics())) as Analytics;
    const abandoned = (await readKey(env, ABANDONED_KEY, {})) as AbandonedMap;
    const orders = await readKey(env, ORDERS_KEY, {});
    const siteReviews = await readKey(env, SITE_REV_KEY, []);
    const rejectedReviews = await readKey(env, REJECTED_KEY, []);
    const sold = await readKey(env, SOLD_KEY, {});
    const complaints = await readKey(env, COMPLAINTS_KEY, []);
    return json({ ...catalog, reviews, analytics, abandoned, orders, siteReviews, rejectedReviews, sold, complaints });
  }

  /* ============ POST ============ */
  if (req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const type = typeof body.type === "string" ? body.type : "";

    if (type === "visit") {
      const a = ((await readKey(env, ANALYTICS_KEY, emptyAnalytics())) || emptyAnalytics()) as Analytics;
      a.total = (a.total || 0) + 1;
      a.byDay = a.byDay || {};
      const day = new Date().toISOString().slice(0, 10);
      a.byDay[day] = (a.byDay[day] || 0) + 1;
      const days = Object.keys(a.byDay).sort();
      while (days.length > 120) delete a.byDay[days.shift() as string];
      a.byCountry = a.byCountry || {};
      const country = String(body.country || "غير معروف").slice(0, 40) || "غير معروف";
      a.byCountry[country] = (a.byCountry[country] || 0) + 1;
      await writeKey(env, ANALYTICS_KEY, a);
      return json({ ok: true });
    }

    if (type === "presence") {
      const id = String(body.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
      if (!id) return json({ error: "bad_request" }, { status: 400 });
      const now = Date.now();
      const activeAfter = now - 150_000;
      const p = ((await readKey(env, PRESENCE_KEY, {})) || {}) as Record<string, number>;
      Object.keys(p).forEach((k) => {
        if (!Number.isFinite(p[k]) || p[k] < activeAfter) delete p[k];
      });
      p[id] = now;
      await writeKey(env, PRESENCE_KEY, p);
      return json({ ok: true, online: Object.keys(p).length });
    }

    if (type === "abandoned") {
      const id = String(body.id || "").slice(0, 40);
      if (!id) return json({ error: "bad_request" }, { status: 400 });
      const ab = ((await readKey(env, ABANDONED_KEY, {})) || {}) as AbandonedMap;
      const items = Array.isArray(body.items) ? body.items : [];
      ab[id] = {
        ts: Date.now(),
        name: String(body.name || "").slice(0, 80),
        phone: String(body.phone || "").slice(0, 30),
        total: Number(body.total) || 0,
        country: String(body.country || "").slice(0, 40),
        items: items.slice(0, 30).map((it) => {
          const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
          return { name: String(o.name || "").slice(0, 120), qty: Number(o.qty) || 1, color: String(o.color || "").slice(0, 40) };
        }),
      };
      const ids = Object.keys(ab).sort((x, y) => (ab[x].ts || 0) - (ab[y].ts || 0));
      while (ids.length > 60) delete ab[ids.shift() as string];
      await writeKey(env, ABANDONED_KEY, ab);
      return json({ ok: true });
    }

    if (type === "order_done") {
      const id = String(body.id || "");
      const usedCode = String(body.coupon || "").trim().toUpperCase();
      if (usedCode) {
        const otc = ((await readKey(env, OTC_KEY, {})) || {}) as Record<string, { pct: number; used: boolean }>;
        if (otc[usedCode] && !otc[usedCode].used) {
          otc[usedCode].used = true;
          await writeKey(env, OTC_KEY, otc);
        }
      }
      if (id) {
        const orders = ((await readKey(env, ORDERS_KEY, {})) || {}) as Record<string, unknown>;
        if (!orders[id]) {
          const items = Array.isArray(body.items) ? body.items : [];
          orders[id] = {
            ts: Date.now(),
            name: String(body.name || "").slice(0, 80),
            phone: String(body.phone || "").slice(0, 30),
            addr: String(body.addr || "").slice(0, 160),
            pay: String(body.pay || "").slice(0, 60),
            total: Number(body.total) || 0,
            status: STATUSES[0],
            history: [{ status: STATUSES[0], ts: Date.now() }],
            items: items.slice(0, 30).map((it) => {
              const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
              return {
                name: String(o.name || "").slice(0, 120),
                qty: Number(o.qty) || 1,
                color: String(o.color || "").slice(0, 40),
                size: String(o.size || "").slice(0, 20),
              };
            }),
          };
          const ids = Object.keys(orders).sort(
            (x, y) => ((orders[x] as { ts: number }).ts || 0) - ((orders[y] as { ts: number }).ts || 0)
          );
          while (ids.length > 200) delete orders[ids.shift() as string];
          await writeKey(env, ORDERS_KEY, orders);
          // عداد المبيعات المباشر
          const sold = ((await readKey(env, SOLD_KEY, {})) || {}) as Record<string, number>;
          items.slice(0, 30).forEach((it) => {
            const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
            const iid = String(o.id || "").slice(0, 40);
            if (iid) sold[iid] = (sold[iid] || 0) + (Number(o.qty) || 1);
          });
          await writeKey(env, SOLD_KEY, sold);
        }
      }
      const ab = ((await readKey(env, ABANDONED_KEY, {})) || {}) as AbandonedMap;
      if (id && ab[id]) {
        delete ab[id];
        await writeKey(env, ABANDONED_KEY, ab);
      }
      const a = ((await readKey(env, ANALYTICS_KEY, emptyAnalytics())) || emptyAnalytics()) as Analytics;
      a.orders = a.orders || { total: 0, amount: 0, byMonth: {}, amountByMonth: {}, ids: [] };
      a.orders.ids = Array.isArray(a.orders.ids) ? a.orders.ids : [];
      if (id && !a.orders.ids.includes(id)) {
        const month = new Date().toISOString().slice(0, 7);
        const amount = Number(body.total) || 0;
        a.orders.total += 1;
        a.orders.amount += amount;
        a.orders.byMonth[month] = (a.orders.byMonth[month] || 0) + 1;
        a.orders.amountByMonth[month] = (a.orders.amountByMonth[month] || 0) + amount;
        a.orders.ids.push(id);
        while (a.orders.ids.length > 200) a.orders.ids.shift();
        const months = Object.keys(a.orders.byMonth).sort();
        while (months.length > 24) {
          const m = months.shift() as string;
          delete a.orders.byMonth[m];
          delete a.orders.amountByMonth[m];
        }
        await writeKey(env, ANALYTICS_KEY, a);
      }
      return json({ ok: true });
    }

    if (type === "site_review") {
      const stars = Math.min(Math.max(Number(body.stars) || 0, 1), 5);
      const comment = String(body.comment || "").slice(0, 300);
      const dev = String(body.dev || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
      if (stars <= 3 || hasBadWords(comment)) {
        const rej = ((await readKey(env, REJECTED_KEY, [])) || []) as unknown[];
        rej.push({ s: stars, c: comment, ts: Date.now(), src: "site" });
        while (rej.length > 300) rej.shift();
        await writeKey(env, REJECTED_KEY, rej);
        return json({ ok: true, hidden: true });
      }
      const list = ((await readKey(env, SITE_REV_KEY, [])) || []) as { s: number; c: string; ts: number }[];
      list.push({ s: stars, c: comment, ts: Date.now() });
      while (list.length > 300) list.shift();
      await writeKey(env, SITE_REV_KEY, list);
      let code = "";
      if (dev) {
        const devs = ((await readKey(env, REVIEW_DEVS_KEY, {})) || {}) as Record<string, number>;
        if (!devs[dev]) {
          const counter = Number(await readKey(env, DIS_COUNTER_KEY, 1)) || 1;
          if (counter <= 1500) {
            code = "DIS" + counter;
            const otc = ((await readKey(env, OTC_KEY, {})) || {}) as Record<string, { pct: number; used: boolean; ts: number }>;
            otc[code] = { pct: 5, used: false, ts: Date.now() };
            await writeKey(env, OTC_KEY, otc);
            await writeKey(env, DIS_COUNTER_KEY, counter + 1);
            devs[dev] = Date.now();
            const dk = Object.keys(devs);
            while (dk.length > 3000) delete devs[dk.shift() as string];
            await writeKey(env, REVIEW_DEVS_KEY, devs);
          }
        }
      }
      return json({ ok: true, code });
    }

    if (type === "prod_review") {
      const pid = String(body.pid || "").slice(0, 40);
      if (!pid) return json({ error: "bad_request" }, { status: 400 });
      const stars = Math.min(Math.max(Number(body.stars) || 0, 1), 5);
      const comment = String(body.comment || "").slice(0, 200);
      if (stars <= 3 || hasBadWords(comment)) {
        const rej = ((await readKey(env, REJECTED_KEY, [])) || []) as unknown[];
        rej.push({ s: stars, c: comment, ts: Date.now(), src: "prod", pid });
        while (rej.length > 300) rej.shift();
        await writeKey(env, REJECTED_KEY, rej);
        return json({ ok: true, hidden: true });
      }
      const pr = ((await readKey(env, PROD_REV_KEY, {})) || {}) as Record<string, { s: number; c: string; ts: number }[]>;
      pr[pid] = pr[pid] || [];
      pr[pid].push({ s: stars, c: comment, ts: Date.now() });
      while (pr[pid].length > 50) pr[pid].shift();
      const pids = Object.keys(pr);
      while (pids.length > 300) delete pr[pids.shift() as string];
      await writeKey(env, PROD_REV_KEY, pr);
      return json({ ok: true });
    }

    if (type === "check_coupon") {
      const code = String(body.code || "").trim().toUpperCase();
      if (!code) return json({ error: "not_found" }, { status: 404 });
      const catalog = normalizeStore(await readKey(env, STORE_KEY, {}));
      const cp = (catalog.coupons as { code: string; pct: number }[]).find((x) => String(x.code).toUpperCase() === code);
      if (cp) return json({ pct: Number(cp.pct) || 0 });
      const otc = ((await readKey(env, OTC_KEY, {})) || {}) as Record<string, { pct: number; used: boolean }>;
      if (otc[code] && !otc[code].used) return json({ pct: otc[code].pct, otc: true });
      return json({ error: "not_found" }, { status: 404 });
    }

    if (type === "my_points" || type === "redeem_points") {
      const dev = String(body.dev || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
      const ids = (Array.isArray(body.ids) ? body.ids : []).map((x) => String(x)).slice(0, 40);
      if (!dev) return json({ error: "bad_request" }, { status: 400 });
      const orders = ((await readKey(env, ORDERS_KEY, {})) || {}) as Record<string, { status?: string; items?: { qty?: number }[] }>;
      let earned = 0;
      ids.forEach((id) => {
        const o = orders[id];
        if (o && o.status && o.status !== "بانتظار التأكيد") {
          earned += 10 * (o.items || []).reduce((a, it) => a + (Number(it.qty) || 1), 0);
        }
      });
      const ledger = ((await readKey(env, POINTS_KEY, {})) || {}) as Record<string, number>;
      const redeemed = ledger[dev] || 0;
      const balance = Math.max(earned - redeemed, 0);
      if (type === "my_points") return json({ earned, redeemed, balance });
      if (balance < 100) return json({ error: "not_enough", balance }, { status: 400 });
      ledger[dev] = redeemed + 100;
      await writeKey(env, POINTS_KEY, ledger);
      const otc = ((await readKey(env, OTC_KEY, {})) || {}) as Record<string, { pct: number; used: boolean; ts: number }>;
      const code = "MABROK10-" + rand4();
      otc[code] = { pct: 10, used: false, ts: Date.now() };
      const codes = Object.keys(otc).sort((a, b) => (otc[a].ts || 0) - (otc[b].ts || 0));
      while (codes.length > 500) delete otc[codes.shift() as string];
      await writeKey(env, OTC_KEY, otc);
      return json({ ok: true, code, balance: balance - 100 });
    }

    if (type === "spin") {
      const dev = String(body.dev || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
      if (!dev) return json({ error: "bad_request" }, { status: 400 });
      const ip = clientIP(req);
      const now = Date.now();
      const w = ((await readKey(env, WHEEL_KEY, {})) || {}) as Record<string, number>;
      const last = Math.max(w[dev] || 0, w["ip:" + ip] || 0);
      if (now - last < SPIN_COOLDOWN) {
        return json({ error: "cooldown", waitMs: SPIN_COOLDOWN - (now - last) }, { status: 429 });
      }
      w[dev] = now;
      w["ip:" + ip] = now;
      const keys = Object.keys(w);
      while (keys.length > 2000) delete w[keys.shift() as string];
      await writeKey(env, WHEEL_KEY, w);
      const r = Math.random() * 100;
      let prize: number | null = null;
      if (r < 0.1) prize = 50;
      else if (r < 0.12) prize = 20;
      else if (r < 1.02) prize = 10;
      let code = "";
      if (prize) {
        const otc = ((await readKey(env, OTC_KEY, {})) || {}) as Record<string, { pct: number; used: boolean; ts: number }>;
        code = "WHEEL" + prize + "-" + rand4();
        otc[code] = { pct: prize, used: false, ts: Date.now() };
        await writeKey(env, OTC_KEY, otc);
      }
      return json({ prize, code, cooldownMs: SPIN_COOLDOWN });
    }

    if (type === "register") {
      const dev = String(body.dev || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
      const name = String(body.name || "").trim().slice(0, 60);
      const cc = String(body.cc || "").replace(/[^0-9+]/g, "").slice(0, 5);
      const phone = String(body.phone || "").replace(/[^0-9]/g, "");
      if (!dev || !name || name.length < 2 || !cc || phone.length < 7 || phone.length > 12) {
        return json({ error: "bad_data" }, { status: 400 });
      }
      const accounts = ((await readKey(env, ACCOUNTS_KEY, {})) || {}) as Record<string, unknown>;
      accounts[dev] = { name, phone: cc + phone, ts: Date.now() };
      const ks = Object.keys(accounts);
      while (ks.length > 5000) delete accounts[ks.shift() as string];
      await writeKey(env, ACCOUNTS_KEY, accounts);
      return json({ ok: true });
    }

    if (type === "complaint") {
      const text = String(body.text || "").trim().slice(0, 600);
      if (text.length < 5) return json({ error: "bad_data" }, { status: 400 });
      const list = ((await readKey(env, COMPLAINTS_KEY, [])) || []) as unknown[];
      list.push({
        text,
        name: String(body.name || "").slice(0, 60),
        phone: String(body.phone || "").slice(0, 20),
        ts: Date.now(),
        id: Math.random().toString(36).slice(2, 10),
      });
      while (list.length > 300) list.shift();
      await writeKey(env, COMPLAINTS_KEY, list);
      return json({ ok: true });
    }

    if (type === "my_orders") {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map((x) => String(x)).slice(0, 20);
      const orders = ((await readKey(env, ORDERS_KEY, {})) || {}) as Record<string, unknown>;
      const mine: Record<string, unknown> = {};
      ids.forEach((id) => {
        if (orders[id]) mine[id] = orders[id];
      });
      return json({ orders: mine });
    }

    /* أوامر المدير والمستخدمين */
    const role = await checkPin(env, req);
    if (role === "locked") return json({ error: "locked" }, { status: 429 });

    if (type === "import_data") {
      if (role !== "admin") return json({ error: "unauthorized" }, { status: 401 });
      const imported: string[] = [];
      if (body.orders && typeof body.orders === "object") {
        await writeKey(env, ORDERS_KEY, body.orders);
        imported.push("orders");
      }
      if (body.analytics && typeof body.analytics === "object") {
        await writeKey(env, ANALYTICS_KEY, body.analytics);
        imported.push("analytics");
      }
      if (body.abandoned && typeof body.abandoned === "object") {
        await writeKey(env, ABANDONED_KEY, body.abandoned);
        imported.push("abandoned");
      }
      if (Array.isArray(body.siteReviews)) {
        await writeKey(env, SITE_REV_KEY, body.siteReviews);
        imported.push("siteReviews");
      }
      return json({ ok: true, imported });
    }

    if (type === "clear_abandoned") {
      if (role !== "admin") return json({ error: "unauthorized" }, { status: 401 });
      await writeKey(env, ABANDONED_KEY, {});
      return json({ ok: true });
    }

    if (type === "set_status") {
      if (role !== "admin") return json({ error: "unauthorized" }, { status: 401 });
      const id = String(body.id || "");
      const status = String(body.status || "");
      if (!STATUSES.includes(status)) return json({ error: "bad_status" }, { status: 400 });
      const orders = ((await readKey(env, ORDERS_KEY, {})) || {}) as Record<
        string,
        { status: string; history: { status: string; ts: number }[] }
      >;
      if (!orders[id]) return json({ error: "not_found" }, { status: 404 });
      orders[id].status = status;
      orders[id].history = orders[id].history || [];
      orders[id].history.push({ status, ts: Date.now() });
      await writeKey(env, ORDERS_KEY, orders);
      return json({ ok: true });
    }

    if (type === "del_complaint") {
      if (role !== "admin") return json({ error: "unauthorized" }, { status: 401 });
      const id = String(body.id || "");
      const list = ((await readKey(env, COMPLAINTS_KEY, [])) || []) as { id?: string }[];
      const next = list.filter((x) => x.id !== id);
      await writeKey(env, COMPLAINTS_KEY, next);
      return json({ ok: true });
    }

    if (type === "del_order") {
      if (role !== "admin") return json({ error: "unauthorized" }, { status: 401 });
      const id = String(body.id || "");
      const orders = ((await readKey(env, ORDERS_KEY, {})) || {}) as Record<string, unknown>;
      if (orders[id]) {
        delete orders[id];
        await writeKey(env, ORDERS_KEY, orders);
      }
      return json({ ok: true });
    }

    if (role !== "admin" && role !== "user") {
      return json({ error: "unauthorized" }, { status: 401 });
    }
    return json({ ok: true, role });
  }

  /* ============ PUT ============ */
  if (req.method === "PUT") {
    const role = await checkPin(env, req);
    if (role === "locked") return json({ error: "locked" }, { status: 429 });
    if (role !== "admin" && role !== "user") return json({ error: "unauthorized" }, { status: 401 });
    const data = normalizeStore(await req.json().catch(() => ({})));
    if (role === "user") {
      const existing = normalizeStore(await readKey(env, STORE_KEY, {}));
      data.coupons = existing.coupons;
    }
    await writeKey(env, STORE_KEY, data);
    return json(data);
  }

  return json({ error: "method_not_allowed" }, { status: 405 });
};
