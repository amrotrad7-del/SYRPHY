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
const ADMIN_ACC = "AMRO:971566135365"; // حساب أمرو — دخوله بالموقع بيفتح الصلاحيات
const WINNER_COUNTER_KEY = "winner_counter";
const WELCOME_COUNTER_KEY = "welcome_counter";
const THANKS_COUNTER_KEY = "thanks_counter";
const REFERRALS_KEY = "referrals";
const VISITORS_KEY = "visitors_live";
const SETTINGS_KEY = "site_settings";
const BDAY_COUNTER_KEY = "bday_counter";
const BDAY_CLAIMS_KEY = "bday_claims";
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const SPIN_COOLDOWN = 15 * 60 * 60 * 1000;
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

/* ===== تخزين مجزأ للكتالوج =====
   D1 عندها سقف لحجم الصف الواحد، وصور المنتجات (base64) بتتخطاه بسرعة.
   فمنقسّم نص الكتالوج لقطع 600 ألف حرف، كل قطعة بصف مستقل. */
const CHUNK = 600_000;

async function writeBig(env: Env, key: string, value: unknown) {
  const s = JSON.stringify(value);
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += CHUNK) parts.push(s.slice(i, i + CHUNK));
  if (!parts.length) parts.push("");
  const stmts = [
    env.DB.prepare(
      "INSERT INTO store_items (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).bind(key, JSON.stringify({ __chunked: parts.length }), Date.now()),
    ...parts.map((p, i) =>
      env.DB.prepare(
        "INSERT INTO store_items (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(key + "__p" + i, p, Date.now())
    ),
  ];
  await env.DB.batch(stmts);
  // تنظيف قطع قديمة زائدة (بأمان: بس اللي رقمها >= عدد القطع الجديد)
  try {
    const old = await env.DB.prepare("SELECT key FROM store_items WHERE key GLOB ?1").bind(key + "__p*").all<{ key: string }>();
    const stale = (old.results || [])
      .map((r) => r.key)
      .filter((k) => {
        const n = Number(k.split("__p")[1]);
        return Number.isFinite(n) && n >= parts.length;
      });
    if (stale.length) {
      await env.DB.batch(stale.map((k) => env.DB.prepare("DELETE FROM store_items WHERE key = ?").bind(k)));
    }
  } catch (_) { /* ما بيوقف الحفظ */ }
}

async function readBig(env: Env, key: string, fallback: unknown) {
  const head = await readKey(env, key, null);
  if (!head) return fallback;
  const h = head as { __chunked?: number };
  if (!h || typeof h.__chunked !== "number") return head; // نسخة قديمة غير مجزأة
  const rows = await env.DB.prepare("SELECT key, value FROM store_items WHERE key GLOB ?1")
    .bind(key + "__p*")
    .all<{ key: string; value: string }>();
  const map: Record<number, string> = {};
  (rows.results || []).forEach((r) => {
    const n = Number(String(r.key).split("__p")[1]);
    if (Number.isFinite(n)) map[n] = r.value || "";
  });
  let s = "";
  for (let i = 0; i < h.__chunked; i++) s += map[i] ?? "";
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
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
  if (cred === ADMIN_CRED || cred === USER_CRED || cred === ADMIN_ACC) {
    if (rec) {
      delete rl[ip];
      await writeKey(env, RATE_KEY, rl);
    }
    return cred === USER_CRED ? "user" : "admin";
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

      const catalog = normalizeStore(await readBig(env, STORE_KEY, {}));
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
      const settings = await readKey(env, SETTINGS_KEY, { team: true });
      const res = json({ sv: 17, settings, ...catalog, reviews, sold, siteRev, siteRevAvg, siteRevCount: srAll.length }, { headers: { "Cache-Control": "public, s-maxage=120" } });
      context.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    // المدير: كل شي بلا كاش
    const catalog = normalizeStore(await readBig(env, STORE_KEY, {}));
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
    const accounts = await readKey(env, ACCOUNTS_KEY, {});
    const visitors = await readKey(env, VISITORS_KEY, {});
    const settings = await readKey(env, SETTINGS_KEY, { team: true });
    const otcAll = await readKey(env, OTC_KEY, {});
    const points = await readKey(env, POINTS_KEY, {});
    const referrals = await readKey(env, REFERRALS_KEY, {});
    return json({ sv: 17, settings, otcAll, points, referrals, ...catalog, reviews, analytics, abandoned, orders, siteReviews, rejectedReviews, sold, complaints, accounts, visitors });
  }

  /* ============ POST ============ */
  if (req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const type = typeof body.type === "string" ? body.type : "";

    if (type === "visit") {
      // سجل الزوار: زائر واحد بعدد زياراته (بلا تكرار)
      try {
        const vmap = ((await readKey(env, VISITORS_KEY, {})) || {}) as Record<string, { visits: number; first: number; last: number; country?: string; city?: string; name?: string; phone?: string }>;
        const phone = String(body.phone || "").slice(0, 20);
        const vkey = (phone || "ip:" + clientIP(req)).slice(0, 40);
        const prev = vmap[vkey];
        vmap[vkey] = {
          visits: (prev?.visits || 0) + 1,
          first: prev?.first || Date.now(),
          last: Date.now(),
          country: String(body.country || "").slice(0, 40) || prev?.country,
          city: String(body.city || "").slice(0, 60) || prev?.city,
          name: String(body.name || "").slice(0, 60) || prev?.name,
          phone: phone || prev?.phone,
        };
        const vk = Object.keys(vmap);
        if (vk.length > 500) {
          vk.sort((a, b) => (vmap[a].last || 0) - (vmap[b].last || 0));
          while (vk.length > 500) delete vmap[vk.shift() as string];
        }
        await writeKey(env, VISITORS_KEY, vmap);
      } catch (_) {}
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
            acc: String(body.acc || "").replace(/[^0-9]/g, "").slice(0, 20),
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
        return json({ ok: true });
    }

    if (type === "site_review") {
      const stars = Math.min(Math.max(Number(body.stars) || 0, 1), 5);
      const comment = String(body.comment || "").slice(0, 300);
      const dev = String(body.dev || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
      const accR = String(body.acc || "").replace(/[^0-9]/g, "");
      const rewardKey = accR || dev;
      if (stars <= 3 || hasBadWords(comment)) {
        const rej = ((await readKey(env, REJECTED_KEY, [])) || []) as unknown[];
        rej.push({ s: stars, c: comment, ts: Date.now(), src: "site" });
        while (rej.length > 300) rej.shift();
        await writeKey(env, REJECTED_KEY, rej);
        return json({ ok: true, hidden: true });
      }
      const rname = String(body.name || "").trim().slice(0, 40);
      let list = ((await readKey(env, SITE_REV_KEY, [])) || []) as { s: number; c: string; ts: number; n?: string }[];
      // إزالة المكرر: نفس النص + نفس الاسم
      const seenRev = new Set<string>();
      list = list.filter((r) => {
        const k = (r.n || "") + "|" + (r.c || "");
        if (seenRev.has(k)) return false;
        seenRev.add(k);
        return true;
      });
      const dupKey = rname + "|" + comment;
      if (!seenRev.has(dupKey)) list.push({ s: stars, c: comment, ts: Date.now(), n: rname });
      while (list.length > 300) list.shift();
      await writeKey(env, SITE_REV_KEY, list);
      let code = "";
      if (rewardKey) {
        const devs = ((await readKey(env, REVIEW_DEVS_KEY, {})) || {}) as Record<string, number>;
        if (!devs[rewardKey]) {
          const counter = Number(await readKey(env, DIS_COUNTER_KEY, 1)) || 1;
          if (counter <= 1500) {
            code = "DIS" + counter;
            const otc = ((await readKey(env, OTC_KEY, {})) || {}) as Record<string, { pct: number; used: boolean; ts: number }>;
            otc[code] = { pct: 5, used: false, ts: Date.now() };
            await writeKey(env, OTC_KEY, otc);
            await writeKey(env, DIS_COUNTER_KEY, counter + 1);
            devs[rewardKey] = Date.now();
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
      const catalog = normalizeStore(await readBig(env, STORE_KEY, {}));
      const cp = (catalog.coupons as { code: string; pct: number }[]).find((x) => String(x.code).toUpperCase() === code);
      if (cp) return json({ pct: Number(cp.pct) || 0 });
      const otc = ((await readKey(env, OTC_KEY, {})) || {}) as Record<string, { pct: number; used: boolean }>;
      const oc = otc[code] as { pct: number; used: boolean; nodisc?: boolean; exp?: number } | undefined;
      if (oc && !oc.used) {
        if (oc.exp && Date.now() > oc.exp) return json({ error: "expired" }, { status: 410 });
        return json({ pct: oc.pct, otc: true, nodisc: !!oc.nodisc });
      }
      return json({ error: "not_found" }, { status: 404 });
    }

    if (type === "my_points" || type === "redeem_points") {
      const dev = String(body.dev || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
      const acc = String(body.acc || "").replace(/[^0-9]/g, "");
      const idk = acc || dev; // هوية الحساب أولاً
      const ids = (Array.isArray(body.ids) ? body.ids : []).map((x) => String(x)).slice(0, 40);
      if (!idk) return json({ error: "bad_request" }, { status: 400 });
      const orders = ((await readKey(env, ORDERS_KEY, {})) || {}) as Record<string, { status?: string; acc?: string; items?: { qty?: number }[] }>;
      let earned = 0;
      const seen = new Set<string>();
      const countO = (id: string) => {
        const o = orders[id];
        if (o && !seen.has(id) && o.status && o.status !== "بانتظار التأكيد") {
          seen.add(id);
          earned += 10 * (o.items || []).reduce((a, it) => a + (Number(it.qty) || 1), 0);
        }
      };
      ids.forEach(countO);
      if (acc) Object.keys(orders).forEach((id) => { if (orders[id].acc === acc) countO(id); });
      const ledger = ((await readKey(env, POINTS_KEY, {})) || {}) as Record<string, number>;
      const redeemed = ledger[idk] || 0;
      const balance = Math.max(earned - redeemed, 0);
      if (type === "my_points") return json({ earned, redeemed, balance });
      if (balance < 100) return json({ error: "not_enough", balance }, { status: 400 });
      ledger[idk] = redeemed + 100;
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
      const acc = String(body.acc || "").replace(/[^0-9]/g, "");
      const idk = acc || dev;
      if (!idk) return json({ error: "bad_request" }, { status: 400 });
      // قفل الـ 15 ساعة: بالحساب + الجهاز + عنوان الشبكة
      const ip = clientIP(req);
      const now = Date.now();
      const w = ((await readKey(env, WHEEL_KEY, {})) || {}) as Record<string, number>;
      const last = Math.max(w[idk] || 0, w[dev] || 0, w["ip:" + ip] || 0);
      if (now - last < SPIN_COOLDOWN) {
        return json({ error: "cooldown", waitMs: SPIN_COOLDOWN - (now - last) }, { status: 429 });
      }
      w[idk] = now;
      if (dev) w[dev] = now;
      w["ip:" + ip] = now;
      const keys = Object.keys(w).sort((a, b) => w[a] - w[b]);
      while (keys.length > 3000) delete w[keys.shift() as string];
      await writeKey(env, WHEEL_KEY, w);

      const issueCode = async (counterKey: string, prefix: string, pct: number) => {
        const counter = Number(await readKey(env, counterKey, 1)) || 1;
        if (counter > 1500) return "";
        const codeStr = prefix + counter;
        const otc = ((await readKey(env, OTC_KEY, {})) || {}) as Record<string, { pct: number; used: boolean; ts: number }>;
        otc[codeStr] = { pct, used: false, ts: Date.now() };
        await writeKey(env, OTC_KEY, otc);
        await writeKey(env, counterKey, counter + 1);
        return codeStr;
      };

      // الدولاب: 50%→0.1 · 20%→0.02 · 10%→20 · الباقي حظ أوفر
      const r = Math.random() * 100;
      let prize: number | null = null;
      if (r < 0.1) prize = 50;
      else if (r < 0.12) prize = 20;
      else if (r < 20.12) prize = 10;
      let code = "";
      if (prize) code = await issueCode(WINNER_COUNTER_KEY, "WINNER", prize);
      if (!code) prize = null;
      return json({ prize, code, cooldownMs: cooldown });
    }

    if (type === "register") {
      const dev = String(body.dev || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
      const name = String(body.name || "").trim().slice(0, 60);
      const cc = String(body.cc || "").replace(/[^0-9+]/g, "").slice(0, 5);
      const phone = String(body.phone || "").replace(/[^0-9]/g, "");
      if (!dev || !name || name.length < 2 || !cc || phone.length < 7 || phone.length > 12) {
        return json({ error: "bad_data" }, { status: 400 });
      }
      const accounts = ((await readKey(env, ACCOUNTS_KEY, {})) || {}) as Record<string, { name: string; ts: number }>;
      const akey = cc + phone;
      if (accounts[akey]) return json({ error: "exists" }, { status: 409 });
      const email = String(body.email || "").trim().slice(0, 80);
      const bday = String(body.bday || "").slice(0, 10); // YYYY-MM-DD
      accounts[akey] = { name, ts: Date.now(), email, bday };
      const ks = Object.keys(accounts);
      while (ks.length > 5000) delete accounts[ks.shift() as string];
      await writeKey(env, ACCOUNTS_KEY, accounts);
      const adminAcc = ("AMRO:" + akey) === ADMIN_ACC;
      // 🎁 كود ترحيب 10% (للمنتجات بلا خصم فقط) — مرة وحدة لكل رقم
      let welcomeCode = "";
      const wc = Number(await readKey(env, WELCOME_COUNTER_KEY, 1)) || 1;
      if (wc <= 2000) {
        welcomeCode = "WELCOME" + wc;
        const otc = ((await readKey(env, OTC_KEY, {})) || {}) as Record<string, { pct: number; used: boolean; ts: number; nodisc?: boolean }>;
        otc[welcomeCode] = { pct: 10, used: false, ts: Date.now(), nodisc: true };
        await writeKey(env, OTC_KEY, otc);
        await writeKey(env, WELCOME_COUNTER_KEY, wc + 1);
      }
      // تسجيل الإحالة إذا جا عن طريق معرّف صديق
      const refBy = String(body.ref || "").replace(/[^0-9]/g, "").slice(0, 20);
      if (refBy && refBy !== akey) {
        const refs = ((await readKey(env, REFERRALS_KEY, {})) || {}) as Record<string, string[]>;
        refs[refBy] = refs[refBy] || [];
        if (!refs[refBy].includes(akey)) refs[refBy].push(akey);
        await writeKey(env, REFERRALS_KEY, refs);
        // وصل 10 محالين؟ كود THANKS 20%
        if (refs[refBy].length === 10) {
          const tc = Number(await readKey(env, THANKS_COUNTER_KEY, 1)) || 1;
          if (tc <= 2000) {
            const tCode = "THANKS" + tc;
            const otc2 = ((await readKey(env, OTC_KEY, {})) || {}) as Record<string, { pct: number; used: boolean; ts: number; nodisc?: boolean }>;
            otc2[tCode] = { pct: 20, used: false, ts: Date.now(), nodisc: true };
            await writeKey(env, OTC_KEY, otc2);
            await writeKey(env, THANKS_COUNTER_KEY, tc + 1);
            const accs = ((await readKey(env, ACCOUNTS_KEY, {})) || {}) as Record<string, { thanks?: string[] }>;
            if (accs[refBy]) { accs[refBy].thanks = accs[refBy].thanks || []; accs[refBy].thanks!.push(tCode); await writeKey(env, ACCOUNTS_KEY, accs); }
          }
        }
      }
      return json({ ok: true, admin: adminAcc && name.trim().toUpperCase() === "AMRO", welcome: welcomeCode });
    }

    if (type === "login") {
      const name = String(body.name || "").trim();
      const cc = String(body.cc || "").replace(/[^0-9+]/g, "").slice(0, 5);
      const phone = String(body.phone || "").replace(/[^0-9]/g, "");
      const akey = cc + phone;
      const accounts = ((await readKey(env, ACCOUNTS_KEY, {})) || {}) as Record<string, { name: string }>;
      const acc = accounts[akey];
      const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
      if (!acc || norm(acc.name) !== norm(name)) return json({ error: "not_found" }, { status: 404 });
      const adminAcc = name.trim().toUpperCase() === "AMRO" && akey === "971566135365";
      return json({ ok: true, name: acc.name, admin: adminAcc });
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

    if (type === "birthday_check") {
      const acc = String(body.acc || "").replace(/[^0-9]/g, "");
      if (!acc) return json({ error: "bad_request" }, { status: 400 });
      const accounts = ((await readKey(env, ACCOUNTS_KEY, {})) || {}) as Record<string, { name?: string; bday?: string }>;
      const a = accounts[acc];
      if (!a || !a.bday) return json({ ok: false });
      const today = new Date();
      const b = new Date(a.bday + "T00:00:00");
      if (b.getMonth() !== today.getMonth() || b.getDate() !== today.getDate()) return json({ ok: false });
      const year = String(today.getFullYear());
      const claims = ((await readKey(env, BDAY_CLAIMS_KEY, {})) || {}) as Record<string, string>;
      if (claims[acc] === year) return json({ ok: false, already: true });
      const n = Number(await readKey(env, BDAY_COUNTER_KEY, 1)) || 1;
      if (n > 1500) return json({ ok: false });
      const code = "HAPPYBIRTHDAY" + n;
      const otc = ((await readKey(env, OTC_KEY, {})) || {}) as Record<string, { pct: number; used: boolean; ts: number; nodisc?: boolean; exp?: number }>;
      otc[code] = { pct: 50, used: false, ts: Date.now(), nodisc: true, exp: Date.now() + 48 * 3600 * 1000 };
      await writeKey(env, OTC_KEY, otc);
      await writeKey(env, BDAY_COUNTER_KEY, n + 1);
      claims[acc] = year;
      await writeKey(env, BDAY_CLAIMS_KEY, claims);
      return json({ ok: true, code, name: a.name || "", hours: 48 });
    }

    if (type === "my_referrals") {
      const acc = String(body.acc || "").replace(/[^0-9]/g, "");
      if (!acc) return json({ error: "bad_request" }, { status: 400 });
      const refs = ((await readKey(env, REFERRALS_KEY, {})) || {}) as Record<string, string[]>;
      const accs = ((await readKey(env, ACCOUNTS_KEY, {})) || {}) as Record<string, { thanks?: string[] }>;
      return json({ count: (refs[acc] || []).length, thanks: (accs[acc] || {}).thanks || [] });
    }

    if (type === "my_orders") {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map((x) => String(x)).slice(0, 20);
      const acc = String(body.acc || "").replace(/[^0-9]/g, "");
      const orders = ((await readKey(env, ORDERS_KEY, {})) || {}) as Record<string, { acc?: string }>;
      const mine: Record<string, unknown> = {};
      ids.forEach((id) => {
        if (orders[id]) mine[id] = orders[id];
      });
      if (acc) Object.keys(orders).forEach((id) => { if (orders[id].acc === acc) mine[id] = orders[id]; });
      return json({ orders: mine });
    }

    /* أوامر المدير والمستخدمين */
    const role = await checkPin(env, req);
    if (role === "locked") return json({ error: "locked" }, { status: 429 });

    if (type === "import_data") {
      if (role !== "admin") return json({ error: "unauthorized" }, { status: 401 });
      // 🛡️ الاستيراد ممنوع يمسح أي شي — بيدمج بس
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
      const rec = orders[id] as unknown as { counted?: boolean; total?: number };
      if (status === "تم التأكيد" && !rec.counted) {
        rec.counted = true;
        const a = ((await readKey(env, ANALYTICS_KEY, emptyAnalytics())) || emptyAnalytics()) as Analytics;
        a.orders = a.orders || { total: 0, amount: 0, byMonth: {}, amountByMonth: {}, ids: [] };
        const month = new Date().toISOString().slice(0, 7);
        const amount = Number(rec.total) || 0;
        a.orders.total += 1;
        a.orders.amount += amount;
        a.orders.byMonth[month] = (a.orders.byMonth[month] || 0) + 1;
        a.orders.amountByMonth[month] = (a.orders.amountByMonth[month] || 0) + amount;
        await writeKey(env, ANALYTICS_KEY, a);
      }
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

    if (type === "list_backups") {
      if (role !== "admin") return json({ error: "unauthorized" }, { status: 401 });
      const cur = normalizeStore(await readBig(env, STORE_KEY, {}));
      const list: { key: string; label: string; count: number; ts: number }[] = [];
      const marker = ((await readKey(env, "catalog_day_marker", {})) || {}) as Record<string, string>;
      const names = ["الأحد", "الاتنين", "التلات", "الأربعا", "الخميس", "الجمعة", "السبت"];
      for (const k of ["catalog_bk1", "catalog_bk2"]) {
        const b = normalizeStore(await readBig(env, k, {}));
        if (b.products.length) list.push({ key: k, label: k === "catalog_bk1" ? "آخر نسخة (قبل آخر حفظ)" : "النسخة اللي قبلها", count: b.products.length, ts: 0 });
      }
      for (let d = 0; d < 7; d++) {
        const b = normalizeStore(await readBig(env, "catalog_day" + d, {}));
        if (b.products.length) list.push({ key: "catalog_day" + d, label: "نسخة يوم " + names[d] + (marker[String(d)] ? " (" + marker[String(d)] + ")" : ""), count: b.products.length, ts: 0 });
      }
      return json({ current: cur.products.length, list });
    }

    if (type === "restore_backup") {
      if (role !== "admin") return json({ error: "unauthorized" }, { status: 401 });
      const raw = String(body.which || "catalog_bk1");
      const which = /^catalog_(bk1|bk2|day[0-6])$/.test(raw) ? raw : "catalog_bk1";
      const bk = normalizeStore(await readBig(env, which, {}));
      if (!bk.products.length) return json({ error: "empty_backup" }, { status: 404 });
      await writeBig(env, STORE_KEY, bk);
      return json({ ok: true, restored: bk.products.length });
    }

    if (type === "set_setting") {
      if (role !== "admin") return json({ error: "unauthorized" }, { status: 401 });
      const s = ((await readKey(env, SETTINGS_KEY, { team: true })) || {}) as Record<string, unknown>;
      const key = String(body.key || "");
      if (!["team"].includes(key)) return json({ error: "bad_key" }, { status: 400 });
      s[key] = !!body.value;
      await writeKey(env, SETTINGS_KEY, s);
      return json({ ok: true, settings: s });
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
      const existing = normalizeStore(await readBig(env, STORE_KEY, {}));
      data.coupons = existing.coupons;
    }
    const existing = normalizeStore(await readBig(env, STORE_KEY, {}));
    const body2 = (data as unknown) as { force?: boolean };

    // 🛡️ حماية: ممنوع الكتابة الفاضية أو حذف أكتر من نص المنتجات دفعة وحدة
    if (existing.products.length > 0) {
      if (data.products.length === 0) {
        return json({ error: "refuse_empty", have: existing.products.length }, { status: 409 });
      }
      if (data.products.length < existing.products.length / 2 && !body2.force) {
        return json(
          { error: "refuse_big_delete", have: existing.products.length, incoming: data.products.length },
          { status: 409 }
        );
      }
    }

    // 🗄️ نسخ احتياطية: قبل كل حفظ + نسخة يومية دوّارة (7 أيام)
    try {
      if (existing.products.length) {
        const b1 = await readBig(env, "catalog_bk1", null);
        if (b1) await writeBig(env, "catalog_bk2", b1);
        await writeBig(env, "catalog_bk1", existing);
        // نسخة اليوم (بتنكتب مرة وحدة باليوم — فبتضل أقدم نسخة سليمة لليوم)
        const day = new Date().getDay(); // 0-6
        const dayKey = "catalog_day" + day;
        const marker = ((await readKey(env, "catalog_day_marker", {})) || {}) as Record<string, string>;
        const today = new Date().toISOString().slice(0, 10);
        if (marker[String(day)] !== today) {
          await writeBig(env, dayKey, existing);
          marker[String(day)] = today;
          await writeKey(env, "catalog_day_marker", marker);
        }
      }
    } catch (_) { /* النسخة الاحتياطية ما بتوقف الحفظ */ }

    try {
      await writeBig(env, STORE_KEY, data);
    } catch (e) {
      return json({ error: "save_failed", detail: String((e as Error)?.message || e) }, { status: 500 });
    }
    return json(data);
  }

  return json({ error: "method_not_allowed" }, { status: 405 });
};
