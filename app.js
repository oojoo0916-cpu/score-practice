// 화면: 악보 보관함 ↔ 연습 화면. 원본 악보(PDF)를 그대로 보여 주고 그 위에 지금 치는 마디와 음표를 표시한다.
import * as store from "./store.js";
import { Sound } from "./audio.js";
import { Player } from "./player.js";
import * as E from "./edits.js";
import * as MX from "./musicxml.js";
import * as XV from "./xmlview.js";

const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/";
const MAX_PIXELS = 3.2e6;               // 쪽 하나를 그릴 때 점 개수 상한 (폰 메모리 보호)
const $ = (id) => document.getElementById(id);
const sound = new Sound();
let worker = null, jobs = new Map(), jobId = 0;
let cur = null;                         // 열려 있는 곡: {rec, player, doc, pages, boxes, anchors, head, ...}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// ------------------------------------------------------------------ 보관함
const fmtDate = (t) => new Date(t).toLocaleDateString("ko-KR", { month: "long", day: "numeric" });

async function showLibrary() {
  closeSong();
  $("practice").hidden = true;
  $("library").hidden = false;
  const songs = (await store.listSongs()).sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));
  $("empty").hidden = songs.length > 0;
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
    const need = s.stats.need_check.length;
    // 어떤 방식으로 읽었는지, 걸린 시간, 확인 필요 마디 수
    const how = s.method ? `${s.method}${s.readSec ? ` ${s.readSec}초` : ""} · ` : "";
    const pn = s.stats.piano_need_check || 0;
    const ne = s.edits ? Object.keys(s.edits.ov).length : 0;
    sp.textContent = `${how}${s.stats.pages}쪽 ${s.stats.measures}마디 · 확인 필요 ${need}마디${pn ? ` · 반주 어림 ${pn}마디` : ""}${ne ? ` · 고친 곳 ${ne}` : ""}`;
    open.append(b, sp);
    open.onclick = () => openSong(s.id);
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "🗑"; del.setAttribute("aria-label", s.title + " 지우기");
    del.onclick = async () => { if (confirm(`"${s.title}" 악보를 보관함에서 지울까요?`)) { await store.deleteSong(s.id); showLibrary(); } };
    li.append(open, del);
    ul.append(li);
  }
}

function libStatus(text, err = false) {
  const el = $("libStatus");
  el.hidden = !text; el.textContent = text || ""; el.classList.toggle("err", err);
}

function analyze(bytes, title, onProgress) {
  if (!worker) {
    worker = new Worker("engine-worker.js");
    worker.onmessage = (e) => {
      const j = jobs.get(e.data.id);
      if (!j) return;
      if (e.data.progress) return j.onProgress(e.data.progress);
      jobs.delete(e.data.id);
      e.data.error ? j.no(new Error(e.data.error)) : j.ok(e.data.result);
    };
    worker.onerror = (e) => { for (const j of jobs.values()) j.no(new Error(e.message || "분석 엔진을 시작하지 못했어요")); jobs.clear(); worker = null; };
  }
  return new Promise((ok, no) => { const id = ++jobId; jobs.set(id, { ok, no, onProgress }); worker.postMessage({ id, bytes, title }); });
}

// 엔진이 좋아지면 이 숫자를 올린다 → 보관함의 곡을 열 때 저장해 둔 PDF로 자동으로 다시 읽는다 (설정은 그대로)
const ENGINE = 8;
const XMLV = 2;                          // MusicXML 옮기는 규칙이 바뀌면 올린다
const isXml = (rec) => rec.kind === "xml";
const wantEngine = (rec) => (isXml(rec) ? "xml" + XMLV : ENGINE);

