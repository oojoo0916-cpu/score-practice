// 화면: 악보 보관함 ↔ 연습 화면. 원본 악보(PDF)를 그대로 보여 주고 그 위에 지금 치는 마디와 음표를 표시한다.
import * as store from "./store.js";
import { Sound } from "./audio.js";
import { Player } from "./player.js";
import * as E from "./edits.js";
import * as MX from "./musicxml.js";
import * as XV from "./xmlview.js";
import * as OFF from "./offline.js";
import { meterKind, GROUPS, parseChord, checkState } from "./music.js";

const PDFJS = OFF.PDFJS_LIB.base;           // 악보 화면 도구의 주소 (기기에 맞는 판을 offline.js 가 고른다)
const MAX_PIXELS = 3.2e6;               // 쪽 하나를 그릴 때 점 개수 상한 (폰 메모리 보호)
const $ = (id) => document.getElementById(id);
// 기기에 기억해 두는 작은 설정(확대·재생 위치 표시 등). Safari 에서 "모든 쿠키 차단"을 켜면 읽기만 해도 오류가 나서 앱 전체가 멈췄다 → 못 쓰면 기억하지 않는다
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (err) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (err) { /* 기억하지 못해도 앱은 그대로 쓴다 */ } },
};
const sound = new Sound();
let worker = null, jobs = new Map(), jobId = 0;
let cur = null;                         // 열려 있는 곡: {rec, player, doc, pages, boxes, anchors, head, ...}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// 보관함 보호: 기기의 저장 공간이 모자랄 때 브라우저가 이 앱의 보관함을 지우지 않게 해 달라고 요청한다.
// 결과(window.__storagePersist): "granted" 지우지 않음 / "denied" 거절됨 / "unsupported" 이 브라우저에는 없는 기능 / "error"
function persistNote() {
  const el = $("persistNote"), st = window.__storagePersist;
  if (!el || st === undefined) return;
  el.hidden = st === "granted";
  el.textContent = "이 브라우저는 기기의 저장 공간이 모자라면 보관함을 지울 수 있어요. 중요한 곡과 고친 내용은 ⤓ 단추로 파일로 내보내 두세요.";
}
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().then((ok) => { window.__storagePersist = ok ? "granted" : "denied"; }, () => { window.__storagePersist = "error"; }).then(persistNote);
} else window.__storagePersist = "unsupported";

// 저장 실패는 조용히 넘기지 않는다 (저장 공간 부족, 브라우저의 사생활 보호 모드 등). 화면에 알리고 자세한 내용은 기록(console)에 남긴다.
const SAVE_FAIL = "이 기기에 저장하지 못했어요. 방금 바꾼 내용(설정·고친 음)이 사라질 수 있어요. 기기의 저장 공간을 확인하고, 중요한 곡은 보관함에서 ⤓ 단추로 내보내 두세요.";
let saveBroken = false, pendingSave = Promise.resolve();
function saveFailed(err) {
  console.error("보관함 저장 실패:", err);
  saveBroken = true;
  if (cur) pStatus(SAVE_FAIL, true); else libStatus(SAVE_FAIL, true);
}
function saveOk() {
  if (!saveBroken) return;
  saveBroken = false;                                    // 다시 저장되기 시작했다 → 실패 안내를 거둔다
  for (const id of ["pStatus", "libStatus"]) if ($(id).textContent === SAVE_FAIL) { $(id).hidden = true; $(id).textContent = ""; }
}
// 보관함에 넣기·고쳐 넣기가 실패하면 "읽지 못했다"가 아니라 "저장하지 못했다"고 알린다
const keep = (p) => p.catch((err) => { console.error("보관함 저장 실패:", err); throw Object.assign(new Error(SAVE_FAIL), { saveFail: true }); });
const why = (err, prefix) => (err && err.saveFail ? err.message : prefix + (err && err.message || err));

// ------------------------------------------------------------------ 보관함
// ---- 확인 상태를 쉬운 말로 (P3-1). "자동 검사 통과"는 사람이 확인했다는 뜻이 아니므로 직접 확인한 마디와 따로 센다.
// 자동 검사가 무엇이었는지는 읽은 방식마다 다르다: PDF 직접 읽기는 박자·세로 정렬·기호 검사, 스캔은 박자 합뿐, MusicXML 파일은 검사 없이 적힌 그대로
const autoLabel = (rec) => (rec.source === "scan" ? "박자 합만 맞음" : rec.kind === "xml" ? "파일 그대로" : "자동 검사만");
const AUTO_NOTE = (rec) => (rec.source === "scan" ? "박자 합만 맞아요 — 스캔은 음이 틀릴 수 있으니 원본과 견줘 보세요."
  : rec.kind === "xml" ? "MusicXML 파일에 적힌 그대로 옮긴 마디예요."
    : "자동 검사(박자·기호)만 통과했어요 — 음이 맞는지 직접 본 것은 아니에요.");
const WHY = { sum: "박자 합이 안 맞아요", align: "줄끼리 세로 위치가 어긋나요", symbol: "놓친 음표나 꼬리가 있을 수 있어요", check: "자동 검사에 걸렸어요",
  lyric: "가사 밑에 음표가 없어요 (음표를 놓쳤을 수 있어요)",
  stale: "고친 뒤에 악보를 다시 읽었더니 달라졌어요", tie: "이음줄을 붙임줄로 본 곳이 있어요(추정)" };
const UNSUP = { grace: "꾸밈음", grace_piano: "반주의 꾸밈음", unpitched: "음높이 없는 음표(타악기)", chord: "해석 못 한 코드" };
function stateText(rec, st, unit = "") {
  const n = st.count;
  return `확인 필요 ${n.unsure}${unit} · 직접 확인 ${n.user}${unit} · ${autoLabel(rec)} ${n.auto}${unit}` + (n.unsupported ? ` · 소리 안 나는 표기 ${n.unsupported}${unit}` : "");
}

// 스캔 곡에서 집 컴퓨터가 읽지 못한 쪽 ("2쪽, 4쪽"). 없으면 빈 글
const missedPages = (rec) => (rec.scanFailed && rec.scanFailed.length ? rec.scanFailed.map((p) => p + "쪽").join(", ") : "");

const fmtDate = (t) => new Date(t).toLocaleDateString("ko-KR", { month: "long", day: "numeric" });

