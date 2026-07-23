// GET /api/fetchprod?url=<رابط منتج> → بيسحب الاسم والسعر والصور من صفحة المنتج
// بينفّذ من جهة السيرفر لأن المتصفح بيمنع القراءة من مواقع تانية (CORS).
// مسموح بس لمواقع محددة (allowlist) — حماية من إساءة الاستعمال.
interface Env {
  DB: D1Database;
}

const ALLOWED = ["shein.com", "sheinm.com", "trendyol.com", "temu.com", "aliexpress.com", "noon.com", "namshi.com"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_IMG = 6;
const MAX_IMG_BYTES = 3 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-pin",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...CORS } });
}

function hostAllowed(u: URL) {
  const h = u.hostname.toLowerCase().replace(/^www\./, "");
  return ALLOWED.some((d) => h === d || h.endsWith("." + d));
}

function decodeEntities(s: string) {
  return String(s || "")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
}

function metaContent(html: string, prop: string) {
  const pats = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, "i"),
  ];
  for (const re of pats) {
    const m = re.exec(html);
    if (m) return decodeEntities(m[1]);
  }
  return "";
}

// بيدوّر على أول سعر منطقي بالصفحة (JSON-LD أو ميتا أو JSON داخلي)
function findPrice(html: string): { price: number; currency: string } {
  const cur = metaContent(html, "product:price:currency") || metaContent(html, "og:price:currency") || "";
  const metaP = metaContent(html, "product:price:amount") || metaContent(html, "og:price:amount");
  if (metaP && isFinite(Number(metaP))) return { price: Number(metaP), currency: cur };
  const pats: RegExp[] = [
    /"price"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?/i,
    /"salePrice"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?/i,
    /"amount"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?/i,
    /"sellingPrice"\s*:\s*\{[^}]*"value"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
  ];
  for (const re of pats) {
    const m = re.exec(html);
    if (m && isFinite(Number(m[1])) && Number(m[1]) > 0) return { price: Number(m[1]), currency: cur };
  }
  const curPat = /"currency(?:Code)?"\s*:\s*"([A-Z]{3})"/i.exec(html);
  return { price: 0, currency: cur || (curPat ? curPat[1] : "") };
}

function findImages(html: string, base: URL): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    let s = decodeEntities(String(raw || "")).trim();
    if (!s) return;
    if (s.startsWith("//")) s = base.protocol + s;
    if (!/^https?:\/\//i.test(s)) return;
    if (!/\.(jpe?g|png|webp|avif)(\?|$)/i.test(s)) return;
    if (/sprite|logo|icon|placeholder|blank/i.test(s)) return;
    if (!out.includes(s)) out.push(s);
  };
  const og = metaContent(html, "og:image");
  if (og) push(og);
  // صور من JSON داخل الصفحة
  const reArr = /"(?:images?|imageList|goods_images?|mediaList|hd_thumb|origin_image|thumb)"\s*:\s*\[([^\]]{0,6000})\]/gi;
  let m: RegExpExecArray | null;
  while ((m = reArr.exec(html)) && out.length < MAX_IMG * 4) {
    const urls = m[1].match(/https?:(?:\\\/\\\/|\/\/)[^"',\s]+/g) || [];
    urls.forEach((u) => push(u.replace(/\\\//g, "/")));
  }
  const reStr = /"(?:image|imgUrl|img_url|goods_img|origin_image|hd_thumb)"\s*:\s*"([^"]{10,400})"/gi;
  while ((m = reStr.exec(html)) && out.length < MAX_IMG * 4) push(m[1].replace(/\\\//g, "/"));
  return out.slice(0, MAX_IMG);
}

async function toDataURL(u: string, ref: string): Promise<string> {
  try {
    const r = await fetch(u, { headers: { "User-Agent": UA, Referer: ref, Accept: "image/*,*/*" } });
    if (!r.ok) return "";
    const type = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
    if (!type.startsWith("image/")) return "";
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_IMG_BYTES || buf.byteLength < 500) return "";
    const bytes = new Uint8Array(buf);
    let bin = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
    return "data:" + type + ";base64," + btoa(bin);
  } catch (_) {
    return "";
  }
}

export const onRequestOptions: PagesFunction<Env> = async () => new Response(null, { status: 204, headers: CORS });

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request } = context;
  const url = new URL(request.url);
  const target = (url.searchParams.get("url") || "").trim();
  if (!target) return json({ error: "bad_request" }, 400);

  let t: URL;
  try { t = new URL(/^https?:\/\//i.test(target) ? target : "https://" + target); } catch { return json({ error: "bad_url" }, 400); }
  if (!hostAllowed(t)) return json({ error: "host_not_allowed", host: t.hostname }, 400);

  let html = "";
  try {
    const r = await fetch(t.toString(), {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ar,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!r.ok) return json({ error: "blocked", status: r.status }, 200);
    html = await r.text();
  } catch (e) {
    return json({ error: "fetch_failed", detail: String((e as Error)?.message || e) }, 200);
  }

  const name = metaContent(html, "og:title") || metaContent(html, "twitter:title") || (/<title[^>]*>([^<]{3,300})<\/title>/i.exec(html)?.[1] || "").trim();
  const { price, currency } = findPrice(html);
  const imgUrls = findImages(html, t);

  const images: string[] = [];
  for (const u of imgUrls) {
    if (images.length >= MAX_IMG) break;
    const d = await toDataURL(u, t.toString());
    if (d) images.push(d);
  }

  return json({
    ok: true,
    name: decodeEntities(name).replace(/\s+/g, " ").trim().slice(0, 200),
    price,
    currency,
    images,
    found: { name: !!name, price: price > 0, images: images.length },
  });
};
