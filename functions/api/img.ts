interface Env {
  DB: D1Database;
}

const CHUNK_KEY = "catalog";

async function readCatalog(env: Env) {
  const head = await env.DB.prepare("SELECT value FROM store_items WHERE key = ?").bind(CHUNK_KEY).first<{ value: string }>();
  if (!head) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(head.value); } catch { return null; }
  const h = parsed as { __chunked?: number };
  if (!h || typeof h.__chunked !== "number") return parsed;
  const rows = await env.DB.prepare("SELECT key, value FROM store_items WHERE key GLOB ?1").bind(CHUNK_KEY + "__p*").all<{ key: string; value: string }>();
  const map: Record<number, string> = {};
  (rows.results || []).forEach((r) => {
    const n = Number(String(r.key).split("__p")[1]);
    if (Number.isFinite(n)) map[n] = r.value || "";
  });
  let s = "";
  for (let i = 0; i < h.__chunked; i++) s += map[i] ?? "";
  try { return JSON.parse(s); } catch { return null; }
}

// GET /api/img?id=<productId>&i=<index> → بيرجع صورة المنتج كملف صورة حقيقي
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  // كاش الحافة: الصورة بتتبنى مرة وبتنخدم فوراً بعدها
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await buildImage(request, env);
  if (res.status === 200) context.waitUntil(cache.put(request, res.clone()));
  return res;
};

async function buildImage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") || "";
  const idx = Math.max(0, Math.min(20, Number(url.searchParams.get("i") || 0)));
  const data = (await readCatalog(env)) as { products?: { id: string; imgs?: { src?: string }[]; img?: string }[] } | null;
  const p = (data?.products || []).find((x) => x.id === id);
  let src = p ? (p.imgs && p.imgs[idx] ? p.imgs[idx].src : p.img) : "";
  if (p && (!src || !src.startsWith("data:"))) {
    const anyReal = (p.imgs || []).find((im) => (im.src || "").startsWith("data:"));
    src = anyReal ? anyReal.src : (p.img && p.img.startsWith("data:") ? p.img : "");
  }
  if (!src || !src.startsWith("data:")) return new Response("not found", { status: 404 });

  const comma = src.indexOf(",");
  const meta = src.slice(5, comma); // image/jpeg;base64
  const b64 = src.slice(comma + 1);
  const type = meta.split(";")[0] || "image/jpeg";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  return new Response(bytes, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=604800, s-maxage=604800",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
