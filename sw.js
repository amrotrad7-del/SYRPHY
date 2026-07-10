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
