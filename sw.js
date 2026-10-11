// 한 번 열어 본 것은 기기에 저장해 두어서 인터넷 없이도 앱·피아노 소리·분석 엔진이 동작하게 한다.
// 저장소 이름의 숫자를 올리면(바깥에서 받는 것의 판을 바꿀 때) 새 판이 켜지면서 예전 저장소의 파일을 옮겨 오고 예전 것은 지운다.
const CACHE = "score-app-v2";
const CDN = /(^|\.)jsdelivr\.net$|^tonejs\.github\.io$|(^|\.)pythonhosted\.org$|^pypi\.org$/;
const CHANGING = /^pypi\.org$/;           // 내용이 바뀌는 주소(파이썬 꾸러미 목록): 인터넷이 되면 새것, 안 될 때만 저장해 둔 것
// 고정해 둔 판 (engine-worker.js 의 PDFMINER 와 같아야 한다 — tests/test_versions.py 가 확인). 저장해 둔 꾸러미 목록에 이 판이 없으면
// 그 목록으로는 설치할 수 없으므로 쓰지 않는다: 늦더라도 인터넷에서 새 목록을 받는다.
const PINS = { "pdfminer-six": "20260107" };
const LIVE = /\/scan(\/|$)/;               // 집 컴퓨터가 그때그때 답하는 주소(스캔 읽기): 저장하지도, 저장해 둔 것으로 대신하지도 않는다
const NET_MS = self.__TEST_NET_MS || 3000;  // "인터넷이 되면 새것"으로 받는 것을 기다리는 시간. 넘으면 저장해 둔 것으로 연다 (신호가 약한 곳)
let slowUntil = 0;                          // 한 번 늦었으면 이때까지는 기다리지 않고 저장해 둔 것부터 준다 (새 파일과 옛 파일이 섞여 열리지 않게)

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  // 예전 저장소에 받아 둔 파일(엔진·피아노 소리 등 수십 MB)은 다시 받지 않게 옮긴다. 바뀌는 정보(꾸러미 목록)는 옮기지 않는다:
  // 옛 목록이 남아 있으면 새로 정한 판을 못 찾을 수 있다.
  const now = await caches.open(CACHE);
  for (const name of await caches.keys()) {
    if (name === CACHE || !name.startsWith("score-app-")) continue;
    const old = await caches.open(name);
    for (const req of await old.keys()) {
      if (CHANGING.test(new URL(req.url).hostname) || (await now.match(req))) continue;
      const res = await old.match(req);
      if (res) await now.put(req, res);
    }
    await caches.delete(name);
  }
  await self.clients.claim();
})()));

// 바깥에서 받을 때는 "내용을 볼 수 있는 방식(cors)"으로 받는다. importScripts(…)나 <script src=…>는 no-cors로 요청하는데,
// 그대로 받으면 성공했는지조차 알 수 없는 응답이 와서 저장할 수 없다 (그래서 엔진 본체와 악보 그리는 도구가 저장되지 않았었다).
const fromNet = (req) => fetch(req.mode === "no-cors" ? new Request(req.url, { mode: "cors", credentials: "omit" }) : req);

// 저장해 둔 꾸러미 목록(…/simple/이름/)을 써도 되는가: 고정한 판의 파일(이름-판-….whl)이 그 안에 있어야 한다
async function listUsable(url, saved) {
  const pin = PINS[(url.pathname.match(/\/simple\/([^/]+)\//) || [])[1]];
  return !pin || (await saved.clone().text()).includes("-" + pin + "-");
}

// 인터넷 먼저. 끊겼거나 NET_MS 안에 대답이 없으면 저장해 둔 것(saved)을 준다. 늦게 온 새것은 다음에 쓰도록 저장만 해 둔다.
function freshOr(net, saved) {
  if (!saved) return net;                         // 저장해 둔 것이 없으면(처음 여는 기기) 기다리는 수밖에 없다
  let done = false;
  const fresh = net.then((res) => { done = true; return res; }, () => { done = true; return saved; });
  if (Date.now() < slowUntil) return saved;
  return Promise.race([fresh, new Promise((ok) => setTimeout(() => {
    if (done) return;
    slowUntil = Date.now() + NET_MS * 5;
    ok(saved);
  }, NET_MS))]);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (CDN.test(url.hostname)) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const keep = (res) => { if (res.ok) c.put(req, res.clone()); return res; };
      // 받는 대로 저장한다. 대답을 이미 내준 뒤에 늦게 도착해도 저장을 마칠 때까지 서비스 워커가 꺼지지 않게 한다
      const getNew = () => { const net = fromNet(req).then(keep); e.waitUntil(net.catch(() => {})); return net; };
      const hit = await c.match(req);
      if (CHANGING.test(url.hostname)) return freshOr(getNew(), hit && (await listUsable(url, hit)) ? hit : undefined);
      // 바깥에서 받아 오는 것(피아노 소리, PDF 화면, 엔진): 저장해 둔 것이 있으면 그것부터
      return hit || getNew();
    }));
  } else if (url.origin === location.origin && !url.pathname.startsWith("/dev/")) {
    if (LIVE.test(url.pathname) || req.cache === "no-store") return;      // 끼어들지 않는다: 브라우저가 직접 받는다
    // 앱 자체: 인터넷이 되면 새것, 끊겼거나 늦으면 저장해 둔 것
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const saved = await caches.match(req, { ignoreSearch: true });
      const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; });
      e.waitUntil(net.catch(() => {}));
      return freshOr(net, saved);
    }));
  }
});
