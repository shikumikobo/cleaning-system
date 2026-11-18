/* global self */
// 通知の受け取り（機能 015）。public/sw.js から importScripts で読まれる。
// 表示するのは、題名・本文・リンクだけ。リンクは、アプリの中の道（/ で始まる）だけ受ける（R-015-28）。
const NOTIFICATIONS_PATH = "/notifications/";

function safeLink(link) {
  return typeof link === "string" && /^\/(?![/\\])/.test(link) ? link : NOTIFICATIONS_PATH;
}

self.addEventListener("push", (event) => {
  let data;
  try {
    data = (event.data && event.data.json()) || {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "お知らせ";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { link: safeLink(data.link) },
  };
  if (typeof data.id === "string") options.tag = data.id;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safeLink(event.notification.data && event.notification.data.link);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          return client.focus().then((w) => (w && "navigate" in w ? w.navigate(url) : w));
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