async function rereadXml(rec) {
  try {
    const res = MX.parse(await MX.xmlText(await store.getPdf(rec.id)), rec.title, { check: rec.source === "scan" });
    const same = res.song.measures.length === rec.song.measures.length;
    if (rec.edits) rec.rereadNote = E.reconcile(res.song, rec.edits);
    Object.assign(rec, { song: res.song, stats: res.stats, engine: wantEngine(rec) });
    if (!same && rec.settings) { rec.settings.loop = null; rec.settings.k = 0; }
    await store.putSong(rec);
  } catch (err) {
    libStatus("파일을 다시 읽지 못해서 예전 결과로 엽니다: " + err.message, true);
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
      await store.putSong(rec);
    }
    libStatus("");
  } catch (err) {
    libStatus("새 엔진으로 다시 읽지 못해서 예전 결과로 엽니다: " + err.message, true);
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
    await store.addSong(rec, buf);
    libStatus(`"${title}" 읽기 완료 (${sec}초, ${res.stats.measures}마디${res.stats.need_check.length ? `, 확인 필요 ${res.stats.need_check.length}마디` : ""})`);
    await openSong(rec.id);
  } catch (err) {
    libStatus("악보를 읽지 못했어요: " + err.message + (navigator.onLine ? "" : " (분석 엔진을 처음 받을 때는 인터넷이 필요해요)"), true);
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
    await store.addSong(rec, buf);
    if (scan && scan.orig) await store.putOrig(rec.id, scan.orig).catch(() => {});
    const need = res.stats.need_check.length;
    libStatus(`"${title}" 읽기 완료 (${sec}초, ${res.stats.measures}마디${need ? `, 확인 필요 ${need}마디` : ""})`
      + (scan ? " — 스캔 악보는 틀린 곳이 있을 수 있어요. 원본 악보와 같이 보면서 \"고치기\"로 확인해 주세요." : ""));
    await openSong(rec.id);
  } catch (err) {
    libStatus((scan ? "스캔 인식 결과를 열지 못했어요: " : "MusicXML 파일을 읽지 못했어요: ") + err.message, true);
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

async function addScan(buf, name) {
  if (!(await scanAvailable())) {
    libStatus("이 악보는 스캔하거나 사진으로 찍은 것이에요 (안에 그림만 들어 있어요). 스캔·사진 악보는 집 컴퓨터가 읽어 줘야 해서, 집 컴퓨터를 켜고 같은 와이파이에서 \"폰에서 열기\" 주소로 앱을 열었을 때만 읽을 수 있어요.", true);
    return;
  }
  const t0 = performance.now();
  try {
    libStatus("스캔 악보예요. 집 컴퓨터로 보내는 중…");
    const r = await fetch("scan?name=" + encodeURIComponent(name), { method: "POST", body: buf });
    const j = await r.json();
    if (!j.job) throw new Error(j.error || "보내지 못했어요");
    for (;;) {
      await wait(2000);
      const s = await (await fetch("scan/status?job=" + encodeURIComponent(j.job), { cache: "no-store" })).json();
      if (s.state === "error") throw new Error(s.error || "읽지 못했어요");
      if (s.state === "done") {
        const sec = ((performance.now() - t0) / 1000).toFixed(0);
        const type = /\.pdf$/i.test(name) ? "application/pdf" : /\.png$/i.test(name) ? "image/png" : "image/jpeg";
        await addXml(new TextEncoder().encode(s.xml).buffer, name, { sec, engine: s.info && s.info.engine, orig: { name, type, buf } });
        return;
      }
      libStatus(`집 컴퓨터가 스캔 악보를 읽는 중… ${Math.round((performance.now() - t0) / 1000)}초${s.note && /\d+\/\d+쪽/.test(s.note) ? ` (${s.note.match(/\d+\/\d+쪽/)[0]})` : ""} — 한 쪽에 30초쯤 걸려요. 화면을 끄지 말고 기다려 주세요`);
    }
  } catch (err) {
    libStatus("스캔 악보를 읽지 못했어요: " + err.message, true);
  }
}

$("file").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
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
  pdfjsP = pdfjsP || import(PDFJS + "pdf.min.mjs").then((m) => { m.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs"; return m; });
  return pdfjsP;
}

function pStatus(text, err = false) {
  const el = $("pStatus");
  el.hidden = !text; el.textContent = text || ""; el.classList.toggle("err", err);
}

async function openSong(id) {
  let rec = await store.getSong(id);
  if (!rec) return showLibrary();
  if (rec.engine !== wantEngine(rec)) rec = await reread(rec);
  rec.edits = rec.edits || E.emptyEdits();
  let svg = null;
  if (isXml(rec)) {                                       // 원본 그림이 없으니 악보를 직접 그리고, 마디·음표 자리를 곡 자료에 채운다
    try {
      const kept = await store.getDraw(id).catch(() => null);
      if (kept && kept.v === XV.DRAWV && rec.song.drawCheck) svg = XV.fromHtml(kept.html);     // 전에 그려 둔 것
      if (!svg) {
        libStatus(`"${rec.title}" 악보를 그리고 있어요…`);
        svg = await XV.render(rec.song, await MX.xmlText(await store.getPdf(id)));
        await store.putDraw(id, { v: XV.DRAWV, html: svg.outerHTML }).catch(() => {});
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
  rec.openedAt = Date.now();
  const player = new Player(song, sound, cfg);
  player.pos = player.starts[Math.min(cfg.k || 0, player.starts.length - 1)] || 0;
  const c = cur = { rec, song, cfg, player, svg, pages: new Map(), boxes: [], anchors: [], head: null, lastK: -1, lastSys: "", pick: null, raf: 0,
    ed: { on: false, mi: -1, part: null, idx: -1, marks: [], zoomWas: 1 } };
  player.onEnd = () => refreshPlay();
  $("library").hidden = true;
  $("practice").hidden = false;
  $("pTitle").textContent = rec.title;
  $("origBtn").hidden = true;
  if (rec.source === "scan") {                            // 올린 원본을 새 창에서 볼 수 있게 (누르는 순간에는 이미 주소가 준비되어 있어야 창이 막히지 않는다)
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
  if (svg) {
    const dc = rec.song.drawCheck;
    // 스캔 곡은 '확인 필요' 표시가 따로 있으므로 이 안내는 띄우지 않는다
    if (dc && dc.matched < dc.notes && rec.source !== "scan") pStatus(`그려진 악보와 읽은 음이 서로 다른 곳이 ${dc.notes - dc.matched}군데 있어요. 소리가 악보와 다르게 들리면 그 마디를 "고치기"로 확인해 주세요.`);
    scrollToMeasure(player.kAt(player.pos), false);
    return;
  }
  try {
    const lib = await pdfjs();
    const data = await store.getPdf(id);
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
  save(true);
  $("score").textContent = "";
  cur = null;
}

let saveTimer = 0;
function save(now = false) {
  if (!cur) return;
  const c = cur;
  const run = () => { c.cfg.k = c.player.kAt(c.player.now()); c.rec.settings = JSON.parse(JSON.stringify(c.cfg)); store.putSong(c.rec).catch(() => {}); };
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
    root.append(el);
    cur.pages.set(p.n, { el, canvas, ov, w: p.w, h: p.h, state: cur.svg ? "svg" : "empty" });
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
let cursorMode = localStorage.getItem("cursor") || "line";
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
let zoom = +(localStorage.getItem("zoom") || 1);
function applyZoom(rerender) {
  $("score").style.setProperty("--zoom", zoom);
  $("zoomBtn").textContent = Math.round(zoom * 100) + "%";
  if (!rerender || !cur) return;
  for (const pg of cur.pages.values()) if (pg.state === "done") pg.state = "stale";
  if (cur.io) { cur.io.disconnect(); observePages(); }
  cur.lastSys = "";
  scrollToMeasure(cur.player.kAt(cur.player.now()), false);
}
$("zoomBtn").onclick = () => { zoom = ZOOMS[(ZOOMS.indexOf(zoom) + 1) % ZOOMS.length]; localStorage.setItem("zoom", zoom); applyZoom(true); };

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
    if (tv) tv.textContent = "♩=" + Math.round(pl.bpmHere());
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

function refreshAll() {
  const c = cur;
  if (!c) return;
  refreshPlay(); refreshLoop();
  if ($("tempoVal")) $("tempoVal").textContent = "♩=" + Math.round(c.player.bpmHere());
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
  if ($("tempoVal")) $("tempoVal").textContent = "♩=" + v;
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
    } else {
      if (r.id === "chord") {
        const sel = document.createElement("select");
        sel.setAttribute("aria-label", "반주 방식");
        for (const [v, l] of [["long", "길게 누르기"], ["beat", "박마다 치기"]]) { const o = document.createElement("option"); o.value = v; o.textContent = l; sel.append(o); }
        sel.value = c.cfg.style;
        sel.onchange = () => { c.player.setStyle(sel.value); save(); };
        btns.append(sel);
      }
      btns.append(mk("끄기", "mute"), mk("혼자", "solo"));
    }
    const vol = document.createElement("input");
    vol.type = "range"; vol.min = 0; vol.max = 100; vol.value = Math.round(t.vol * 100);
    vol.setAttribute("aria-label", r.name + " 볼륨");
    vol.oninput = () => { t.vol = vol.value / 100; c.player.applyMix(); save(); };
    row.append(name, btns, vol);
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
  sel.onchange = () => { cursorMode = sel.value; localStorage.setItem("cursor", cursorMode); applyCursor(); showPos(); };
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
  c.song.measures.forEach((m, mi) => {
    const b = c.boxes[mi];
    b.classList.toggle("flag", !m.ok);
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

// 고친 결과를 기록하고(기기에 저장), 곡·재생기·화면을 새로 맞춘다
function commit(partId, mi, notes, selIdx) {
  const c = cur;
  placeAdded(partId, mi, notes);
  E.setMeasure(c.rec.edits, c.rec.song, partId, mi, notes, wantEngine(c.rec));
  c.song = E.applyEdits(c.rec.song, c.rec.edits);
  c.player.load(c.song);
  c.ed.idx = selIdx;
  refreshBoxes();
  drawMarks();
  renderPanel();
  store.putSong(c.rec).catch(() => {});
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

let autoShift = localStorage.getItem("autoShift") !== "0";

function flagged() { const out = []; cur.song.measures.forEach((m, mi) => { if (!m.ok || m.stale) out.push(mi); }); return out; }

function renderPanel() {
  const c = cur, ed = c.ed, root = $("editPanel");
  root.textContent = "";
  const fl = flagged();
  $("flagInfo").textContent = fl.length ? `확인 필요 ${fl.length}마디` : "확인 필요 마디 없음";
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
  const end = E.totalEnd(notes);
  if (notes.length && Math.abs(end - m.len) > 0.002) root.append(el("div", "warn", `이 줄의 음이 ${Math.round(end * 100) / 100}박에서 끝나요 (마디 길이 ${m.len}박).`));
  const chk = el("label", "chk"), cb = el("input");
  cb.type = "checkbox"; cb.checked = autoShift;
  cb.onchange = () => { autoShift = cb.checked; localStorage.setItem("autoShift", autoShift ? "1" : "0"); };
  chk.append(cb, "길이를 바꾸면 뒤 음도 같이 움직이기");
  const key = E.keyOf(ed.part, m.n), hasOv = !!c.rec.edits.ov[key], checked = !!c.rec.edits.checked[m.n];
  const tools = line(chk);
  if (hasOv) tools.append(btn("이 마디 되돌리기", () => { delete c.rec.edits.ov[key]; ed.idx = -1; commit(ed.part, ed.mi, E.measureNotes(c.rec.song, ed.part, ed.mi).map((x) => ({ ...x })), -1); }));
  if (!c.rec.song.measures[ed.mi].ok || m.stale || checked) {
    tools.append(btn(checked ? "확인 완료 취소" : "확인 완료", () => {
      if (checked) delete c.rec.edits.checked[m.n]; else c.rec.edits.checked[m.n] = new Date().toISOString().slice(0, 10);
      for (const ov of Object.values(c.rec.edits.ov)) if (ov.n === m.n) delete ov.stale;
      commit(ed.part, ed.mi, E.measureNotes(c.song, ed.part, ed.mi).map((x) => ({ ...x })), ed.idx);
    }, "toggle" + (checked ? " on" : "")));
  }
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
showLibrary();

window.__appReady = true;          // 자동 시험용: 이 파일이 끝까지 실행됐다는 표시 (문법 오류가 있으면 생기지 않는다)
