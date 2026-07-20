// SYRPHY sw v2 — تنظيف تلقائي: بيمسح أي كاش قديم مخبى عند أي تحديث
const CLEANUP_V = "sw-v3-2026-07-25";
self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // امسح كل الكاشات القديمة اللي كانت تخبي نسخ الموقع
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
    // بلغ كل التبويبات المفتوحة تعيد تحميل نفسها بلا كاش
    const list = await self.clients.matchAll({ type: "window" });
    list.forEach((c) => c.postMessage({ type: "sw-cleaned", v: CLEANUP_V }));
  })());
});
// ما منعترض أي طلب — كل الطلبات بتروح عالشبكة مباشرة (بلا خدمة صفحات قديمة)

self.addEventListener("push", (e) => {
  let d = { title: "SYRPHY 🇸🇾", body: "في جديد بالمتجر!", url: "/" };
  try { d = { ...d, ...e.data.json() }; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, icon: "/icon-192.png", badge: "/icon-192.png", dir: "rtl", lang: "ar", data: { url: d.url },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data?.url || "/"));
});