async function showLibrary() {
  closeSong();
  $("practice").hidden = true;
  $("library").hidden = false;
  let songs;
  try { songs = await store.listSongs(); } catch (err) {
    console.error("보관함을 열지 못함:", err);
    libStatus("이 브라우저에서는 기기 안에 악보를 저장할 수 없어요. 아이폰·아이패드라면 설정 → 앱 → Safari 에서 \"모든 쿠키 차단\"을 끄고, 개인정보 보호 브라우징이 아닌 보통 창에서 열어 주세요.", true);
    $("empty").hidden = false;
    return;
  }
  songs.sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));
  $("empty").hidden = songs.length > 0;
  offlineNote();
  const edited = songs.filter((s) => s.edits && (Object.keys(s.edits.ov).length || Object.keys(s.edits.checked).length));
  $("exportBtn").hidden = !edited.length;
  $("exportBtn").onclick = () => {                      // 엔진 개선에 쓸 기록을 파일 하나로 받는다
    const blob = new Blob([JSON.stringify(E.exportLog(edited), null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `악보연습실-고친기록-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const ul = $("songList");
  ul.textContent = "";
  for (const s of songs) {
    const li = document.createElement("li");
    li.className = "song";
    const open = document.createElement("button");
    open.className = "open";
    const b = document.createElement("b"); b.textContent = s.title;
    const sp = document.createElement("span");
    // 어떤 방식으로 읽었는지, 걸린 시간, 확인 상태(확인 필요 · 직접 확인 · 자동 검사만 · 소리 안 나는 표기)
    const how = s.method ? `${s.method}${s.readSec ? ` ${s.readSec}초` : ""} · ` : "";
    const pn = s.stats.piano_need_check || 0;
    const ne = s.edits ? Object.keys(s.edits.ov).length : 0;
    // 박자표·빠르기를 악보에서 읽지 못해 4/4·♩=72 로 친 곡은 그렇다고 알려 준다 (조용히 가정하지 않는다)
    const guess = (s.stats.meter_guess ? " · 박자표를 못 읽음(4/4로 침)" : "") + (s.stats.tempo_found === false ? " · 빠르기 추정(♩=72)" : "")
      + (s.stats.tie_guess ? ` · 붙임줄 추정 ${s.stats.tie_guess}곳` : "")      // 스캔 인식: 같은 음을 잇는 이음줄을 붙임줄로 본 곳
      + (missedPages(s) ? ` · 읽지 못한 쪽 ${missedPages(s)}` : "");                 // 스캔 인식: 통째로 빠진 쪽
    sp.textContent = `${how}${s.stats.pages}쪽 ${s.stats.measures}마디 · ${stateText(s, checkState(E.applyEdits(s.song, s.edits)), "마디")}${pn ? ` · 반주 어림 ${pn}마디` : ""}${ne ? ` · 고친 곳 ${ne}` : ""}${guess}`;
    open.append(b, sp);
    open.onclick = () => openSong(s.id);
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "🗑"; del.setAttribute("aria-label", s.title + " 지우기");
    del.onclick = async () => { if (confirm(`"${s.title}" 악보를 보관함에서 지울까요?`)) { await store.deleteSong(s.id); showLibrary(); } };
    const out = document.createElement("button");
    out.className = "del out"; out.textContent = "⤓"; out.setAttribute("aria-label", s.title + " 파일로 내보내기"); out.title = "파일로 내보내기";
    out.onclick = () => exportSong(s);
    li.append(open);
    if (location.origin !== PUBLIC_ORIGIN) {               // 집 주소에서만: 밖에서 쓰는 주소로 바로 보내기
      const go = document.createElement("button");
      go.className = "del go"; go.textContent = "↗"; go.setAttribute("aria-label", s.title + " 밖에서 쓰는 주소로 보내기"); go.title = "밖에서 쓰는 주소로 보내기";
      go.onclick = () => sendOut(s);
      li.append(go);
    }
    li.append(out, del);
    ul.append(li);
  }
}

// ---- 곡 하나를 파일(이름.akbo.json)로: 읽은 결과·고친 내용·설정·원본 파일을 모두 담는다
const toB64 = (buf) => new Promise((ok, no) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(",", 2)[1] || "");
  r.onerror = () => no(r.error);
  r.readAsDataURL(new Blob([buf]));
});
const fromB64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0)).buffer;

async function exportSong(s) {
  try {
    libStatus(`"${s.title}" 내보낼 파일을 만드는 중…`);
    await flushSave();                                     // 아직 저장하지 않은 설정·고친 내용이 있으면 먼저 저장한다
    const rec = await store.getSong(s.id);
    const file = await store.getPdf(s.id);
    const orig = await store.getOrig(s.id).catch(() => null);
    const pack = { format: "akbo-1", made: new Date().toISOString(), rec, file: await toB64(file),
      orig: orig ? { name: orig.name, type: orig.type, buf: await toB64(orig.buf) } : null };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(pack)], { type: "application/json" }));
    a.download = s.title.replace(/[\\/:*?"<>|]/g, "_") + ".akbo.json";
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    libStatus(`"${s.title}"을(를) 파일로 내보냈어요. 다른 주소(예: 밖에서 쓰는 주소)에서 "악보 올리기"로 이 파일을 고르면 그대로 들어와요.`);
  } catch (err) {
    libStatus(why(err, "내보내지 못했어요: "), true);
  }
}

// 꾸러미(곡 하나) → 이 주소의 보관함에 넣는다. 파일에서 온 것은 글자(base64), 다른 창에서 바로 받은 것은 자료 그대로다.
async function takePack(pack) {
  if (!pack || pack.format !== "akbo-1" || !pack.rec || !pack.rec.song || !pack.file) throw new Error("악보 연습실에서 내보낸 곡이 아니에요");
  const bytes = (v) => (typeof v === "string" ? fromB64(v) : v);
  const rec = pack.rec;
  rec.id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2, 8);
  rec.addedAt = Date.now();
  delete rec.openedAt;
  await keep(store.addSong(rec, bytes(pack.file)));
  if (pack.orig) await keep(store.putOrig(rec.id, { name: pack.orig.name, type: pack.orig.type, buf: bytes(pack.orig.buf) }));
  return rec.title;
}

async function importPack(buf) {
  try {
    const title = await takePack(JSON.parse(new TextDecoder().decode(buf)));
    await showLibrary();
    libStatus(`"${title}" 가져오기 완료 (읽은 결과·고친 내용·설정이 그대로 들어왔어요)`);
  } catch (err) {
    libStatus(why(err, "가져오지 못했어요: "), true);
  }
}

// ---- 곡을 "밖에서 쓰는 주소"로 바로 보내기 (파일을 거치지 않는다)
// 보관함은 주소마다 따로다. 집 주소의 앱이 밖에서 쓰는 주소의 앱을 새 창으로 열고, 창과 창 사이로 곡을 건넨다.
// 곡은 이 기기 안에서만 옮겨지고 인터넷으로 나가지 않는다 (받는 쪽 앱이 자기 보관함에 저장할 뿐이다).
const PUBLIC_URL = (["localhost", "127.0.0.1"].includes(location.hostname) && new URLSearchParams(location.search).get("out")) || "https://oojoo0916-cpu.github.io/score-practice/";
const PUBLIC_ORIGIN = new URL(PUBLIC_URL).origin;
const isHomeOrigin = (o) => { try { return /^(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(new URL(o).hostname); } catch (err) { return false; } };

async function sendOut(s) {
  const win = window.open(PUBLIC_URL + "#receive", "_blank");      // 누른 그 순간에 열어야 새 창이 막히지 않는다
  if (!win) { libStatus("새 창이 막혀서 보내지 못했어요. 브라우저의 팝업 차단을 풀고 다시 눌러 주세요.", true); return; }
  libStatus(`"${s.title}"을(를) 밖에서 쓰는 주소로 보내는 중… (새 창이 열려요)`);
  let pack = null, done = false;
  const ready = (async () => {
    await flushSave();
    const rec = await store.getSong(s.id), file = await store.getPdf(s.id), orig = await store.getOrig(s.id).catch(() => null);
    pack = { format: "akbo-1", made: new Date().toISOString(), rec, file, orig: orig ? { name: orig.name, type: orig.type, buf: orig.buf } : null };
  })();
  const onMsg = async (e) => {
    if (e.origin !== PUBLIC_ORIGIN || !e.data || !e.data.akbo) return;
    if (e.data.akbo === "ready" && !done) { await ready; win.postMessage({ akbo: "pack", pack }, PUBLIC_ORIGIN); }
    if (e.data.akbo === "done") { done = true; window.removeEventListener("message", onMsg); libStatus(`"${s.title}" 보내기 완료. 이제 밖에서 쓰는 주소의 보관함에도 들어 있어요.`); }
    if (e.data.akbo === "error") { done = true; window.removeEventListener("message", onMsg); libStatus("보내지 못했어요: " + (e.data.message || ""), true); }
  };
  window.addEventListener("message", onMsg);
  setTimeout(() => { if (!done) { window.removeEventListener("message", onMsg); libStatus("보내지 못했어요 (새 창에서 응답이 없어요). 인터넷이 되는지 확인하고 다시 눌러 주세요.", true); } }, 90000);
}

// 받는 쪽: 집 주소의 앱이 이 창을 "#receive"를 붙여 열었을 때
const sender = window.opener || (window.parent !== window ? window.parent : null);      // 이 창을 열어 준 창 (시험에서는 틀 안에 열기도 한다)
if (location.hash === "#receive" && sender) {
  history.replaceState(null, "", location.pathname + location.search);
  let got = false;
  window.addEventListener("message", async (e) => {
    if (got || !e.data || e.data.akbo !== "pack" || !isHomeOrigin(e.origin)) return;     // 집 안 주소에서 온 것만 받는다
    got = true;
    try {
      const title = await takePack(e.data.pack);
      e.source.postMessage({ akbo: "done" }, e.origin);
      await showLibrary();
      libStatus(`"${title}"을(를) 받았어요. 이제 이 주소에서 컴퓨터 없이 연습할 수 있어요.`);
    } catch (err) {
      e.source.postMessage({ akbo: "error", message: err.message }, e.origin);
      libStatus("곡을 받지 못했어요: " + err.message, true);
    }
  });
  let tries = 0;
  const knock = setInterval(() => {                                // 보낸 쪽이 준비될 때까지 "받을 준비 됐어요"를 알린다 (곡 내용은 들어 있지 않다)
    if (got || ++tries > 200) { clearInterval(knock); return; }
    try { sender.postMessage({ akbo: "ready" }, "*"); } catch (err) { /* 열어 준 창이 닫혔다 */ }
  }, 400);
  setTimeout(() => { if (!got) libStatus("집 주소에서 보낸 곡을 기다리는 중…"); }, 300);
}

function libStatus(text, err = false) {
  const el = $("libStatus");
  el.hidden = !text; el.textContent = text || ""; el.classList.toggle("err", err);
}

// 분석 엔진이 낸 오류를 쉬운 한 줄로 바꾼다. 파이썬 오류문 같은 원문은 화면에 내지 않고 기록(console)에만 남긴다.
function explain(err) {
  const raw = String(err && err.message || err);
  const dev = /Traceback|Error\b|Exception|File "|\.py\b|https?:\/\/|importScripts|micropip/.test(raw) || raw.length > 140;      // 개발자용 오류문처럼 보이는가
  if (dev) console.error("악보 읽기 오류 (원문):\n" + raw);
  if (/PDFSyntaxError|No \/Root object|PSEOF|PDFNoValidXRef|Is this really a PDF|Unexpected EOF/i.test(raw)) return "PDF 파일이 깨졌거나 PDF가 아니에요. 파일을 다시 받아서 올려 주세요.";
  if (/PDFPasswordIncorrect|PDFEncryptionError|PDFTextExtractionNotAllowed|encrypt/i.test(raw)) return "암호가 걸린 PDF라서 읽을 수 없어요. 암호를 푼 파일로 올려 주세요.";
  if (/MemoryError|out of memory|allocation failed/i.test(raw)) return "악보가 너무 커서 이 기기에서는 읽지 못했어요. 쪽 수가 적은 파일로 나눠 올려 주세요.";
  if (/NetworkError|Failed to fetch|Load failed|importScripts|Can't fetch|micropip|wheel|ERR_INTERNET|엔진 파일을 찾지 못했어요/i.test(raw)) return "분석 엔진을 받지 못했어요. 인터넷이 되는지 확인하고 다시 올려 주세요.";
  if (dev) return "악보를 읽는 중에 문제가 생겼어요. 같은 파일에서 계속 그러면 아직 읽지 못하는 악보예요.";
  return raw;                                            // 앱이 직접 만든 쉬운 안내(시간 초과 등)는 그대로
}

// 끝없이 기다리지 않는다: 단계마다 기다리는 시간의 상한(밀리초)이 있고, 넘으면 멈추고 알린다. 자동 시험은 window.__TEST_LIMITS 로 줄여 쓴다.
// 엔진 준비 3분, 스캔 기다리기 15분(2초마다 물어봄). 악보 읽기는 쪽 수에 맞춘다: 60초 + 쪽마다 20초
const LIMITS = { engineInit: 180000, readBase: 60000, readPerPage: 20000, scanPoll: 900000, scanStep: 2000 };
const limit = (k) => (window.__TEST_LIMITS && window.__TEST_LIMITS[k]) || LIMITS[k];
const readLimit = (pages) => limit("readBase") + (pages || 3) * limit("readPerPage");      // 쪽 수를 모르면 3쪽으로 친다 (= 2분)

// 오래 걸리는 일(악보 읽기, 스캔 기다리기)을 하는 동안 "취소" 단추를 보여 준다
let busyCancel = null;
let slowJob = null;                              // 읽기가 정해 둔 시간을 넘겨서 "더 기다릴까요?"를 묻고 있는 일
function busy(cancel) { busyCancel = cancel; $("cancelBtn").hidden = false; }
function idle() { busyCancel = null; slowJob = null; $("cancelBtn").hidden = true; $("slowAsk").hidden = true; }
$("cancelBtn").onclick = $("stopReadBtn").onclick = () => { const c = busyCancel; idle(); if (c) c(); };

// 읽기가 정해 둔 시간을 넘겼다: 바로 끊지 않고 더 기다릴지 묻는다. 묻는 동안에도 엔진은 계속 읽는다 (그 사이에 끝나면 그 결과를 그대로 받는다)
function askMore(j) {
  slowJob = j;
  const sec = Math.round((performance.now() - j.readStart) / 1000);
  $("slowText").textContent = `악보를 읽는 데 오래 걸리고 있어요 (${j.pages ? j.pages + "쪽, " : ""}${sec}초째). 더 기다릴까요?`;
  $("slowAsk").hidden = false;
  $("cancelBtn").hidden = true;                  // 취소는 물음 안의 단추로
  // 끝없이 기다리지는 않는다: 대답이 없으면 같은 시간만큼만 더 기다린 뒤 멈춘다 (화면을 꺼 둔 채 엔진이 멈춰 있는 경우)
  clearTimeout(j.timer);
  j.timer = setTimeout(() => stopEngine(new Error("악보를 읽는 데 너무 오래 걸려서 멈췄어요. 다시 올려 보시고, 계속 그러면 쪽 수가 적은 파일로 나눠 올려 주세요.")), readLimit(j.pages));
}
$("waitMoreBtn").onclick = () => {
  const j = slowJob;
  slowJob = null;
  $("slowAsk").hidden = true;
  if (!j || !jobs.has(j.id)) return;
  $("cancelBtn").hidden = false;
  j.arm("read");                                 // 같은 시간만큼 한 번 더 기다린다
};

// 분석 엔진(워커)을 끄고, 기다리던 일을 모두 그 이유(err)로 끝낸다. 다음에 읽을 때 새 워커를 만든다 (멈춘 워커를 다시 쓰지 않는다)
function stopEngine(err) {
  if (worker) { try { worker.terminate(); } catch (e) { /* 이미 끝난 워커 */ } worker = null; }
  const waiting = [...jobs.values()];
  jobs.clear();
  for (const j of waiting) { clearTimeout(j.timer); j.no(err); }
  idle();
}

function analyze(bytes, title, onProgress, warm = false) {
  if (!worker) {
    worker = new Worker("engine-worker.js");
    worker.onmessage = (e) => {
      const j = jobs.get(e.data.id);
      if (!j) return;
      if (e.data.progress) {
        if (e.data.phase === "read") { j.pages = e.data.pages || 0; j.readStart = performance.now(); j.arm("read"); }
        return j.onProgress(e.data.progress);
      }
      clearTimeout(j.timer);
      jobs.delete(e.data.id);
      if (!jobs.size) idle();
      e.data.error ? j.no(new Error(e.data.error)) : j.ok(e.data.result);
    };
    worker.onerror = (e) => stopEngine(new Error(e.message || "분석 엔진을 시작하지 못했어요"));
  }
  return new Promise((ok, no) => {
    const id = ++jobId, j = { id, ok, no, onProgress, timer: 0, pages: 0, readStart: 0 };
    // 단계별 시간 제한: 처음에는 "엔진 준비"(넘으면 멈춘다), 워커가 읽기 시작했다고 알리면 "악보 읽기"(쪽 수에 맞춘 시간, 넘으면 더 기다릴지 묻는다)
    j.arm = (phase) => {
      clearTimeout(j.timer);
      j.timer = phase === "read"
        ? setTimeout(() => askMore(j), readLimit(j.pages))
        : setTimeout(() => stopEngine(new Error("분석 엔진을 준비하는 데 너무 오래 걸려서 멈췄어요. 인터넷이 되는지 확인하고 다시 올려 주세요.")), limit("engineInit"));
    };
    jobs.set(id, j);
    j.arm("init");
    busy(() => stopEngine(Object.assign(new Error("읽기를 취소했어요."), { cancelled: true })));
    worker.postMessage({ id, bytes, title, warm });
  });
}

// ---- 인터넷 없이 쓸 준비가 됐는지: 보관함 아래에 알려 준다 (분석 엔진·악보 화면 도구·피아노 소리가 기기에 다 저장됐는지)
async function offlineNote(msg) {
  const el = $("offlineNote");
  if (msg) { el.hidden = false; el.textContent = msg; return; }
  let st;
  try { st = await OFF.status(); } catch (err) { st = { supported: false }; }
  el.hidden = false;
  el.textContent = "";
  if (!st.supported) { el.textContent = "인터넷 없이 쓰기: 이 주소에서는 안 돼요 (와이파이로 집 컴퓨터에 접속한 주소). 밖에서 쓰는 주소에서는 됩니다."; return; }
  if (st.ready) { el.textContent = "인터넷 없이 쓸 준비 완료 ✓ (분석 엔진 · 악보 화면 · 피아노 소리)"; return; }
  const mark = (p) => (p.ok ? "✓" : p.have ? `${p.have}/${p.need}` : "✗");
  const label = document.createElement("span");
  label.textContent = `인터넷 없이 쓰려면 더 받아 둘 것이 있어요 — 분석 엔진 ${mark(st.engine)} · 악보 화면 ${mark(st.pdfjs)} · 피아노 소리 ${st.piano.have}/${st.piano.need} `;
  const b = document.createElement("button");
  b.className = "link"; b.id = "offlineBtn"; b.textContent = "지금 받아 두기";
  b.onclick = async () => {
    b.disabled = true;
    try {
      await OFF.prepare({ pdfjsBase: PDFJS, warmEngine: () => analyze(null, "", () => {}, true), onProgress: (t) => { label.textContent = t + " "; } });
      offlineNote();
    } catch (err) {
      offlineNote(err.cancelled ? "받아 두기를 취소했어요." : "받아 두지 못했어요: " + explain(err) + " (인터넷이 될 때 다시 눌러 주세요)");
    }
  };
  el.append(label, b);
}

// 엔진이 좋아지면 이 숫자를 올린다 → 보관함의 곡을 열 때 저장해 둔 PDF로 자동으로 다시 읽는다 (설정은 그대로)
const ENGINE = 23;
const XMLV = 10;                          // MusicXML 옮기는 규칙이 바뀌면 올린다
const isXml = (rec) => rec.kind === "xml";
const wantEngine = (rec) => (isXml(rec) ? "xml" + XMLV : ENGINE);

async function rereadXml(rec) {
  try {
    const res = MX.parse(await MX.xmlText(await store.getPdf(rec.id)), rec.title, { check: rec.source === "scan" });
    const same = res.song.measures.length === rec.song.measures.length;
    if (rec.edits) rec.rereadNote = E.reconcile(res.song, rec.edits);
    Object.assign(rec, { song: res.song, stats: res.stats, engine: wantEngine(rec) });
    if (!same && rec.settings) { rec.settings.loop = null; rec.settings.k = 0; }
    await keep(store.putSong(rec));
  } catch (err) {
    libStatus(why(err, "파일을 다시 읽지 못해서 예전 결과로 엽니다: "), true);
  }
  return rec;
}

async function reread(rec) {
  if (isXml(rec)) return rereadXml(rec);
  try {
    libStatus(`"${rec.title}"을(를) 새 엔진으로 다시 읽고 있어요…`);
    const t0 = performance.now();
    const buf = await store.getPdf(rec.id);
    const res = await analyze(new Uint8Array(buf.slice(0)), rec.title, (p) => libStatus(p + "…"));
    if (res.song.measures.length) {
      const same = res.song.measures.length === rec.song.measures.length;
      // 고친 내용은 지우지 않는다: 새로 읽은 결과에 맞춰 정리해서 계속 덧씌운다
      if (rec.edits) rec.rereadNote = E.reconcile(res.song, rec.edits);
      Object.assign(rec, { song: res.song, stats: res.stats, engine: ENGINE, sha256: res.sha256,
        method: "PDF 직접 읽기" + (res.program ? ` (${res.program})` : ""), readSec: ((performance.now() - t0) / 1000).toFixed(1) });
      if (!same && rec.settings) { rec.settings.loop = null; rec.settings.k = 0; }
      await keep(store.putSong(rec));
    }
    libStatus("");
  } catch (err) {
    libStatus(err.saveFail ? err.message : "새 엔진으로 다시 읽지 못해서 예전 결과로 엽니다: " + explain(err), true);
  }
  return rec;
}

async function addPdf(buf, name) {
  const title = name.replace(/\.pdf$/i, "").replace(/_\d{6}$/, "").trim();
  const t0 = performance.now();
  try {
    const res = await analyze(new Uint8Array(buf.slice(0)), title, (p) => libStatus(p + "…"));
    if (!res.song.measures.length) {
      if (res.kind === "scan") { await addScan(buf, name); return; }
      const why = {
        scan: "이 PDF는 악보를 스캔하거나 사진으로 찍은 것이에요 (안에 그림만 들어 있어요).",
        font: `이 악보는 아직 읽지 못하는 사보 프로그램으로 만들어졌어요 (음악 글꼴: ${res.fonts.join(", ")}). 이 문구를 알려 주시면 읽을 수 있게 추가할게요.`,
        none: "이 PDF에서는 악보를 찾지 못했어요. 악보가 아닌 문서이거나, 음표가 글자가 아닌 도형으로만 들어 있는 PDF일 수 있어요.",
      };
      libStatus(why[res.kind] || why.none, true);
      return;
    }
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    const rec = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), title, addedAt: Date.now(), stats: res.stats, song: res.song, settings: null, engine: ENGINE, sha256: res.sha256, edits: E.emptyEdits(),
      method: "PDF 직접 읽기" + (res.program ? ` (${res.program})` : ""), readSec: sec };
    await keep(store.addSong(rec, buf));
    libStatus(`"${title}" 읽기 완료 (${sec}초, ${res.stats.measures}마디${res.stats.need_check.length ? `, 확인 필요 ${res.stats.need_check.length}마디` : ""})`);
    await openSong(rec.id);
  } catch (err) {
    if (err.cancelled) { libStatus(err.message); return; }
    libStatus(err.saveFail ? err.message : "악보를 읽지 못했어요: " + explain(err) + (navigator.onLine ? "" : " (분석 엔진을 처음 받을 때는 인터넷이 필요해요)"), true);
  }
}

// MusicXML 파일: 사보 프로그램이 내보낸 악보 자료. 음표가 글자로 적혀 있어서 인식 없이 그대로 옮긴다.
// scan: 스캔 인식으로 만든 파일이면 { sec: 걸린 시간 } — 틀린 곳이 있을 수 있으니 박자 합이 안 맞는 마디를 '확인 필요'로 표시한다
async function addXml(buf, name, scan = null) {
  const title = name.replace(/\.(musicxml|mxl|xml|pdf|png|jpe?g|tiff?|bmp|webp)$/i, "").replace(/_\d{6}$/, "").trim();
  const t0 = performance.now();
  try {
    if (!scan) libStatus("MusicXML 파일을 읽고 있어요…");
    const res = MX.parse(await MX.xmlText(buf), title, { check: !!scan });
    const sec = scan ? scan.sec : ((performance.now() - t0) / 1000).toFixed(1);
    const rec = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), kind: "xml", title, addedAt: Date.now(), stats: res.stats, song: res.song, settings: null,
      engine: "xml" + XMLV, edits: E.emptyEdits(), method: scan ? `스캔 인식 (${scan.engine === "homr" ? "homr" : "Audiveris"})` : "MusicXML 파일", readSec: sec };
    if (scan) rec.source = "scan";
    if (scan && scan.layout) rec.layout = scan.layout;      // 원본 그림 위의 마디 자리 (집 컴퓨터가 찾아 준 것)
    if (scan && scan.failed && scan.failed.length) { rec.scanFailed = scan.failed.slice(); rec.scanPages = scan.pages || 0; }      // 읽지 못한 쪽 — 보관함과 곡 화면에 알린다
    await keep(store.addSong(rec, buf));
    let origLost = false;                                   // 올린 원본(스캔 그림)을 못 넣어도 곡은 쓸 수 있다 → 곡은 열고, 못 넣었다는 것은 알린다
    if (scan && scan.orig) await store.putOrig(rec.id, scan.orig).catch((err) => { console.error("올린 원본 저장 실패:", err); origLost = true; });
    const need = res.stats.need_check.length;
    libStatus(`"${title}" 읽기 완료 (${sec}초, ${res.stats.measures}마디${need ? `, 확인 필요 ${need}마디` : ""})`
      + (scan ? " — 스캔 악보는 틀린 곳이 있을 수 있어요. 원본 악보와 같이 보면서 \"고치기\"로 확인해 주세요." : "")
      + (origLost ? " (올린 원본 그림은 이 기기에 저장하지 못했어요. 기기의 저장 공간을 확인해 주세요.)" : ""), origLost);
    await openSong(rec.id);
  } catch (err) {
    libStatus(why(err, scan ? "스캔 인식 결과를 열지 못했어요: " : "MusicXML 파일을 읽지 못했어요: "), true);
  }
}

// ---- 스캔·사진 악보: 폰 안에서는 무거워서 못 읽는다 → 집 컴퓨터(이 앱을 열어 준 서버)에 보내서 읽고 결과만 받는다.
// 악보는 집 컴퓨터까지만 가고 인터넷으로 나가지 않는다. 앱을 다른 주소(인터넷)에서 열었으면 쓸 수 없다.
let scanOk = null;
async function scanAvailable() {
  if (scanOk === null) {
    try { scanOk = !!(await (await fetch("scan/ping", { cache: "no-store" })).json()).ok; } catch (err) { scanOk = false; }
  }
  return scanOk;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const timed = (ms) => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);      // 대답 없는 요청을 ms 뒤에 끊는다 (옛 브라우저에서는 생략)

async function addScan(buf, name) {
  if (!(await scanAvailable())) {
    libStatus("이 악보는 스캔하거나 사진으로 찍은 것이에요 (안에 그림만 들어 있어요). 스캔·사진 악보는 집 컴퓨터가 읽어 줘야 해서, 집 컴퓨터를 켜고 같은 와이파이에서 \"폰에서 열기\" 주소로 앱을 열었을 때만 읽을 수 있어요.", true);
    return;
  }
  const t0 = performance.now();
  let cancelled = false;
  busy(() => { cancelled = true; libStatus("스캔 읽기를 취소했어요. (집 컴퓨터는 읽던 것을 마저 읽고 버려요)"); });
  try {
    libStatus("스캔 악보예요. 집 컴퓨터로 보내는 중…");
    const r = await fetch("scan?name=" + encodeURIComponent(name), { method: "POST", body: buf });
    const j = await r.json();
    if (!j.job) throw new Error(j.error || "보내지 못했어요");
    for (;;) {
      await wait(limit("scanStep"));
      if (cancelled) return;
      if (performance.now() - t0 > limit("scanPoll")) throw new Error("집 컴퓨터가 너무 오래 걸려서 기다리기를 멈췄어요. 집 컴퓨터의 창이 켜져 있는지 확인하고 다시 올려 주세요.");
      const s = await (await fetch("scan/status?job=" + encodeURIComponent(j.job), { cache: "no-store", signal: timed(30000) })).json();
      if (cancelled) return;
      if (s.state === "error") throw new Error(s.error || "읽지 못했어요");
      if (s.state === "done") {
        const sec = ((performance.now() - t0) / 1000).toFixed(0);
        const type = /\.pdf$/i.test(name) ? "application/pdf" : /\.png$/i.test(name) ? "image/png" : "image/jpeg";
        const info = s.info || {};
        await addXml(new TextEncoder().encode(s.xml).buffer, name, { sec, engine: info.engine, layout: info.layout, orig: { name, type, buf },
          failed: Array.isArray(info.failed_pages) ? info.failed_pages : [], pages: info.pages || 0 });      // 읽지 못한 쪽(그 쪽의 마디는 곡에 없다)
        return;
      }
      libStatus(`집 컴퓨터가 스캔 악보를 읽는 중… ${Math.round((performance.now() - t0) / 1000)}초${s.note && /\d+\/\d+쪽/.test(s.note) ? ` (${s.note.match(/\d+\/\d+쪽/)[0]})` : ""} — 한 쪽에 30초쯤 걸려요. 화면을 끄지 말고 기다려 주세요`);
    }
  } catch (err) {
    if (!cancelled) libStatus("스캔 악보를 읽지 못했어요: " + (err.name === "TimeoutError" || err.name === "AbortError" ? "집 컴퓨터가 대답하지 않아요." : err.message), true);
  } finally {
    idle();
  }
}

$("file").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  if (/\.(akbo|json)$/i.test(f.name) || f.type === "application/json") { await importPack(await f.arrayBuffer()); return; }
  if (/\.(musicxml|mxl|xml)$/i.test(f.name)) { await addXml(await f.arrayBuffer(), f.name); return; }
  if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) {
    if (/^image\//.test(f.type) || /\.(png|jpe?g|tiff?|bmp|webp)$/i.test(f.name)) { await addScan(await f.arrayBuffer(), f.name); return; }
    libStatus("읽을 수 없는 파일이에요. 악보 PDF, MusicXML 파일, 악보 사진을 올려 주세요.", true);
    return;
  }
  await addPdf(await f.arrayBuffer(), f.name);
};

// 개발할 때만: 기준 곡을 바로 불러오는 단추 (올린 앱에는 /dev/ 가 없어서 나타나지 않는다)
if (["localhost", "127.0.0.1"].includes(location.hostname) && new URLSearchParams(location.search).has("dev")) {
  $("devBox").hidden = false;
  for (const [f, t] of [["m16", "썬탠보이 Rep."], ["m17", "소원은 해피엔딩 Rep."]]) {
    const b = document.createElement("button");
    b.className = "btn"; b.textContent = "기준 곡 " + f; b.id = "dev-" + f;
    b.onclick = async () => addPdf(await (await fetch(`/dev/${f}.pdf`)).arrayBuffer(), t + ".pdf");
    $("devBox").append(b);
  }
  const x = document.createElement("button");
  x.className = "btn"; x.textContent = "MusicXML 시험 곡"; x.id = "dev-xml";
  x.onclick = async () => addXml(new TextEncoder().encode((await import("./musicxml.test.js")).SAMPLE).buffer, "MusicXML 시험 곡.musicxml");
  $("devBox").append(x);
}

// ------------------------------------------------------------------ 연습 화면
const hasPiano = (song) => song.parts.some((p) => p.role === "piano" && p.notes.length);

function defaults(song) {
  // 악보에 피아노 반주가 적혀 있으면 그것을 치고, 코드로 만든 반주는 꺼 둔다 (둘 다 켜면 겹친다)
  const piano = hasPiano(song);
  const tracks = { chord: { vol: 0.55, mute: piano, solo: false }, metro: { vol: 0.7 } };
  if (piano) tracks.piano = { vol: 0.7, mute: false, solo: false };
  for (const p of song.parts) if (p.role === "vocal") tracks[p.id] = { vol: 0.85, mute: false, solo: false };
  return { ratio: 1, transpose: 0, countIn: false, metro: false, style: "long", loop: null, k: 0, tracks };
}

let pdfjsP = null;
function pdfjs() {
  const L = OFF.PDFJS_LIB;
  // 4판은 모듈(import), 3판(오래된 아이폰·아이패드용)은 보통 스크립트라서 불러온 뒤 window.pdfjsLib 로 꺼낸다
  const load = () => (L.module ? import(L.base + L.main) : new Promise((ok, no) => {
    const s = document.createElement("script");
    s.src = L.base + L.main;
    s.onload = () => (window.pdfjsLib ? ok(window.pdfjsLib) : no(new Error("악보 화면 도구를 열지 못했어요")));
    s.onerror = () => no(new Error("악보 화면 도구를 받지 못했어요 (Failed to fetch)"));
    document.head.append(s);
  }));
  pdfjsP = pdfjsP || load().then((m) => { m.GlobalWorkerOptions.workerSrc = L.base + L.worker; return m; });
  pdfjsP.catch(() => { pdfjsP = null; });          // 받지 못했으면 다음에 다시 받아 본다
  return pdfjsP;
}

function pStatus(text, err = false) {
  const el = $("pStatus");
  el.hidden = !text; el.textContent = text || ""; el.classList.toggle("err", err);
}

// 스캔 곡: 집 컴퓨터가 원본 그림에서 찾아 준 마디 자리(layout)를 곡 자료에 채운다 → PDF 악보처럼 원본 위에 표시할 수 있다.
// 음표의 가로 자리는 마디 안에서 박에 비례해 어림하고(인식 프로그램이 음표 자리는 알려 주지 않는다), 세로 자리는 오선 위치와 음높이로 계산한다.
const STEP_IDX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const CLEF_BASE = { G: 30, F: 18, C: 24 };              // 오선 맨 아래 줄의 음(E4, G2, F3)을 "옥타브×7 + 음이름 번호"로
function applyLayout(song, lay) {
  if (!lay || !lay.measures || lay.measures.length !== song.measures.length || !lay.pages || !lay.pages.length) return false;
  song.pages = lay.pages.map((p) => ({ n: p.n, w: p.w, h: p.h }));
  song.measures.forEach((m, i) => { const L = lay.measures[i]; m.page = L.page; m.system = L.system; m.box = L.box.slice(); });
  for (const part of song.parts) for (const n of part.notes) {
    const m = song.measures[n.m], L = lay.measures[n.m], [x0, y0, x1, y1] = L.box;
    const st = L.staves && L.staves[part.xml];
    const il = st && st[2] !== "piano" ? (st[1] - st[0]) / 4 : (y1 - y0) / 24;
    const pad = Math.min(L.first ? 7 * il : 1.3 * il, (x1 - x0) * 0.4);          // 줄 첫 마디는 음자리표·조표 자리를 비운다
    n.page = L.page;
    n.x = Math.round((x0 + pad + (x1 - x0 - pad) * 0.96 * Math.min(1, n.beat / m.len)) * 10) / 10;
    const k = /^([A-G])[#b]*(-?\d+)$/.exec(n.name || "");
    let y = (y0 + y1) / 2;
    if (st && st[2] in CLEF_BASE && k) y = st[1] - ((+k[2]) * 7 + STEP_IDX[k[1]] - CLEF_BASE[st[2]]) * (st[1] - st[0]) / 8;
    else if (st) y = st[0] + (st[1] - st[0]) * (part.sub === 2 ? 0.8 : part.sub === 1 ? 0.2 : 0.5);
    n.y = Math.round(y * 10) / 10;
  }
  return true;
}

async function openSong(id) {
  let rec = await store.getSong(id);
  if (!rec) return showLibrary();
  if (rec.engine !== wantEngine(rec)) rec = await reread(rec);
  rec.edits = rec.edits || E.emptyEdits();
  let svg = null, orig = null;
  if (isXml(rec) && rec.layout) {                         // 스캔 곡: 올린 원본 그림 위에 표시한다
    orig = await store.getOrig(id).catch(() => null);
    if (!orig || !applyLayout(rec.song, rec.layout)) orig = null;
  }
  if (isXml(rec) && !orig) {                              // 원본 그림이 없으니 악보를 직접 그리고, 마디·음표 자리를 곡 자료에 채운다
    try {
      const kept = await store.getDraw(id).catch(() => null);
      if (kept && kept.v === XV.DRAWV && rec.song.drawCheck) svg = XV.fromHtml(kept.html);     // 전에 그려 둔 것
      if (!svg) {
        libStatus(`"${rec.title}" 악보를 그리고 있어요…`);
        svg = await XV.render(rec.song, await MX.xmlText(await store.getPdf(id)));
        await store.putDraw(id, { v: XV.DRAWV, html: svg.outerHTML }).catch((err) => console.warn("그려 둔 악보를 저장하지 못했어요 (다음에 열 때 다시 그립니다):", err));
        libStatus("");
      }
    } catch (err) {
      libStatus("악보를 그리지 못했어요: " + err.message + (navigator.onLine ? "" : " (처음 한 번은 인터넷이 필요해요)"), true);
      return;
    }
  }
  const song = E.applyEdits(rec.song, rec.edits);        // 엔진이 읽은 것 + 사용자가 고친 것
  const cfg = { ...defaults(song), ...(rec.settings || {}) };
  cfg.tracks = { ...defaults(song).tracks, ...(rec.settings && rec.settings.tracks || {}) };
  if (hasPiano(song) && !(rec.settings && rec.settings.tracks && rec.settings.tracks.piano)) cfg.tracks.chord.mute = true;
  // 스캔 곡: 인식한 피아노 줄은 틀린 음이 많아 지저분하다 → 악보에 인쇄된 코드 기호를 읽었으면 처음에는 코드 반주를 켜고 피아노 줄은 꺼 둔다 ("파트·반주"에서 바꿀 수 있다)
  if (rec.source === "scan" && !rec.settings && cfg.tracks.piano && song.measures.filter((m) => m.chords.length).length >= song.measures.length * 0.15) {
    cfg.tracks.chord.mute = false;
    cfg.tracks.piano.mute = true;
  }
  rec.openedAt = Date.now();
  const player = new Player(song, sound, cfg);
  player.pos = player.starts[Math.min(cfg.k || 0, player.starts.length - 1)] || 0;
  const origImg = orig && orig.type !== "application/pdf" ? URL.createObjectURL(new Blob([orig.buf], { type: orig.type })) : null;
  const c = cur = { rec, song, cfg, player, svg, orig, origImg, pages: new Map(), boxes: [], anchors: [], head: null, lastK: -1, lastSys: "", pick: null, raf: 0,
    ed: { on: false, mi: -1, part: null, idx: -1, marks: [], zoomWas: 1 }, names: { on: false, els: [] } };
  player.onEnd = () => refreshPlay();
  $("library").hidden = true;
  $("practice").hidden = false;
  $("pTitle").textContent = rec.title;
  $("origBtn").hidden = true;
  if (rec.source === "scan" && !orig) {                   // (다시 그린 악보로 볼 때만) 올린 원본을 새 창에서 볼 수 있게 (누르는 순간에는 이미 주소가 준비되어 있어야 창이 막히지 않는다)
    store.getOrig(id).then((o) => {
      if (!o || cur !== c) return;
      c.origUrl = URL.createObjectURL(new Blob([o.buf], { type: o.type }));
      $("origBtn").href = c.origUrl;
      $("origBtn").hidden = false;
    }).catch(() => {});
  }
  applyZoom(false);
  applyCursor();
  buildPages();
  drawNames();
  buildMixer();
  refreshAll();
  save();
  loop();
  sound.onStatus = (t) => pStatus(t, /못했/.test(t));
  setEditing(false);
  if (rec.rereadNote) {
    const r = rec.rereadNote;
    delete rec.rereadNote;
    if (r.kept || r.caughtUp.length || r.stale.length || r.lost.length) {
      pStatus(`악보를 새로 읽었어요. 고친 내용: 그대로 유지 ${r.kept}곳` + (r.caughtUp.length ? `, 이제 엔진이 똑같이 읽어서 기록을 지운 곳 ${r.caughtUp.length}곳` : "")
        + (r.stale.length + r.lost.length ? `, 다시 확인이 필요한 곳 ${r.stale.length + r.lost.length}곳 (주황 점선 표시)` : ""));
    }
  }
  // 스캔에서 통째로 빠진 쪽이 있으면 열 때마다 알린다 — 다른 안내에 덮이지 않게 제 줄(#pMissed)에 둔다 (그 쪽의 마디는 곡에 없어서, 모르고 연습하면 중간이 건너뛰어진다)
  $("pMissed").hidden = !missedPages(rec);
  if (missedPages(rec)) $("pMissed").textContent = (`이 스캔 악보의 ${missedPages(rec)}은 읽지 못했어요${rec.scanPages ? ` (전체 ${rec.scanPages}쪽)` : ""}. 그 쪽의 마디는 빠져 있어요 — 그 쪽만 더 또렷하게 찍어서 다시 올려 보세요.`);
  if (svg) {
    const dc = rec.song.drawCheck;
    // 스캔 곡은 '확인 필요' 표시가 따로 있으므로 이 안내는 띄우지 않는다
    if (dc && dc.matched < dc.notes && rec.source !== "scan") pStatus(`그려진 악보와 읽은 음이 서로 다른 곳이 ${dc.notes - dc.matched}군데 있어요. 소리가 악보와 다르게 들리면 그 마디를 "고치기"로 확인해 주세요.`);
    scrollToMeasure(player.kAt(player.pos), false);
    return;
  }
  if (origImg) { scrollToMeasure(player.kAt(player.pos), false); return; }      // 사진 원본은 그림 그대로 보여 준다
  try {
    const lib = await pdfjs();
    const data = orig ? orig.buf : await store.getPdf(id);
    const doc = await lib.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
    if (cur !== c) { doc.destroy(); return; }          // 그리는 사이에 보관함으로 나갔다
    c.doc = doc;
    observePages();
  } catch (err) {
    if (cur !== c) return;
    pStatus("원본 악보 화면을 그리지 못했어요" + (navigator.onLine ? ": " + err.message : ". 처음 한 번은 인터넷이 필요해요."), true);
  }
  scrollToMeasure(player.kAt(player.pos), false);
}

function closeSong() {
  if (!cur) return;
  cur.player.pause();
  cancelAnimationFrame(cur.raf);
  if (cur.io) cur.io.disconnect();
  if (cur.doc) cur.doc.destroy();
  if (cur.origUrl) URL.revokeObjectURL(cur.origUrl);
  if (cur.origImg) URL.revokeObjectURL(cur.origImg);
  save(true);
  $("score").textContent = "";
  cur = null;
}

let saveTimer = 0;
// 미뤄 둔 저장이 있으면 지금 하고, 진행 중인 저장이 끝날 때까지 기다린다 (내보내기·보내기 전에 부른다)
async function flushSave() {
  if (cur && saveTimer) save(true);
  await pendingSave;
}
function save(now = false) {
  if (!cur) return;
  const c = cur;
  const run = () => { saveTimer = 0; c.cfg.k = c.player.kAt(c.player.now()); c.rec.settings = JSON.parse(JSON.stringify(c.cfg)); pendingSave = store.putSong(c.rec).then(saveOk, saveFailed); };
  clearTimeout(saveTimer);
  if (now) run(); else saveTimer = setTimeout(run, 600);
}

// ---- 원본 악보 쪽과 그 위의 마디 상자
function buildPages() {
  const root = $("score");
  root.textContent = "";
  cur.boxes = [];
  for (const p of cur.song.pages) {
    const el = document.createElement("div");
    el.className = "page";
    el.style.aspectRatio = `${p.w} / ${p.h}`;
    el.dataset.n = p.n;
    const canvas = document.createElement("canvas");
    const ov = document.createElement("div");
    ov.className = "ov";
    el.append(canvas, ov);
    if (cur.svg) el.prepend(cur.svg);                    // MusicXML 곡: 직접 그린 악보 한 장
    if (cur.origImg) { const img = new Image(); img.className = "orig"; img.alt = ""; img.src = cur.origImg; el.prepend(img); }      // 사진으로 올린 스캔 곡
    root.append(el);
    cur.pages.set(p.n, { el, canvas, ov, w: p.w, h: p.h, state: cur.svg || cur.origImg ? "svg" : "empty" });
  }
  cur.song.measures.forEach((m, mi) => {
    const pg = cur.pages.get(m.page);
    const b = document.createElement("button");
    b.className = "mbox";
    const [x0, y0, x1, y1] = m.box;
    const top = y0 - 16, bot = y1 + 12;
    b.style.left = (x0 / pg.w * 100) + "%";
    b.style.width = ((x1 - x0) / pg.w * 100) + "%";
    b.style.top = (top / pg.h * 100) + "%";
    b.style.height = ((bot - top) / pg.h * 100) + "%";
    b.setAttribute("aria-label", `마디 ${m.n}`);
    b.onclick = () => tapMeasure(mi);
    pg.ov.append(b);
    cur.boxes.push(b);
  });
  refreshBoxes();
  cur.anchors = buildAnchors(cur.rec.song);              // 세로줄 길은 엔진이 읽은 원래 위치로 만든다
  cur.head = document.createElement("div");
  cur.head.className = "playhead";
  cur.head.hidden = true;
}

// 재생 위치 세로줄이 지나갈 길: 마디마다 [박, 가로 위치] 목록.
// 저장해 둔 음표 위치(노래·피아노 모두)를 박 순서로 잇고, 마디 처음과 끝(마디선)을 더한다.
// 음표와 음표 사이, 쉼표 구간은 그 사이를 박에 비례해 나눠서 부드럽게 지나간다.
function buildAnchors(song) {
  const byM = song.measures.map(() => new Map());
  for (const p of song.parts) for (const n of p.notes) {
    const mp = byM[n.m], b = Math.round(n.beat * 1000) / 1000;
    if (!mp.has(b) || n.x < mp.get(b)) mp.set(b, n.x);
  }
  return song.measures.map((m, mi) => {
    const [x0, , x1] = m.box;
    const pts = [...byM[mi].entries()].sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const [b, x] of pts) {                       // 가로 위치가 뒤로 가는 점(잘못 읽힌 박)은 버린다
      if (b >= m.len - 1e-6 || x >= x1 - 1) continue;
      if (out.length && (x <= out[out.length - 1][1] + 0.5 || b <= out[out.length - 1][0])) continue;
      out.push([b, x]);
    }
    if (!out.length || out[0][0] > 1e-6) out.unshift([0, Math.min(x0 + 3, out.length ? out[0][1] - 1 : x0 + 3)]);
    out.push([m.len, x1]);
    return out;
  });
}

function headX(pts, beat) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [b0, xa] = pts[i], [b1, xb] = pts[i + 1];
    if (beat <= b1) return xa + (xb - xa) * Math.max(0, Math.min(1, (beat - b0) / Math.max(1e-6, b1 - b0)));
  }
  return pts[pts.length - 1][1];
}

// 재생 위치 표시 방식: 세로줄 / 마디만 옅게 강조 / 끄기 (기기에 기억)
const CURSORS = [["line", "세로줄"], ["measure", "마디만 옅게 강조"], ["off", "끄기"]];
let cursorMode = ls.get("cursor") || "line";
if (!CURSORS.some(([v]) => v === cursorMode)) cursorMode = "line";
function applyCursor() { $("score").dataset.cursor = cursorMode; }

function observePages() {
  const c = cur;
  c.io = new IntersectionObserver((ents) => {
    for (const en of ents) {
      const pg = c.pages.get(+en.target.dataset.n);
      pg.near = en.isIntersecting;
      if (en.isIntersecting) renderPage(c, pg, +en.target.dataset.n);
      else if (pg.state === "done" || pg.state === "stale") { pg.canvas.width = pg.canvas.height = 0; pg.state = "empty"; }   // 멀어진 쪽은 메모리에서 내린다
    }
  }, { root: $("score"), rootMargin: "900px 0px" });
  for (const pg of c.pages.values()) c.io.observe(pg.el);
}

async function renderPage(c, pg, n) {
  if ((pg.state !== "empty" && pg.state !== "stale") || !c.doc) return;
  pg.state = "busy";
  try {
    const page = await c.doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let scale = pg.el.clientWidth * dpr / base.width;
    scale = Math.min(scale, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
    const vp = page.getViewport({ scale });
    pg.canvas.width = Math.round(vp.width);
    pg.canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: pg.canvas.getContext("2d"), viewport: vp }).promise;
    pg.state = "done";
    pg.scaleFor = pg.el.clientWidth;
    if (!pg.near) { pg.canvas.width = pg.canvas.height = 0; pg.state = "empty"; }      // 그리는 사이에 지나가 버린 쪽
  } catch (err) { pg.state = "empty"; }
}

let rz = 0;
window.addEventListener("resize", () => {
  clearTimeout(rz);
  rz = setTimeout(() => {
    if (!cur) return;
    for (const [n, pg] of cur.pages) if (pg.state === "done" && Math.abs(pg.scaleFor - pg.el.clientWidth) > 40) { pg.state = "empty"; renderPage(cur, pg, n); }
  }, 250);
});

function scrollToMeasure(k, smooth = true) {
  const box = cur.boxes[cur.song.order[k]];
  if (!box) return;
  const sc = $("score");
  const r = box.getBoundingClientRect(), s = sc.getBoundingClientRect();
  const fitsY = r.top >= s.top + 8 && r.bottom <= s.bottom - 8;
  const fitsX = r.left >= s.left - 2 && r.right <= s.right + 2;
  if (fitsY && fitsX && smooth) return;
  const to = { behavior: smooth ? "smooth" : "auto" };
  if (!fitsY || !smooth) to.top = sc.scrollTop + r.top - s.top - s.height * 0.16;
  if (!fitsX || !smooth) to.left = Math.max(0, sc.scrollLeft + r.left - s.left - Math.max(12, (s.width - r.width) / 2));
  sc.scrollTo(to);
}

// 악보 크게 보기: 100% → 150% → 200% (폰에서는 악보가 작아서)
const ZOOMS = [1, 1.5, 2];
let zoom = +(ls.get("zoom") || 1);
function applyZoom(rerender) {
  $("score").style.setProperty("--zoom", zoom);
  $("zoomBtn").textContent = Math.round(zoom * 100) + "%";
  if (!rerender || !cur) return;
  for (const pg of cur.pages.values()) if (pg.state === "done") pg.state = "stale";
  if (cur.io) { cur.io.disconnect(); observePages(); }
  cur.lastSys = "";
  drawNames();                                            // 이름표가 서로 겹치는지는 화면 크기에 따라 달라진다
  scrollToMeasure(cur.player.kAt(cur.player.now()), false);
}
$("zoomBtn").onclick = () => { zoom = ZOOMS[(ZOOMS.indexOf(zoom) + 1) % ZOOMS.length]; ls.set("zoom", zoom); applyZoom(true); };

// ---- 매 화면마다: 지금 위치 표시
function loop() {
  if (!cur) return;
  showPos();
  cur.raf = requestAnimationFrame(loop);
}

function showPos() {
  const c = cur, pl = c.player;
  const beat = pl.now();
  const k = pl.kAt(beat);
  if (k !== c.lastK) {
    if (c.lastK >= 0) c.boxes[c.song.order[c.lastK]].classList.remove("cur");
    const mi = c.song.order[k], m = c.song.measures[mi];
    c.boxes[mi].classList.add("cur");
    c.lastK = k;
    const pass = c.song.order.slice(0, k + 1).filter((x) => x === mi).length;
    $("pWhere").textContent = `마디 ${m.n} / ${c.song.measures.length}${pass > 1 ? ` (${pass}번째)` : ""}`;
    const tv = $("tempoVal");                          // 숫자를 직접 입력하는 중에는 단추가 잠시 없다
    if (tv) tv.textContent = tempoText(m, Math.round(pl.bpmHere()));
    $("meterNow").textContent = meterText(m);
    const sys = m.page + ":" + m.system;
    if (sys !== c.lastSys || zoom > 1) { c.lastSys = sys; if (pl.playing) scrollToMeasure(k); }
    if (pl.playing) save();
  }
  // 세로줄: 지금 박의 가로 위치로 옮긴다 (줄이 바뀌면 다음 줄, 쪽이 바뀌면 다음 쪽으로)
  const h = c.head;
  if (cursorMode !== "line") { h.hidden = true; return; }
  const mi = c.song.order[k], m = c.song.measures[mi], pg = c.pages.get(m.page);
  if (h.parentNode !== pg.ov) pg.ov.append(h);
  const top = m.box[1] - 16, bottom = m.box[3] + 12;
  h.style.left = (headX(c.anchors[mi], beat - pl.starts[k]) / pg.w * 100) + "%";
  if (h.dataset.sys !== m.page + ":" + m.system) {
    h.dataset.sys = m.page + ":" + m.system;
    h.style.top = (top / pg.h * 100) + "%";
    h.style.height = ((bottom - top) / pg.h * 100) + "%";
  }
  h.hidden = false;
}

function tapMeasure(mi) {
  const c = cur, pl = c.player;
  if (c.ed.on) { selectMeasure(mi); return; }           // 편집 모드: 재생 위치를 옮기지 않고 그 마디를 고른다
  const kNow = pl.kAt(pl.now());
  const ks = [];
  c.song.order.forEach((x, k) => { if (x === mi) ks.push(k); });
  if (!ks.length) return;
  const k = ks.reduce((a, b) => (Math.abs(b - kNow) < Math.abs(a - kNow) ? b : a));
  if (c.pick) {                                   // 구간 반복: 시작 마디 → 끝 마디
    if (c.pick.a === null) { c.pick.a = k; refreshLoop(); return; }
    const loopR = [Math.min(c.pick.a, k), Math.max(c.pick.a, k)];
    c.pick = null;
    pl.setLoop(loopR);
    if (!pl.playing) pl.pos = pl.starts[loopR[0]];
    refreshLoop(); showPos(); save();
    return;
  }
  pl.seekMeasure(k);
  showPos();
  save();
}

// ---- 단추들
let wake = null;
async function togglePlay() {
  const pl = cur.player;
  if (pl.playing) { pl.pause(); if (wake) { wake.release().catch(() => {}); wake = null; } }
  else {
    sound.ensure();
    const ns = cur.song.parts.flatMap((p) => p.notes.map((n) => n.midi + cur.cfg.transpose));
    sound.load(Math.min(36, ...ns), Math.max(72, ...ns));          // 받는 동안에도 임시 소리로 바로 재생된다
    await pl.play();
    try { wake = await navigator.wakeLock.request("screen"); } catch (e) { /* 화면 켜 두기를 지원하지 않는 기기 */ }
  }
  refreshPlay(); save();
}

function refreshPlay() {
  const on = cur && cur.player.playing;
  $("play").textContent = on ? "⏸" : "▶";
  $("play").classList.toggle("on", !!on);
  $("play").setAttribute("aria-label", on ? "멈춤" : "재생");
}

function refreshLoop() {
  const c = cur, b = $("loopBtn");
  c.boxes.forEach((el) => el.classList.remove("inloop", "pick"));
  if (c.pick) {
    b.classList.add("on");
    b.textContent = c.pick.a === null ? "시작 마디를 누르세요" : "끝 마디를 누르세요";
    if (c.pick.a !== null) c.boxes[c.song.order[c.pick.a]].classList.add("pick");
  } else if (c.cfg.loop) {
    const [a, z] = c.cfg.loop;
    for (let k = a; k <= z; k++) c.boxes[c.song.order[k]].classList.add("inloop");
    b.classList.add("on");
    b.textContent = `반복 ${c.song.measures[c.song.order[a]].n}–${c.song.measures[c.song.order[z]].n} ✕`;
  } else { b.classList.remove("on"); b.textContent = "구간 반복"; }
}

// 지금 마디의 박자표 글자. 엔진이 박자표를 읽지 못해 4/4로 친 마디는 "(추정)", 분모가 5인 박자처럼 알 수 없는 것은 "읽지 못한 박자"
function meterText(m) {
  if (meterKind(m.meter) === "unknown") return "읽지 못한 박자";
  return `${m.meter[0]}/${m.meter[1]}` + (m.meter_guess ? " (추정)" : "");
}
// 빠르기 글자. 조절은 언제나 ♩= 기준이고, 겹박자(6/8·9/8·12/8) 마디에서는 점4분 기준을 같이 보여 준다: ♩.=40 (♩=60)
function tempoText(m, bpm) {
  const t = meterKind(m.meter) === "compound" ? `♩.=${Math.round(bpm * 2 / 3)} (♩=${bpm})` : "♩=" + bpm;
  // 악보에서 빠르기를 읽지 못해 ♩=72 로 친 곡: 손대기 전에는 "추정"이라고 붙인다
  return cur && cur.song && cur.song.tempo_found === false && cur.cfg && cur.cfg.ratio === 1 ? t + " (추정)" : t;
}
const measureNow = (c) => c.player.measureAt(c.player.now());

function refreshAll() {
  const c = cur;
  if (!c) return;
  refreshPlay(); refreshLoop();
  if ($("tempoVal")) $("tempoVal").textContent = tempoText(measureNow(c), Math.round(c.player.bpmHere()));
  $("meterNow").textContent = meterText(measureNow(c));
  const t = c.cfg.transpose;
  $("keyVal").textContent = t === 0 ? "원키" : (t > 0 ? "+" : "−") + Math.abs(t);
  $("countBtn").classList.toggle("on", c.cfg.countIn);
  $("metroBtn").classList.toggle("on", c.cfg.metro);
}

$("back").onclick = showLibrary;
$("play").onclick = togglePlay;
$("toStart").onclick = () => { const pl = cur.player; const L = pl.loopRange(); pl.restartFrom(L ? L[0] : 0); cur.lastSys = ""; scrollToMeasure(pl.kAt(pl.pos)); save(); };
$("loopBtn").onclick = () => {
  const c = cur;
  if (c.pick) c.pick = null;
  else if (c.cfg.loop) c.player.setLoop(null);
  else c.pick = { a: null };
  refreshLoop(); save();
};
$("countBtn").onclick = () => { cur.cfg.countIn = !cur.cfg.countIn; refreshAll(); save(); };
$("metroBtn").onclick = () => { cur.cfg.metro = !cur.cfg.metro; cur.player.applyMix(); refreshAll(); save(); };
$("pWhere").onclick = () => {
  const v = prompt("몇 마디로 갈까요? (마디 번호)");
  const n = parseInt(v, 10);
  if (!n) return;
  const mi = cur.song.measures.findIndex((m) => m.n === n);
  if (mi < 0) return alert(`마디 ${n}은 없어요. (1 ~ ${cur.song.measures.length})`);
  tapMeasure(mi);
  cur.lastSys = ""; scrollToMeasure(cur.player.kAt(cur.player.pos));
};

// 꾹 누르면 연속으로 바뀌는 − / + 단추
function holdable(root, fn) {
  for (const b of root.querySelectorAll("button[data-d]")) {
    let t1 = 0, t2 = 0;
    const stop = () => { clearTimeout(t1); clearInterval(t2); };
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const d = +b.dataset.d;
      fn(d);
      t1 = setTimeout(() => { t2 = setInterval(() => fn(d), 70); }, 420);
    });
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, stop);
    b.addEventListener("contextmenu", (e) => e.preventDefault());
  }
}
let bpmApply = 0;
function setBpm(v) {
  const c = cur;
  v = Math.max(20, Math.min(300, Math.round(v)));
  c.shownBpm = v;
  if ($("tempoVal")) $("tempoVal").textContent = tempoText(measureNow(c), v);
  clearTimeout(bpmApply);                          // 꾹 누르는 동안은 숫자만 바꾸고, 손을 떼면 소리에 반영
  bpmApply = setTimeout(() => { if (cur !== c) return; c.player.setBpm(v); c.shownBpm = null; save(); }, 160);
}
holdable($("tempo"), (d) => setBpm((cur.shownBpm || Math.round(cur.player.bpmHere())) + d));
holdable($("key"), (d) => { cur.player.setTranspose(cur.cfg.transpose + d); refreshAll(); save(); });

$("tempoVal").onclick = () => {                    // 숫자를 눌러 직접 입력
  const btn = $("tempoVal");
  const inp = document.createElement("input");
  inp.type = "number"; inp.inputMode = "numeric"; inp.min = 20; inp.max = 300;
  inp.value = Math.round(cur.player.bpmHere());
  btn.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = (apply) => {
    if (done) return; done = true;
    inp.replaceWith(btn);
    const v = parseInt(inp.value, 10);
    if (apply && v) setBpm(v); else refreshAll();
  };
  inp.onblur = () => finish(true);
  inp.onkeydown = (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
};

// ---- 파트·반주 (켜기·끄기·혼자 듣기·볼륨)
function buildMixer() {
  const c = cur, root = $("mixRows");
  root.textContent = "";
  const rows = [...c.player.parts.map((p) => ({ id: p.id, name: p.name, sub: "노래 줄" })),
    ...(c.player.hasPiano ? [{ id: "piano", name: "피아노 반주", sub: "악보에 적힌 그대로" }] : []),
    { id: "chord", name: "코드 반주", sub: "코드 기호로 만든 반주" }, { id: "metro", name: "메트로놈", sub: "" }];
  for (const r of rows) {
    const t = c.cfg.tracks[r.id];
    const row = document.createElement("div");
    row.className = "mix";
    const name = document.createElement("div");
    name.className = "name"; name.textContent = r.name;
    if (r.sub) { const s = document.createElement("small"); s.textContent = r.sub; name.append(s); }
    const btns = document.createElement("div");
    btns.className = "btns";
    const mk = (label, key) => {
      const b = document.createElement("button");
      b.className = "toggle" + (t[key] ? " on" : ""); b.textContent = label;
      b.onclick = () => { t[key] = !t[key]; b.classList.toggle("on", t[key]); c.player.applyMix(); save(); };
      return b;
    };
    if (r.id === "metro") {
      const b = document.createElement("button");
      b.className = "toggle" + (c.cfg.metro ? " on" : ""); b.textContent = "켜기";
      b.onclick = () => { c.cfg.metro = !c.cfg.metro; b.classList.toggle("on", c.cfg.metro); c.player.applyMix(); refreshAll(); save(); };
      btns.append(b);
      // 세분박 듣기: 정하지 않았으면(자동) 겹박자 마디에서만 8분음표를 친다. 한 번 누르면 그 뒤로는 고른 대로(곡마다 저장) — 박자가 바뀌어도 그대로 둔다
      const kindNow = meterKind(measureNow(c).meter), auto = c.cfg.sub === undefined || c.cfg.sub === null;
      const subOn = auto ? kindNow === "compound" : c.cfg.sub;
      const sb = document.createElement("button");
      sb.className = "toggle" + (subOn ? " on" : ""); sb.id = "subBtn";
      sb.textContent = "세분박" + (auto ? " (자동)" : "");
      sb.onclick = () => { c.player.setSub(!subOn); save(); buildMixer(); };
      btns.append(sb);
      const kinds = new Set(c.song.measures.map((m) => meterKind(m.meter) === "odd" ? `${m.meter[0]}/${m.meter[1]}` : ""));
      for (const key of Object.keys(GROUPS)) {
        if (!kinds.has(key)) continue;
        const sel = document.createElement("select");
        sel.setAttribute("aria-label", key + " 묶음");
        const chosen = c.cfg.groups && c.cfg.groups[key];
        for (const g of GROUPS[key]) { const o = document.createElement("option"); o.value = g; o.textContent = `${key} ${g}` + (!chosen && g === GROUPS[key][0] ? " (추정)" : ""); sel.append(o); }
        sel.value = chosen || GROUPS[key][0];
        sel.onchange = () => { c.player.setGroup(key, sel.value); save(); buildMixer(); };
        btns.append(sel);
      }
      r.note = (kindNow === "odd" ? "5/8·7/8 마디는 세분박 단추와 상관없이 8분음표마다 쳐요. " : "")
        + (auto ? "세분박 (자동): 6/8·12/8 같은 겹박자 마디에서만 8분음표를 쳐요." : `세분박을 ${c.cfg.sub ? "켰어요: 모든 마디에서 박 사이도 쳐요" : "껐어요: 큰 박만 쳐요"}.`);
    } else {
      if (r.id === "chord") {
        const sel = document.createElement("select");
        sel.setAttribute("aria-label", "반주 방식");
        for (const [v, l] of [["long", "길게 누르기"], ["beat", "박마다 치기"]]) { const o = document.createElement("option"); o.value = v; o.textContent = l; sel.append(o); }
        sel.value = c.cfg.style;
        sel.onchange = () => { c.player.setStyle(sel.value); save(); };
        btns.append(sel);
        // 해석하지 못한 코드 이름(읽다가 깨진 글자 등): 그럴듯한 화음으로 바꿔 치지 않고 그 자리는 비운다 → 어떤 이름인지 알려 준다
        const bad = [...new Set(c.song.measures.flatMap((m) => m.chords.map((x) => x.name)).filter((n) => n && !/^N\.?C\.?$/i.test(n) && !parseChord(n)))];
        if (bad.length) r.note = `해석 못 한 코드: ${bad.slice(0, 8).join(", ")}${bad.length > 8 ? " 등" : ""} — 이 코드 자리는 반주가 나지 않아요.`;
      }
      btns.append(mk("끄기", "mute"), mk("혼자", "solo"));
    }
    const vol = document.createElement("input");
    vol.type = "range"; vol.min = 0; vol.max = 100; vol.value = Math.round(t.vol * 100);
    vol.setAttribute("aria-label", r.name + " 볼륨");
    vol.oninput = () => { t.vol = vol.value / 100; c.player.applyMix(); save(); };
    row.append(name, btns);
    if (r.note) { const d = document.createElement("small"); d.className = "mixnote"; d.textContent = r.note; row.append(d); }
    // 이 노래 줄에 음이 겹치는 곳(화음·두 성부)이 있으면 위·아래를 골라 들을 수 있다
    const pi = c.player.parts.findIndex((p) => p.id === r.id);
    const has = pi >= 0 ? c.player.lines[pi] : null;
    const want = (t && t.line) || "all";
    if (has && ((has.top && has.bottom) || want !== "all")) {
      const seg = document.createElement("div");
      seg.className = "seg";
      seg.setAttribute("role", "group");
      seg.setAttribute("aria-label", r.name + "에서 들을 성부");
      const names = { all: "전체", top: "위만", mid: "가운데만", bottom: "아래만" };
      for (const v of ["all", "top", ...(has.mid || want === "mid" ? ["mid"] : []), "bottom"]) {
        const b = document.createElement("button");
        b.className = "toggle" + (v === want ? " on" : ""); b.textContent = names[v]; b.dataset.v = v;
        b.onclick = () => { c.player.setLine(r.id, v); save(); buildMixer(); };
        seg.append(b);
      }
      row.append(seg);
      const note = (text, warn) => { const d = document.createElement("small"); d.className = "mixnote" + (warn ? " warn" : ""); d.textContent = text; row.append(d); };
      // 고른 성부가 이 줄에 없다: 전체로 돌아가지 않는다 (다른 성부의 음이 섞이지 않게) → 같이 부르는 음만 나고, 그렇다고 알려 준다
      if (c.player.missing(r.id)) note(`이 줄에는 그 성부(${names[want].replace("만", "")})가 없어요. 같이 부르는 음만 들려요.`, true);
      // 성부를 악보에서 알아내지 못해 어림한 마디 (쉼표 정보가 없는 곡, 성부가 하나씩 쌓이는 마디 등)
      const gm = c.player.guessMeasures(r.id).map((mi) => c.song.measures[mi].n);
      if (gm.length) note(`성부를 어림한 마디: ${gm.slice(0, 12).join(", ")}${gm.length > 12 ? ` 등 ${gm.length}마디` : ""} — 이 마디들은 위·아래가 틀릴 수 있어요.`);
    }
    row.append(vol);
    root.append(row);
  }
  // 재생 위치 표시 방식
  const row = document.createElement("div");
  row.className = "mix";
  const name = document.createElement("div");
  name.className = "name"; name.textContent = "재생 위치 표시";
  const sel = document.createElement("select");
  sel.id = "cursorSel";
  sel.setAttribute("aria-label", "재생 위치 표시 방식");
  for (const [v, l] of CURSORS) { const o = document.createElement("option"); o.value = v; o.textContent = l; sel.append(o); }
  sel.value = cursorMode;
  sel.onchange = () => { cursorMode = sel.value; ls.set("cursor", cursorMode); applyCursor(); showPos(); };
  const btns = document.createElement("div");
  btns.className = "btns";
  btns.append(sel);
  row.append(name, btns);
  root.append(row);
}
const sheet = (open) => { $("sheet").hidden = !open; $("sheetBack").hidden = !open; if (open) buildMixer(); };
$("mixBtn").onclick = () => sheet(true);
$("sheetClose").onclick = $("sheetBack").onclick = () => sheet(false);

// ------------------------------------------------------------------ 편집 모드: 악보 위 음표를 눌러 고친다
// 엔진이 읽은 결과(rec.song)는 바꾸지 않는다. 고친 내용(rec.edits)을 덧씌운 것이 cur.song 이다.
function refreshBoxes() {
  const c = cur;
  c.check = checkState(c.song);                           // 마디마다의 확인 상태 (고친 내용·확인 완료가 반영된 것)
  c.song.measures.forEach((m, mi) => {
    const b = c.boxes[mi], st = c.check.measures[mi];
    b.classList.toggle("flag", st.state === "unsure");
    b.classList.toggle("usr", st.state === "user");
    b.classList.toggle("unsup", st.unsupported.length > 0);
    b.classList.toggle("pflag", m.piano_ok === false);
    b.classList.toggle("edited", !!m.edited);
    b.classList.toggle("stale", !!m.stale);
  });
}

function setEditing(on) {
  const c = cur, ed = c.ed;
  if (on === ed.on && !on) { $("practice").classList.remove("editing"); $("editBar").hidden = true; $("editBtn").classList.remove("on"); return; }
  ed.on = on;
  $("practice").classList.toggle("editing", on);
  $("editBar").hidden = !on;
  $("editBtn").classList.toggle("on", on);
  $("editBtn").textContent = on ? "고치기 끝" : "고치기";
  if (on) {
    c.player.pause(); refreshPlay();
    c.pick = null; refreshLoop();
    ed.zoomWas = zoom;
    if (zoom < 2) { zoom = 2; applyZoom(true); }        // 손가락으로 음표를 누를 수 있게 크게
    selectMeasure(c.song.order[c.player.kAt(c.player.pos)]);
  } else {
    clearMarks();
    c.boxes.forEach((b) => b.classList.remove("sel"));
    ed.mi = -1; ed.idx = -1;
    if (zoom !== ed.zoomWas) { zoom = ed.zoomWas; applyZoom(true); }
  }
}
$("editBtn").onclick = () => setEditing(!cur.ed.on);

const vocalParts = () => cur.song.parts.filter((p) => p.role === "vocal");
const kOf = (mi) => { const kNow = cur.player.kAt(cur.player.pos); let best = -1; cur.song.order.forEach((x, k) => { if (x === mi && (best < 0 || Math.abs(k - kNow) < Math.abs(best - kNow))) best = k; }); return best; };

function clearMarks() { for (const el of cur.ed.marks) el.remove(); cur.ed.marks = []; }

// 새로 넣은 음표는 원본 악보에 자리가 없다 → 박 위치로 가로 자리를, 주변 음과의 음높이 차이로 세로 자리를 어림한다
function placeAdded(partId, mi, notes) {
  const c = cur, m = c.song.measures[mi];
  const refs = (c.rec.song.parts.find((p) => p.id === partId) || { notes: [] }).notes.filter((x) => x.page === m.page && Math.abs(x.y - m.box[1]) < 200);
  const steps = [];
  for (let i = 0; i + 1 < refs.length; i++) if (refs[i].midi !== refs[i + 1].midi) steps.push(Math.abs(refs[i].y - refs[i + 1].y) / Math.abs(refs[i].midi - refs[i + 1].midi));
  steps.sort((a, b) => a - b);
  const per = steps.length ? steps[steps.length >> 1] : 1.1;
  for (const x of notes) {
    if (x.x !== undefined && !x.added) continue;
    const near = refs.slice().sort((a, b) => Math.abs(a.m - mi) - Math.abs(b.m - mi) || Math.abs(a.beat - x.beat) - Math.abs(b.beat - x.beat))[0];
    x.page = m.page;
    x.x = headX(c.anchors[mi], x.beat);
    x.y = near ? near.y - (x.midi - near.midi) * per : m.box[1] + 8;
  }
}

function selectMeasure(mi, keep = false) {
  const c = cur, ed = c.ed;
  if (ed.mi >= 0 && c.boxes[ed.mi]) c.boxes[ed.mi].classList.remove("sel");
  if (!keep || ed.mi !== mi) { ed.idx = -1; if (!keep) ed.part = null; }
  ed.mi = mi;
  c.boxes[mi].classList.add("sel");
  if (!ed.part || !vocalParts().some((p) => p.id === ed.part)) {
    const withNotes = vocalParts().find((p) => p.notes.some((x) => x.m === mi));
    ed.part = (withNotes || vocalParts()[0] || {}).id || null;
  }
  drawMarks();
  renderPanel();
  const box = c.boxes[mi], sc = $("score"), r = box.getBoundingClientRect(), s = sc.getBoundingClientRect();
  if (r.top < s.top || r.bottom > s.bottom || r.left < s.left || r.right > s.right) {
    sc.scrollTo({ top: sc.scrollTop + r.top - s.top - 40, left: Math.max(0, sc.scrollLeft + r.left - s.left - 12), behavior: "smooth" });
  }
}

function drawMarks() {
  const c = cur, ed = c.ed;
  clearMarks();
  if (ed.mi < 0) return;
  const m = c.song.measures[ed.mi], pg = c.pages.get(m.page);
  vocalParts().forEach((p, pi) => {
    const notes = E.measureNotes(c.song, p.id, ed.mi);
    const orig = E.canon(E.measureNotes(c.rec.song, p.id, ed.mi)).map((t) => t.join("|"));
    notes.forEach((x, i) => {
      const b = document.createElement("button");
      const changed = x.edited && !orig.includes(E.canon([x])[0].join("|"));
      b.className = "nmark p" + (pi % 4) + (x.added ? " added" : changed ? " changed" : "") + (p.id === ed.part && i === ed.idx ? " sel" : "");
      b.style.left = (x.x / pg.w * 100) + "%";
      b.style.top = (x.y / pg.h * 100) + "%";
      b.setAttribute("aria-label", `${p.name} ${E.noteName(x.midi)}`);
      b.onclick = (ev) => { ev.stopPropagation(); ed.part = p.id; ed.idx = i; drawMarks(); renderPanel(); };
      pg.ov.append(b);
      ed.marks.push(b);
    });
  });
}

// ---- 읽은 음 보기 (P3-3): 앱이 읽은 음이름을 악보의 음표 위에 겹쳐 보여 준다 → 박자 합은 맞는데 음이 틀린 곳을 눈으로 찾는다.
// 보여 주는 것은 지금 소리 나는 음(고친 내용이 반영된 것)이고, 키를 옮겨 듣고 있어도 악보에 적힌 높이 그대로다.
// 노래 줄만 보여 준다(피아노 줄까지 넣으면 악보가 가려진다). 노래 줄이 없는 곡은 모든 줄.
// 한 박에 여러 음이 있으면 가장 높은 음은 머리 위, 가장 낮은 음은 머리 아래, 사이의 음은 머리 옆에 둔다.
// 옆 이름표와 붙어서 겹칠 것 같으면 한 칸 더 띄운다(두 줄로 엇갈린다).
function drawNames() {
  const c = cur;
  for (const el of c.names.els) el.remove();
  c.names.els = [];
  $("namesBtn").classList.toggle("on", c.names.on);
  if (!c.names.on) return;
  const parts = vocalParts().length ? vocalParts() : c.song.parts;
  const wide = 10 * 2.3;                                  // 이름표의 대강의 너비(px). 글자 크기는 확대와 무관하게 10px 이다
  parts.forEach((p, pi) => {
    const last = {};                                      // 이 줄에서 바로 앞 이름표: 놓인 곳(위/아래)마다 { 쪽, 가로(px), 띄웠는지 }
    const groups = new Map();
    for (const x of p.notes) { const k = x.m + "|" + Math.round(x.beat * 1000); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
    for (const g of groups.values()) {
      g.sort((a, b) => b.midi - a.midi);
      g.forEach((x, i) => {
        const m = c.song.measures[x.m], pg = c.pages.get(m.page);
        if (!pg || typeof x.x !== "number" || typeof x.y !== "number") return;
        const where = i === 0 ? "above" : i === g.length - 1 ? "below" : "side";
        const s = document.createElement("span");
        s.className = `nname p${pi % 4} ${where}` + (x.edited ? " edited" : "");
        s.textContent = E.noteName(x.midi);
        s.style.left = (x.x / pg.w * 100) + "%";
        s.style.top = (x.y / pg.h * 100) + "%";
        if (where !== "side") {
          const px = x.x / pg.w * (pg.el.clientWidth || pg.w), y = Math.round(x.y), prev = last[where];
          const near = prev && prev.page === m.page && Math.abs(prev.y - y) < 40 && Math.abs(px - prev.px) < wide;
          const far = near && !prev.far;
          if (far) s.classList.add("far");
          last[where] = { page: m.page, px, y, far };
        }
        pg.ov.append(s);
        c.names.els.push(s);
      });
    }
  });
}
$("namesBtn").onclick = () => { if (!cur) return; cur.names.on = !cur.names.on; drawNames(); };

// 고친 결과를 기록하고(기기에 저장), 곡·재생기·화면을 새로 맞춘다
function commit(partId, mi, notes, selIdx) {
  const c = cur;
  placeAdded(partId, mi, notes);
  E.setMeasure(c.rec.edits, c.rec.song, partId, mi, notes, wantEngine(c.rec));
  E.syncVoices(c.rec.edits, c.rec.song, partId, mi, notes);      // 성부를 정해 둔 음을 고쳤으면 지정도 따라가게
  c.song = E.applyEdits(c.rec.song, c.rec.edits);
  c.player.load(c.song);
  c.ed.idx = selIdx;
  refreshBoxes();
  drawMarks();
  drawNames();
  renderPanel();
  pendingSave = store.putSong(c.rec).then(saveOk, saveFailed);
}

// 고른 음의 성부를 정한다 ("이 음: 위 / 아래 / 같이"). voice 가 null 이면 정한 것을 지운다(자동)
function setNoteVoice(voice) {
  const c = cur, ed = c.ed;
  const t = E.measureNotes(c.song, ed.part, ed.mi)[ed.idx];
  if (!t) return;
  E.setVoice(c.rec.edits, c.rec.song, ed.part, ed.mi, t, voice);
  c.song = E.applyEdits(c.rec.song, c.rec.edits);
  c.player.load(c.song);
  drawMarks();
  renderPanel();
  pendingSave = store.putSong(c.rec).then(saveOk, saveFailed);
}

function edit(fn) {
  const c = cur, ed = c.ed;
  const notes = E.measureNotes(c.song, ed.part, ed.mi).map((x) => ({ ...x }));
  if (ed.idx >= 0 && notes[ed.idx]) notes[ed.idx]._sel = true;
  const out = fn(notes, ed.idx);
  let sel = out.findIndex((x) => x._new);
  if (sel < 0) sel = out.findIndex((x) => x._sel);
  for (const x of out) { delete x._sel; delete x._new; }
  commit(ed.part, ed.mi, out, sel);
}

let autoShift = ls.get("autoShift") !== "0";

function flagged() { const out = []; cur.check.measures.forEach((s, mi) => { if (s.state === "unsure") out.push(mi); }); return out; }

function renderPanel() {
  const c = cur, ed = c.ed, root = $("editPanel");
  root.textContent = "";
  const fl = flagged();
  $("flagInfo").textContent = stateText(c.rec, c.check);
  $("prevFlag").disabled = $("nextFlag").disabled = !fl.length;
  if (ed.mi < 0) return;
  const m = c.song.measures[ed.mi];
  const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text !== undefined) x.textContent = text; return x; };
  const line = (...kids) => { const d = el("div", "line"); d.append(...kids); root.append(d); return d; };
  const btn = (text, fn, cls = "btn") => { const b = el("button", cls, text); b.onclick = fn; return b; };
  const notes = ed.part ? E.measureNotes(c.song, ed.part, ed.mi) : [];
  const t = notes[ed.idx];
  const part = c.song.parts.find((p) => p.id === ed.part);
  const head = el("span", "what", `마디 ${m.n}` + (part ? ` · ${part.name}` : "") + (t ? ` · ${E.noteName(t.midi)} · ${Math.round((t.beat + 1) * 100) / 100}박` : ""));
  if (t) {
    line(head, btn("◀ 음", () => { ed.idx = (ed.idx - 1 + notes.length) % notes.length; drawMarks(); renderPanel(); }), btn("음 ▶", () => { ed.idx = (ed.idx + 1) % notes.length; drawMarks(); renderPanel(); }));
    line(el("span", "lab", "음높이"), btn("▼", () => edit((ns, i) => E.changePitch(ns, i, -1))), btn("▲", () => edit((ns, i) => E.changePitch(ns, i, 1))),
      el("span", "lab", "시작 박"), btn("◀", () => edit((ns, i) => E.shiftOnset(ns, i, -0.25))), btn("▶", () => edit((ns, i) => E.shiftOnset(ns, i, 0.25))));
    const dp = E.durParts(t.dur);
    const dl = line(el("span", "lab", "길이"));
    for (const [base, name] of [[4, "온"], [2, "2분"], [1, "4분"], [0.5, "8분"], [0.25, "16분"]]) {
      dl.append(btn(name, () => edit((ns, i) => E.changeDur(ns, i, E.durFrom(base, dp.dot, dp.trip), autoShift)), "toggle" + (dp.base === base ? " on" : "")));
    }
    if (dp.base) {
      dl.append(btn("점", () => edit((ns, i) => E.changeDur(ns, i, E.durFrom(dp.base, !dp.dot, dp.trip), autoShift)), "toggle" + (dp.dot ? " on" : "")),
        btn("셋잇단", () => edit((ns, i) => E.changeDur(ns, i, E.durFrom(dp.base, dp.dot, !dp.trip), autoShift)), "toggle" + (dp.trip ? " on" : "")));
    }
    const ly = el("input");
    ly.type = "text"; ly.value = t.lyric || ""; ly.placeholder = "가사"; ly.setAttribute("aria-label", "가사");
    ly.onchange = () => edit((ns, i) => E.setField(ns, i, "lyric", ly.value.trim()));
    line(btn("붙임줄", () => edit((ns, i) => E.setField(ns, i, "tie", !ns[i].tie)), "toggle" + (t.tie ? " on" : "")), el("span", "lab", "가사"), ly);
    // 이 음의 성부: 위·아래로 나눠 들을 때 어느 쪽 음인지. 악보에서 알아낸 것이 틀렸거나 어림한 곳을 직접 정한다
    const pi = c.player.parts.findIndex((p) => p.id === ed.part), has = pi >= 0 ? c.player.lines[pi] : null;
    const mine = t.voiceBy === "user" ? t.voice : null;
    if (has && (has.top || has.mid || has.bottom || mine)) {
      const how = c.player.voiceOf(ed.part, ed.mi, t.beat, t.midi);
      const LINE = { one: "같이 부르는 음", top: "위", mid: "가운데", bottom: "아래" }, BY = { guess: " — 어림", unknown: " — 가리지 못함" };
      const vl = line(el("span", "lab", "이 음의 성부"));
      for (const [v, name] of [[null, "자동"], ["top", "위"], ...(has.mid || mine === "mid" ? [["mid", "가운데"]] : []), ["bottom", "아래"], ["both", "같이"]]) {
        vl.append(btn(name, () => setNoteVoice(v), "toggle" + (mine === v ? " on" : "")));
      }
      if (how) vl.append(el("span", "lab", mine ? "(직접 정함)" : `지금: ${LINE[how.line] || how.line}${BY[how.by] || ""}`));
    }
    line(btn("앞에 넣기", () => edit((ns, i) => E.insertNote(ns, i, "before", autoShift))), btn("뒤에 넣기", () => edit((ns, i) => E.insertNote(ns, i, "after", autoShift))),
      btn("화음 음 추가", () => edit((ns, i) => E.insertNote(ns, i, "chord", false))), btn("지우기", () => edit((ns, i) => E.deleteNote(ns, i, autoShift))));
  } else {
    line(head);
    const l = line(el("span", "lab", notes.length ? "음표를 누르세요" : "이 줄에 음표가 없어요"));
    for (const p of vocalParts()) {
      if (E.measureNotes(c.song, p.id, ed.mi).length) continue;
      const prev = p.notes.filter((x) => x.m < ed.mi).pop();
      l.append(btn(`${p.name}에 음표 넣기`, () => { ed.part = p.id; ed.idx = -1; edit((ns) => E.insertNote(ns, -1, "empty", false, prev ? prev.midi : 60)); }));
    }
  }
  // 이 마디가 어떻게 확인된 것인지: 확인 필요(까닭) / 직접 확인함 / 자동 검사만 — 그리고 소리 내지 않는 표기는 따로
  const ms = c.check.measures[ed.mi];
  root.append(el("div", "state " + ms.state, ms.state === "unsure" ? "확인 필요: " + ms.why.map((w) => WHY[w] || w).join(" · ")
    : ms.state === "user" ? `직접 확인한 마디예요${typeof c.rec.edits.checked[m.n] === "string" ? ` (${c.rec.edits.checked[m.n]})` : ""}.` : AUTO_NOTE(c.rec)));
  if (ms.unsupported.length) root.append(el("div", "state unsup", "소리 내지 않는 표기가 있어요: " + ms.unsupported.map((u) => UNSUP[u] || u).join(", ")));
  const end = E.totalEnd(notes);
  if (notes.length && Math.abs(end - m.len) > 0.002) root.append(el("div", "warn", `이 줄의 음이 ${Math.round(end * 100) / 100}박에서 끝나요 (마디 길이 ${m.len}박).`));
  const chk = el("label", "chk"), cb = el("input");
  cb.type = "checkbox"; cb.checked = autoShift;
  cb.onchange = () => { autoShift = cb.checked; ls.set("autoShift", autoShift ? "1" : "0"); };
  chk.append(cb, "길이를 바꾸면 뒤 음도 같이 움직이기");
  const key = E.keyOf(ed.part, m.n), hasOv = !!c.rec.edits.ov[key], checked = !!c.rec.edits.checked[m.n];
  const tools = line(chk);
  if (hasOv) tools.append(btn("이 마디 되돌리기", () => { delete c.rec.edits.ov[key]; ed.idx = -1; commit(ed.part, ed.mi, E.measureNotes(c.rec.song, ed.part, ed.mi).map((x) => ({ ...x })), -1); }));
  // 자동 검사를 통과한 마디도 원본과 견줘 본 뒤 "확인 완료"로 표시할 수 있다 (자동 검사 통과와 직접 확인은 다른 것이다)
  tools.append(btn(checked ? "확인 완료 취소" : "확인 완료", () => {
    if (checked) delete c.rec.edits.checked[m.n]; else c.rec.edits.checked[m.n] = new Date().toISOString().slice(0, 10);
    for (const ov of Object.values(c.rec.edits.ov)) if (ov.n === m.n) delete ov.stale;
    commit(ed.part, ed.mi, E.measureNotes(c.song, ed.part, ed.mi).map((x) => ({ ...x })), ed.idx);
  }, "toggle" + (checked ? " on" : "")));
}

function jumpFlag(dir) {
  const fl = flagged();
  if (!fl.length) return;
  const cur_ = cur.ed.mi;
  const next = dir > 0 ? (fl.find((x) => x > cur_) ?? fl[0]) : ([...fl].reverse().find((x) => x < cur_) ?? fl[fl.length - 1]);
  selectMeasure(next);
}
$("nextFlag").onclick = () => jumpFlag(1);
$("prevFlag").onclick = () => jumpFlag(-1);
$("listenBtn").onclick = async () => {                  // 고친 직후 그 마디부터 바로 듣기
  const c = cur, pl = c.player;
  if (c.ed.mi < 0) return;
  if (pl.playing) pl.pause();
  pl.pos = pl.starts[Math.max(0, kOf(c.ed.mi))];
  const ci = c.cfg.countIn;
  c.cfg.countIn = false;
  await togglePlay();
  c.cfg.countIn = ci;
};

document.addEventListener("visibilitychange", () => { if (document.hidden && cur) save(true); });

// ---- 노래 채점 (web/sing/). 여기는 연결만 한다: 누를 때 그 화면의 파일을 불러온다
$("micTestBtn").onclick = async () => {
  try { (await import("./sing/tuner.js")).openTuner({ sound }); } catch (err) {
    console.error(err);
    libStatus("마이크 테스트 화면을 열지 못했어요" + (navigator.onLine ? ": " + err.message : ". 처음 한 번은 인터넷이 될 때 열어 주세요."), true);
  }
};
$("singBtn").onclick = async () => {
  if (!cur) return;
  cur.player.pause();
  refreshPlay();
  if ($("practice").classList.contains("sing-on")) return;
  if (cur.ed.on) setEditing(false);
  try {
    (await import("./sing/panel.js")).openPanel({ sound, player: cur.player, pages: cur.pages, boxes: cur.boxes, score: $("score"), practice: $("practice"),
      dock: document.querySelector("#practice .dock"), back: $("back"), scrollTo: (k) => requestAnimationFrame(() => { if (cur) scrollToMeasure(k, false); }), refresh: refreshAll, save });      // 조작판 글이 바뀌며 높이가 변하면 부드러운 스크롤이 끊겨서, 한 장면 뒤에 바로 옮긴다
  } catch (err) {
    console.error(err);
    pStatus("부르기 화면을 열지 못했어요" + (navigator.onLine ? ": " + err.message : ". 처음 한 번은 인터넷이 될 때 열어 주세요."), true);
  }
};

showLibrary();

if ($("bootFail")) $("bootFail").hidden = true;      // 늦게라도 시작됐으면 "시작하지 못했어요" 안내를 걷는다
window.__appReady = true;          // 자동 시험용: 이 파일이 끝까지 실행됐다는 표시 (문법 오류가 있으면 생기지 않는다)
