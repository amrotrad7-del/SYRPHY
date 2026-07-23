// GET /api/vid?id=<productId>&v=<version> → بيرجع فيديو المنتج كملف حقيقي
// الفيديو مخزّن منفصل عن الكتالوج تحت مفتاح vid_<id> (مجزّأ)، عشان القراءة
// العامة للكتالوج تبقى خفيفة وما تنزّل الفيديوهات مع كل زيارة.
interface Env {
  DB: D1Database;
}

async function readChunked(env: Env, key: string) {
  const head = await env.DB.prepare("SELECT value FROM store_items WHERE key = ?").bind(key).first<{ value: string }>();
  if (!head) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(head.value); } catch { return null; }
  const h = parsed as { __chunked?: number };
  if (!h || typeof h.__chunked !== "number") return parsed; // نسخة غير مجزأة
  const rows = await env.DB.prepare("SELECT key, value FROM store_items WHERE key GLOB ?1").bind(key + "__p*").all<{ key: string; value: string }>();
  const map: Record<number, string> = {};
  (rows.results || []).forEach((r) => {
    const n = Number(String(r.key).split("__p")[1]);
    if (Number.isFinite(n)) map[n] = r.value || "";
  });
  let s = "";
  for (let i = 0; i < h.__chunked; i++) s += map[i] ?? "";
  try { return JSON.parse(s); } catch { return null; }
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get("id") || "";
  if (!id) return new Response("bad request", { status: 400 });

  const range = request.headers.get("Range");
  const cache = caches.default;
  // كاش الحافة: بس للطلب الكامل (بلا Range) — والـ v بالرابط بيكسر الكاش عند تحديث الفيديو
  const cacheKey = new Request(url.origin + url.pathname + url.search, { method: "GET" });
  if (!range) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const rec = (await readChunked(env, "vid_" + id)) as { src?: string } | null;
  const src = rec && rec.src ? rec.src : "";
  if (!src || !src.startsWith("data:")) return new Response("not found", { status: 404 });

  const comma = src.indexOf(",");
  const meta = src.slice(5, comma); // video/mp4;base64
  const b64 = src.slice(comma + 1);
  const type = (meta.split(";")[0] || "video/mp4");
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);

  const common: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=604800, s-maxage=604800",
    "Access-Control-Allow-Origin": "*",
  };

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : len - 1;
    if (isNaN(start)) start = 0;
    if (isNaN(end) || end >= len) end = len - 1;
    if (start > end || start >= len) {
      return new Response("range not satisfiable", { status: 416, headers: { "Content-Range": `bytes */${len}` } });
    }
    const chunk = bytes.subarray(start, end + 1);
    return new Response(chunk, {
      status: 206,
      headers: { ...common, "Content-Range": `bytes ${start}-${end}/${len}`, "Content-Length": String(chunk.length) },
    });
  }

  const res = new Response(bytes, { headers: { ...common, "Content-Length": String(len) } });
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
};
