interface Env {
  DB: D1Database;
}

async function readCatalog(env: Env) {
  const head = await env.DB.prepare("SELECT value FROM store_items WHERE key = ?").bind("catalog").first<{ value: string }>();
  if (!head) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(head.value); } catch { return null; }
  const h = parsed as { __chunked?: number };
  if (!h || typeof h.__chunked !== "number") return parsed;
  const rows = await env.DB.prepare("SELECT key, value FROM store_items WHERE key GLOB ?1").bind("catalog__p*").all<{ key: string; value: string }>();
  const map: Record<number, string> = {};
  (rows.results || []).forEach((r) => {
    const n = Number(String(r.key).split("__p")[1]);
    if (Number.isFinite(n)) map[n] = r.value || "";
  });
  let s = "";
  for (let i = 0; i < h.__chunked; i++) s += map[i] ?? "";
  try { return JSON.parse(s); } catch { return null; }
}

const esc = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// /p/<id> → صفحة معاينة فيها صورة المنتج (لتطلع بطاقة بالواتساب والفيسبوك)
export const onRequestGet: PagesFunction<Env> = async ({ params, env, request }) => {
  const id = String(params.id || "");
  const origin = new URL(request.url).origin;
  const data = (await readCatalog(env)) as {
    products?: { id: string; name?: string; price?: number; disc?: number; cat?: string }[];
  } | null;
  const p = (data?.products || []).find((x) => x.id === id);

  const title = p ? `${p.name} — SYRPHY 🇸🇾` : "SYRPHY — من الإمارات لباب بيتك";
  const finalPrice = p ? Math.round((Number(p.price) || 0) * (1 - (Number(p.disc) || 0) / 100)) : 0;
  const desc = p
    ? `${finalPrice.toLocaleString("en-US")} ل.س${p.disc ? ` (خصم ${p.disc}%)` : ""} · ${p.cat || ""} · توصيل من الإمارات لباب بيتك 🚚`
    : "تسوق أونلاين من الإمارات لسوريا";
  const img = p ? `${origin}/api/img?id=${encodeURIComponent(id)}&i=0` : `${origin}/og-image.png`;
  const target = `${origin}/?p=${encodeURIComponent(id)}`;

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>${esc(title)}</title>
<meta property="og:type" content="product">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="800">
<meta property="og:image:height" content="800">
<meta property="og:url" content="${esc(target)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(img)}">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
<script>location.replace(${JSON.stringify(target)});</script>
<style>body{font-family:sans-serif;background:#0B7A3E;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}</style>
</head>
<body><div><h2>${esc(p ? p.name || "SYRPHY" : "SYRPHY")}</h2><p>عم نفتحلك المنتج... <a href="${esc(target)}" style="color:#FFD873">اضغط هون</a></p></div></body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
};
