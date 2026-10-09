// 한 번 열어 본 것은 기기에 저장해 두어서 인터넷 없이도 앱·피아노 소리·분석 엔진이 동작하게 한다.
const CACHE = "score-app-v1";
const CDN = /(^|\.)jsdelivr\.net$|^tonejs\.github\.io$|(^|\.)pythonhosted\.org$|^pypi\.org$/;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (CDN.test(url.hostname)) {
    // 바깥에서 받아 오는 것(피아노 소리, PDF 화면, 엔진): 저장해 둔 것이 있으면 그것부터
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
  } else if (url.origin === location.origin && !url.pathname.startsWith("/dev/")) {
    // 앱 자체: 인터넷이 되면 새것, 안 되면 저장해 둔 것
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
  }
});
