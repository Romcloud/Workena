const CACHE_NAME = "workena-static-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./workena-icon-192.png",
  "./workena-icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames.filter((cacheName) => cacheName !== CACHE_NAME).map((cacheName) => caches.delete(cacheName)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  event.waitUntil((async () => {
    let data;
    try {
      data = event.data.json();
    } catch (error) {
      console.error("Neplatná push notifikácia.", error);
      return;
    }
    await self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/workena-icon-192.png",
      badge: "/workena-icon-192.png",
      data: { url: "/" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: "OPEN_WORK_ORDERS" });
    } else {
      await self.clients.openWindow("/?open=work-orders");
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cachedPage = await caches.match("./index.html");
        if (!cachedPage) throw new Error("Workena sa nenašla v offline úložisku.");
        return cachedPage;
      }),
    );
    return;
  }

  if (!url.pathname.includes("/assets/") && !url.pathname.includes("/workena-icon-") && !url.pathname.endsWith("/manifest.webmanifest")) return;
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then(async (response) => {
        if (!response.ok) return response;
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
        return response;
      });
    }),
  );
});
