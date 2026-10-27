// Shows Web Push notifications while no Workshop tab is in view. It has no fetch handler, so it
// never takes part in loading pages: caching would come between the app and its WebSocket, sign-in
// redirects and live chat, and the app is not meant to work offline.
//
// Two senders, two payload shapes:
// - the central notification service: {title, body, path, tag};
// - this fork's own VAPID delivery (web-push.ts), as Declarative Web Push:
//   {"web_push": 8030, "notification": {title, body, tag, navigate}, "app_badge"?}. Safari shows
//   those itself, handing the worker a push event that already carries the notification
//   (`event.notification`); other browsers leave showing it to this worker.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// The senders send only URLs within this origin. Anything else, including "/\host" that URL
// parsing reads as "//host", opens the Workshop's home page instead.
const workshopPath = (path) => {
  try {
    let url = new URL(path, self.location.origin);
    if (typeof path === "string" && url.origin === self.location.origin) {
      return url.pathname + url.search + url.hash;
    }
  } catch {}
  return "/";
};

self.addEventListener("push", (event) => {
  if (event.notification) return;
  let payload;
  try {
    payload = event.data?.json();
  } catch {}
  let declarative = payload?.notification;
  // A userVisibleOnly subscription must show a notification for every push.
  let { title, body, path, tag } =
    typeof declarative?.title === "string" ? { ...declarative, path: declarative.navigate }
    : typeof payload?.title === "string" ? payload
    : { title: "Cloudflare OS" };
  event.waitUntil((async () => {
    if (typeof payload?.app_badge === "number" && self.navigator.setAppBadge) {
      await self.navigator.setAppBadge(payload.app_badge).catch(() => {});
    }
    await self.registration.showNotification(
      title, { body, tag, data: { path: workshopPath(path) } });
  })());
});

// Pages that render without the Workshop, so nothing there opens the chat: a connect popup that a
// failed connect left open, and sign-up. The handoff path is kept in step with HANDOFF_PATH in
// src/connectHandoff.ts by serviceWorker.test.ts.
const STANDALONE_PATHS = new Set(["/connect/handoff", "/signup"]);

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let path = workshopPath(event.notification.data?.path);
  event.waitUntil((async () => {
    // Windows come most recently focused first.
    let windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    let client = windows.find(candidate => !STANDALONE_PATHS.has(new URL(candidate.url).pathname));
    if (client) {
      await client.focus();
      // Client.postMessage takes no target origin: it reaches only this origin's window.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      client.postMessage({ type: "cloudflare-os:open-notification", path });
    } else {
      await self.clients.openWindow(path);
    }
  })());
});
