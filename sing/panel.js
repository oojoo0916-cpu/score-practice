// 노래 채점: 연습 화면 아래 조작판 자리에 들어가는 칸. 악보는 그대로 보인다.
// 맨 위 [메아리 | 반주와 부르기] · ⚙ · ✕ → 구간(◀ 3–4마디 ▶, 가사 한 줄) → 큰 시작 단추와 짧은 안내 한 줄 → 결과(큰 숫자, 작은 단추들).
// 자주 바꾸지 않는 것(노래 줄·성부·반주·판정·보기·박자 보정)은 ⚙ 설정 창(settings-sheet.js) 한 곳에 모은다.
// 흐름은 echo-mode.js(메아리)·sing-mode.js(반주와 부르기), 재생은 take.js, 구간은 ranges.js, 채점은 scoring.js,
// 악보 위 표시는 overlay.js, 음표 그래프는 note-popup.js, 노래방식 화면은 karaoke.js.
import { PitchEngine, MicError } from "./pitch-engine.js";
import { targetsFrom, scoreAll, tolerance, latencyOf, speakerFilter } from "./scoring.js";
import { current, loadUser, saveUser } from "./settings.js";
import { loadCss } from "./tuner.js";
import { Overlay } from "./overlay.js";
import { RangeNav } from "./ranges.js";
import { playRecording, sleep, tone, playRange, MIX } from "./take.js";
import { openNotePopup, closeNotePopup } from "./note-popup.js";
import { openCalibrate } from "./calibrate.js";
import { Karaoke } from "./karaoke.js";
import { openGuide } from "./guide.js";
import * as SS from "./settings-sheet.js";
import * as Echo from "./echo-mode.js";
import * as Sing from "./sing-mode.js";
import { noteName } from "../edits.js";

const h = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
const VERDICT = { ok: "정확", wrong: "틀림", missed: "인식 안 됨" };
const LINES = { all: "전체", top: "위", mid: "가운데", bottom: "아래" };
const MODES = { echo: "메아리", sing: "반주와 부르기" };

// app: { sound, player, pages, boxes, score, practice, dock, back, scrollTo(k), refresh(), save() } — 앱(app.js)이 넘겨준다
export async function openPanel(app) {
  await loadCss();
  const S = { ...current() };
  const U = loadUser();
  const { sound, player } = app;
  const song = player.song, cfg = player.cfg, K = player.starts.length;
  const ov = new Overlay({ pages: app.pages, boxes: app.boxes, song, root: app.practice, opt: S });
  let job = null, closed = false, last = null, wake = null, stopPlayback = null, autoTimer = 0, closeSheet = null, kara = null, live = null, idleTimer = 0;

  const panel = h("section", "sing-panel");
  panel.setAttribute("aria-label", "노래 연습");
  const icon = (text, label) => { const b = h("button", "sp-icon", text); b.setAttribute("aria-label", label); return b; };
  const close = icon("✕", "노래 연습 닫기");
  if (!player.parts.length) {
    panel.append(h("p", "sp-status err", "이 악보에는 노래 줄이 없어서 부를 수 없어요."), close);
    app.practice.insertBefore(panel, app.dock);
    close.onclick = () => panel.remove();
    return;
  }

  // ---- 설정 (기기에 기억한 값 → 없으면 settings.js 의 처음 값)
  const hasAcc = player.hasPiano || song.measures.some((m) => m.chords.length);
  const pref = {
    part: 0, line: "all",
    listenAcc: U.listenAcc ?? S.echoListenAcc, autoNext: U.autoNext ?? S.echoAutoNext,
    acc: U.acc ?? true, accVol: U.accVol ?? S.accVol, melody: U.melody ?? false,
    level: S.level, octaveFree: !!S.octaveFree, colorblind: !!S.colorblind, hideMarks: !!S.hideMarks,
    output: U.output || S.output, mic: { ...S.mic, ...(U.mic || {}) },
  };
  S.mic = pref.mic;                                                // 마이크를 켤 때 쓴다 (에코 제거 등 — 설정 창에서 바꾼다)
  S.output = pref.output;                                          // 음 찾기가 스피커일 때만 배음 합 후보를 계산한다
  const soloI = player.parts.findIndex((p) => cfg.tracks[p.id] && cfg.tracks[p.id].solo);
  if (soloI > 0) pref.part = soloI;
  const wantLine = (i) => (cfg.tracks[player.parts[i].id] || {}).line || "all";
  const lineOk = (i, v) => v === "all" || !!player.vl[i].has[v];
  pref.line = lineOk(pref.part, wantLine(pref.part)) ? wantLine(pref.part) : "all";
  const keep = (o) => { Object.assign(pref, o); SS.remember(o); };

  // ---- 1줄: [메아리 | 반주와 부르기] ⚙ ✕
  const top = h("div", "sp-top");
  const seg = h("div", "sp-seg");
  seg.setAttribute("role", "tablist");
  const tabs = {};
  for (const [k, t] of Object.entries(MODES)) { const b = h("button", "sp-seg-btn", t); b.setAttribute("role", "tab"); tabs[k] = b; seg.append(b); }
  const gear = icon("⚙", "노래 채점 설정");
  top.append(seg, gear, close);
  // ---- 2줄: ◀ 구간 / 가사 ▶
  const rangeRow = h("div", "sp-range");
  const prev = icon("‹", "앞 구간"), next = icon("›", "다음 구간");
  const rbox = h("div", "sp-rangebox");
  const rangeText = h("b", "sp-rangetext"), lyric = h("span", "sp-lyric");
  rbox.append(rangeText, lyric);
  rangeRow.append(prev, rbox, next);
  // ---- 3줄: 작은 칩들 — 구간 단위 / 노래방 화면 / 박자 보정 권유
  const chips = h("div", "sp-chips");
  const unitSel = {};
  const unitItems = {
    echo: [...S.echoUnits.map((u) => [String(u), u === "phrase" ? "프레이즈" : u + "마디씩"]), ...(cfg.loop ? [["loop", "구간 반복"]] : [])],
    sing: [["start", "처음부터"], ["here", "지금 마디부터"]],
  };
  for (const m of Object.keys(MODES)) {
    const s = h("select", "sp-chip");
    for (const [v, t] of unitItems[m]) { const o = h("option", null, t + " ▾"); o.value = v; s.append(o); }
    s.value = m === "sing" ? "start" : cfg.loop ? "loop" : String(S.echoUnit);
    s.setAttribute("aria-label", m === "sing" ? "어디서부터 부를지" : "구간 단위");
    unitSel[m] = s;
    chips.append(s);
  }
  const karaBtn = h("button", "sp-chip", "🎤 노래방 화면");
  const calChip = h("button", "sp-chip warn", "⏱ 박자 보정 안 함");
  chips.append(karaBtn, calChip);
  // ---- 4줄: 큰 시작 단추 + 짧은 안내 한 줄
  const go = h("button", "sp-go", "▶ 듣고 부르기");
  const msg = h("p", "sp-status");
  // ---- 5줄: 결과 (큰 숫자 + 집계) + 작은 단추들
  const result = h("div", "sp-result");
  const pct = h("b", "sp-pct"), counts = h("span", "sp-counts"), sub = h("span", "sp-sub");
  const nums = h("div", "sp-nums");
  nums.append(counts, sub);
  result.append(pct, nums);
  const tools = h("div", "sp-tools");
  const tool = (t) => { const b = h("button", "sp-tool", t); tools.append(b); return b; };
  const melBtn = tool("🎹 멜로디"), myBtn = tool("🎤 내 녹음"), worstBtn = tool("🔁 틀린 곳 메아리로"), tableBtn = tool("📋 표");
  const table = h("div", "sing-table sp-table");
  panel.append(top, rangeRow, chips, go, msg, result, tools, table);
  app.practice.insertBefore(panel, app.dock);
  app.practice.classList.add("sing-on");
  // 노래방 화면 자리 (악보 대신)
  const karaBox = h("div", "sing-karaoke");
  app.practice.insertBefore(karaBox, panel);

  // ---- 상태
  let mode = U.mode === "sing" ? "sing" : "echo";
  let nav = null;
  const measureN = (k) => song.measures[song.order[Math.min(K - 1, Math.max(0, k))]].n;
  const notes = () => (pref.line === "all" ? player.vl[pref.part].all : player.vl[pref.part].lines[pref.line] || []);
  const partId = () => player.parts[pref.part].id;
  const opt = () => ({ ...S, level: pref.level, octaveFree: pref.octaveFree, speaker: pref.output === "speaker" });
  // 반주로 울리는 음들 (스피커일 때 목소리와 가르는 데 쓴다): T(박) 로 시각을 얻은 뒤 만든다. 들리는 줄만 — 반주(피아노·코드), 다른 노래 줄, "멜로디도 작게"면 내 줄
  function accAtFor(T) {
    const me = partId(), muted = (id) => !!(cfg.tracks[id] && cfg.tracks[id].mute);
    const audible = (tr) => (tr === me ? pref.melody : tr === "piano" || tr === "chord" ? hasAcc && pref.acc && !muted(tr) : tr !== "metro" && !muted(tr));
    const tp = cfg.transpose || 0, bins = new Map();
    for (const e of player.events) {
      if (e.click || !audible(e.tr)) continue;
      const it = [T(e.b), T(e.b + e.d) + S.accRingSec, e.midi + tp];
      for (let b = Math.floor(it[0] * 2); b <= Math.floor(it[1] * 2); b++) { if (!bins.has(b)) bins.set(b, []); bins.get(b).push(it); }
    }
    return (t) => (bins.get(Math.floor(t * 2)) || []).filter((it) => it[0] <= t && t < it[1]).map((it) => it[2]);
  }
  function setMsg(t, err = false) { msg.textContent = t; msg.classList.toggle("err", err); }
  function clearResult() {
    closeNotePopup();
    result.hidden = tools.hidden = table.hidden = true;
    table.textContent = "";
    ov.clearMarks();
    last = null;
  }
  const calOk = () => typeof S.latencyMs === "number";
  const refreshChips = () => {
    for (const [k, s] of Object.entries(unitSel)) s.hidden = k !== mode;
    karaBtn.hidden = mode !== "sing";
    karaBtn.classList.toggle("on", !!kara);
    calChip.hidden = calOk();
  };

  function pick(k, dir = 0) {
    if (mode === "sing") {                                         // 반주와 부르기: 고른 곳(처음 또는 지금 마디)부터 곡 끝까지
      const k0 = unitSel.sing.value === "here" ? Math.max(0, Math.min(K - 1, k)) : 0;
      const r = { k0, k1: K, from: player.starts[k0], to: player.totalBeats, noteFrom: player.starts[k0], noteTo: player.totalBeats, whole: true };
      nav = { cur: notes().some((n) => n.start >= r.noteFrom - 1e-6) ? r : null, skipped: false, hasPrev: () => false, hasNext: () => false };
      clearResult();
      showRange();
      return;
    }
    nav = new RangeNav({ notes: notes(), starts: player.starts, total: player.totalBeats, loop: cfg.loop, opt: S });
    nav.unit = unitSel.echo.value === "phrase" || unitSel.echo.value === "loop" ? unitSel.echo.value : +unitSel.echo.value;
    const r = dir > 0 ? (nav.at(k), nav.next()) || nav.cur : dir < 0 ? (nav.at(k), nav.prev()) || nav.cur : nav.at(k);
    nav.cur = r;
    clearResult();
    showRange(nav.skipped ? "전주·간주는 건너뛰고 노래가 나오는 곳부터 해요." : "");
  }
  function lyricsOf(r) {
    const t = notes().filter((n) => n.start >= r.noteFrom - 1e-6 && n.start < r.noteTo - 1e-6).map((n) => n.lyric || "").join("").replace(/\s+/g, "");
    return t.length > 16 ? t.slice(0, 16) + "…" : t;
  }
  const READY = () => (mode === "echo" ? "멜로디를 듣고, 한 마디 센 뒤 따라 불러요"
    : !hasAcc ? "박자 소리에 맞춰 곡 끝까지 불러요"
      : pref.output === "speaker" ? (pref.accVol > S.speakerVolHint ? "스피커예요 · 반주를 조금 줄이면 더 정확해요 (⚙)" : "곡 끝까지 반주와 같이 불러요 · 스피커 소리는 걸러서 들어요")
        : "곡 끝까지 반주와 같이 불러요");
  function showRange(note = "") {
    const r = nav.cur;
    prev.hidden = next.hidden = mode === "sing";
    if (!r) { rangeText.textContent = "부를 음이 없어요"; lyric.textContent = ""; prev.disabled = next.disabled = true; ov.range(0, 0); setMsg("고른 노래 줄에 음이 없어요. ⚙ 에서 다른 줄을 골라 주세요.", true); go.disabled = true; return; }
    go.disabled = false;
    const a = measureN(r.k0), b = measureN(r.k1 - 1);
    if (r.whole) { rangeText.textContent = r.k0 === 0 ? "처음부터 끝까지" : `${a}마디부터 끝까지`; lyric.textContent = `${song.measures.length}마디 곡`; }
    else { rangeText.textContent = a === b ? `${a}마디` : `${a}–${b}마디`; lyric.textContent = lyricsOf(r); }
    prev.disabled = !nav.hasPrev();
    next.disabled = !nav.hasNext();
    ov.range(r.k0, r.whole ? r.k0 + 1 : r.k1);                     // 곡 끝까지 부를 때는 시작 마디만 칠한다
    app.scrollTo(r.k0);
    setMsg(note || READY());
    go.textContent = mode === "echo" ? "▶ 듣고 부르기" : "● 반주와 부르기";
  }
  function setMode(m) {
    mode = m;
    keep({ mode: m });
    for (const [k, b] of Object.entries(tabs)) { b.classList.toggle("on", k === m); b.setAttribute("aria-selected", String(k === m)); }
    if (m !== "sing" && kara) toggleKara();
    refreshChips();
    pick(nav && nav.cur ? nav.cur.k0 : player.kAt(player.pos));
  }
  for (const [k, b] of Object.entries(tabs)) b.onclick = () => { if (!job) setMode(k); };
  for (const [m, s] of Object.entries(unitSel)) s.onchange = () => pick(m === "sing" ? player.kAt(player.pos) : nav && nav.cur ? nav.cur.k0 : player.kAt(player.pos));
  prev.onclick = () => { if (!job && nav.cur) pick(nav.cur.k0, -1); };
  next.onclick = () => { if (!job && nav.cur) pick(nav.cur.k0, 1); };

  // ---- ⚙ 설정 창
  function openSettings() {
    if (job) return;
    closeSheet = SS.openSheet("노래 채점 설정", (body) => {
      const sPart = SS.section(body, "부를 줄");
      const partSel = SS.selectRow(sPart, "노래 줄", player.parts.map((p, i) => [String(i), p.name]), String(pref.part));
      const lineItems = (i) => ["all", "top", "mid", "bottom"].filter((v) => lineOk(i, v)).map((v) => [v, LINES[v] + (v === "all" ? "" : " 성부")]);
      const lineSel = SS.selectRow(sPart, "성부", lineItems(pref.part), pref.line);
      const fillLines = () => { const i = +partSel.value; lineSel.textContent = ""; for (const [v, t] of lineItems(i)) { const o = h("option", null, t); o.value = v; lineSel.append(o); } lineSel.value = lineOk(i, pref.line) ? pref.line : "all"; lineSel.closest(".ss-row").hidden = lineSel.options.length < 2; };
      fillLines();
      partSel.closest(".ss-row").hidden = player.parts.length < 2;
      if (player.parts.length < 2 && lineSel.options.length < 2) sPart.hidden = true;
      partSel.onchange = () => { fillLines(); pref.part = +partSel.value; pref.line = lineSel.value; pick(nav.cur ? nav.cur.k0 : 0); };
      lineSel.onchange = () => { pref.line = lineSel.value; pick(nav.cur ? nav.cur.k0 : 0); };

      const sEcho = SS.section(body, "메아리");
      SS.switchRow(sEcho, "듣기 때 반주도 같이", pref.listenAcc).onchange = (e) => keep({ listenAcc: e.target.checked });
      SS.switchRow(sEcho, `${S.echoAutoNextPct}% 넘으면 다음 구간으로`, pref.autoNext).onchange = (e) => keep({ autoNext: e.target.checked });

      const sSing = SS.section(body, "반주와 부르기");
      SS.switchRow(sSing, hasAcc ? "반주" : "메트로놈", pref.acc, hasAcc ? "끄면 메트로놈만 나와요" : "").onchange = (e) => keep({ acc: e.target.checked });
      if (hasAcc) SS.rangeRow(sSing, "반주 크기", Math.round(pref.accVol * 100)).oninput = (e) => keep({ accVol: e.target.value / 100 });
      SS.switchRow(sSing, "멜로디도 작게 같이", pref.melody).onchange = (e) => keep({ melody: e.target.checked });

      const sJudge = SS.section(body, "판정");
      const lv = SS.segmented(sJudge, Object.entries(S.levels).map(([k, v]) => [k, `${v.name} ±${v.cents}`]), pref.level, "판정 난이도");
      lv.onchange = (v) => keep({ level: v });
      SS.switchRow(sJudge, "옥타브 무시", pref.octaveFree, "한 옥타브 낮게(높게) 불러도 정확").onchange = (e) => keep({ octaveFree: e.target.checked });

      const sView = SS.section(body, "보기");
      const restyle = () => ov.style({ colorblind: pref.colorblind, hidden: pref.hideMarks });
      SS.switchRow(sView, "색맹 모드", pref.colorblind, "파랑·분홍·청록 + ○ × △").onchange = (e) => { keep({ colorblind: e.target.checked }); restyle(); };
      SS.switchRow(sView, "채점 표시 끄기", pref.hideMarks).onchange = (e) => { keep({ hideMarks: e.target.checked }); restyle(); };

      const sOut = SS.section(body, "소리");
      const out = SS.segmented(sOut, [["earphones", "🎧 이어폰"], ["speaker", "🔊 스피커"]], pref.output, "소리 나오는 곳");
      out.onchange = (v) => { keep({ output: v }); S.output = v; showRange(); };
      const micRow = (k, label) => SS.switchRow(sOut, label, pref.mic[k], "켜면 노래 음정이 흐려질 수 있어요").onchange = (e) => {
        keep({ mic: { ...pref.mic, [k]: e.target.checked } }); S.mic = pref.mic; eng.stop();           // 다음에 마이크를 켤 때부터
      };
      micRow("echoCancellation", "에코 제거");
      micRow("noiseSuppression", "잡음 줄이기");
      micRow("autoGainControl", "자동 음량");
      if (hasAcc) {
        const t = h("button", "ss-btn", `🔊 반주만 틀고 시험 (${S.speakerTestSec}초)`);
        t.onclick = () => { closeSheet(); speakerTest(); };
        sOut.append(t, h("p", "ss-note", "가만히 있는 동안 반주 소리를 목소리로 잘못 듣는지 재요. 스피커로 쓸 때 해 보세요."));
      }

      const sTime = SS.section(body, "박자");
      const cal = h("button", "ss-btn", calOk() ? `⏱ 박자 보정 다시 하기 (지금 ${(S.latencyMs / 1000).toFixed(2)}초)` : "⏱ 박자 보정 하기 (아직 안 함)");
      cal.onclick = () => { closeSheet(); calibrate(); };
      sTime.append(cal);
      const again = h("button", "ss-btn", "처음 안내 다시 보기");
      again.onclick = () => { closeSheet(); guide(); };
      SS.section(body, "도움말").append(again);
    });
  }
  gear.onclick = openSettings;
  const calibrate = () => { if (job) return; openCalibrate({ sound, onDone: (ms) => { S.latencyMs = ms; refreshChips(); } }); };
  calChip.onclick = calibrate;

  // ---- 노래방 화면 (반주와 부르기). 부르는 도중에도 바꿀 수 있다
  function toggleKara() {
    if (kara) { kara.destroy(); kara = null; app.practice.classList.remove("sing-k"); }
    else {
      app.practice.classList.add("sing-k");
      kara = new Karaoke({ root: karaBox, S, now: () => (sound.ctx ? sound.ctx.currentTime : 0), targets: () => (live && live.targets) || null,
        frames: () => {                                            // 스피커면 노래방 선도 반주 소리를 거른 것으로
          const f = eng.liveFrames(), o2 = live && live.o;
          return o2 && o2.speaker && o2.accAt ? speakerFilter(f.slice(-S.karaFilterFrames), live.targets || [], o2) : f;
        }, latency: latencyOf(S), tol: tolerance(opt()), octaveFree: pref.octaveFree });
      kara.start();
    }
    refreshChips();
    if (!kara && nav && nav.cur) app.scrollTo(player.kAt(player.now()));
  }
  karaBtn.onclick = toggleKara;

  // 악보에서 마디를 누르면(앱이 재생 위치를 옮긴 뒤) 거기서부터. 하는 중에는 악보를 눌러도 아무 일도 없게 막는다
  const onScoreTap = (e) => {
    if (job) { e.stopPropagation(); e.preventDefault(); return; }
    if (!e.target.closest || !e.target.closest(".mbox")) return;
    setTimeout(() => { if (job || closed) return; if (mode === "sing") unitSel.sing.value = "here"; pick(player.kAt(player.pos)); }, 0);
  };
  app.score.addEventListener("click", onScoreTap, true);

  const eng = new PitchEngine({ getCtx: () => sound.ensure(), settings: S });
  eng.onError = (err) => { if (job) job.cancelled = true; setMsg(err.message, true); };

  setMode(mode);
  // 처음 쓰는 사람: 3장짜리 안내 (마이크 허용 → 이어폰/스피커 → 박자 보정)
  async function guide() {
    const r = await openGuide(pref.output);
    keep({ guideSeen: true, calibAsked: true });
    if (closed) return;
    if (r.output) { keep({ output: r.output }); S.output = r.output; showRange(); }
    if (r.calibrate) calibrate();
  }
  if (!U.guideSeen) guide();
  else if (!calOk() && !U.calibAsked) { SS.remember({ calibAsked: true }); setMsg("박자까지 보려면 '⏱ 박자 보정'을 한 번 해 주세요 (30초). 안 해도 부를 수 있어요."); }

  // ---- 하기
  const busyEls = () => [prev, next, unitSel.echo, unitSel.sing, ...Object.values(tabs), gear, melBtn, myBtn, worstBtn, calChip];
  function begin() {
    clearTimeout(autoTimer);
    clearTimeout(idleTimer);
    if (stopPlayback) { stopPlayback(); stopPlayback = null; }
    if (closeSheet) { closeSheet(); closeSheet = null; }
    job = { cancelled: false };
    for (const el of busyEls()) el.disabled = true;
    go.textContent = "■ 그만";
    go.classList.add("stop");
    const ns = song.parts.flatMap((p) => p.notes.map((n) => n.midi + cfg.transpose));
    sound.ensure();
    sound.load(Math.min(36, ...ns), Math.max(72, ...ns));
    navigator.wakeLock && navigator.wakeLock.request("screen").then((w) => { wake = w; }, () => {});
    app.refresh();
    return job;
  }
  function end() {
    job = null;
    if (closed) return;
    // 한동안 안 부르면 마이크를 끈다 (배터리, 주소창의 마이크 표시). 다시 누르면 저절로 다시 켠다
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!job && eng.running) eng.stop(); }, S.micIdleOffSec * 1000);
    for (const el of busyEls()) el.disabled = false;
    go.classList.remove("stop");
    if (wake) { wake.release().catch(() => {}); wake = null; }
    if (nav.cur) player.pos = nav.cur.from;
    app.refresh();
    app.save();                                                    // 되돌린 재생 설정을 저장
    const err = msg.classList.contains("err") ? msg.textContent : "";
    const keepLast = last;
    showRange(err);
    last = keepLast;
    if (last) { setMsg(last.note, last.err); go.textContent = "● 다시 부르기"; }
    prev.disabled = !nav.hasPrev(); next.disabled = !nav.hasNext();
  }
  const ctlFor = (j) => {
    const r = nav.cur, list = notes();
    const first = list.find((n) => n.start >= r.noteFrom - 1e-6 && n.start < r.noteTo - 1e-6);
    return { player, sound, eng, S, me: partId(), line: pref.line, range: r, list, job: j,
      first: first ? first.midi + (cfg.transpose || 0) : 60, withAcc: pref.acc, hasAcc, melody: pref.melody, accVol: pref.accVol,
      // 카운트인: 첫 음이 시작 마디 안에 있을 때만 (전주가 있으면 전주가 박자를 알려 준다)
      countIn: !first || first.start < (r.k0 + 1 < K ? player.starts[r.k0 + 1] : player.totalBeats) - 1e-6,
      status: (t) => setMsg(t) };
  };

  // fullEcho: 메아리에서 듣기부터 (처음, 다음 구간). 아니면 바로 부르기 (다시 부르기)
  async function run(fullEcho) {
    if (job) { job.cancelled = true; return; }
    if (!nav.cur) return;
    go.disabled = true;
    try { await eng.start(); } catch (err) {
      go.disabled = false;
      setMsg(err instanceof MicError ? err.message : "마이크를 켜지 못했어요: " + (err && err.message), true);
      return;
    }
    go.disabled = false;
    if (closed) { eng.stop(); return; }
    const j = begin(), ctl = ctlFor(j), o = opt();
    clearResult();
    live = null;
    try {
      let took = null;
      if (mode === "echo") {
        if (fullEcho && !(await Echo.listen(ctl, pref.listenAcc))) return;
        if (fullEcho) { setMsg("이제 따라 부를 차례예요"); await sleep(S.echoGapSec * 1000); }
        if (j.cancelled) return;
        took = await Echo.sing(ctl);
      } else {
        // 부르는 동안 지나간 음을 바로바로 색칠한다 (노래방 화면도 같은 목표 음을 쓴다)
        live = { targets: null, next: 0, notes: [], at: 0, o };
        ctl.live = (t, T) => {
          if (!live.targets) {
            live.targets = targetsFrom(ctl.list, player.tl, ctl.range.noteFrom, ctl.range.noteTo, { base: T(ctl.range.noteFrom), transpose: cfg.transpose || 0, opt: o });
            if (o.speaker) o.accAt = accAtFor(T);
          }
          if (t - live.at < S.liveEverySec) return;
          live.at = t;
          let k = live.next;
          while (k < live.targets.length && live.targets[k].t1 + S.liveWaitSec < t) k++;
          if (k === live.next) return;
          const batch = live.targets.slice(live.next, k), from = batch[0].t0 - S.liveContextSec;
          live.notes.push(...scoreAll(batch, eng.liveFrames().filter((f) => f.t >= from), o).notes);
          live.next = k;
          ov.results(live.notes, { partId: partId(), transpose: cfg.transpose || 0 });
          const ok = live.notes.filter((n) => n.verdict === "ok").length;
          result.hidden = false;
          pct.textContent = Math.round(ok / live.notes.length * 100) + "%";
          counts.textContent = `지금까지 ${live.notes.length}음`;
          sub.textContent = "";
        };
        took = await Sing.sing(ctl);
      }
      if (!took) return;
      let targets = targetsFrom(ctl.list, player.tl, ctl.range.noteFrom, ctl.range.noteTo, { base: took.T(ctl.range.noteFrom), transpose: cfg.transpose || 0, opt: o });
      if (o.speaker && mode === "sing") o.accAt = accAtFor(took.T);           // 메아리는 부르는 동안 앱 소리가 없어서 거를 것이 없다
      if (took.cancelled) {                                        // 중간에 그만: 그때까지 부른 음만 채점한다
        targets = targets.filter((g) => g.t1 <= took.stopAt + 0.05);
        if (!targets.length) return;
      }
      show({ ...scoreAll(targets, took.rec ? took.rec.frames : [], o), opt: o }, took.rec, ctl.range, took.cancelled);
    } catch (err) {
      console.error(err);
      setMsg("하다가 멈췄어요: " + (err && err.message), true);
    } finally {
      const cancelled = j.cancelled;
      end();
      if (cancelled && !last) setMsg("멈췄어요.");
      else if (last && mode === "echo" && pref.autoNext && last.res.summary.accuracy >= S.echoAutoNextPct && nav.hasNext()) {
        setMsg(`정확 ${last.res.summary.accuracy}%! 잠시 뒤 다음 구간으로 가요.`);
        autoTimer = setTimeout(() => { if (closed || job) return; pick(nav.cur.k0, 1); run(true); }, S.echoAutoNextDelaySec * 1000);
      }
    }
  }

  // 스피커 시험: 반주만 틀고 가만히 있는 동안 목소리로 잡힌 비율 — 거르기 전 / 거른 뒤 (8단계)
  async function speakerTest() {
    if (job) return;
    try { await eng.start(); } catch (err) { setMsg(err instanceof MicError ? err.message : "마이크를 켜지 못했어요", true); return; }
    const k = player.kAt(player.pos), from = player.starts[k];
    const to = Math.min(player.totalBeats, player.tl.beatOf(player.tl.secOf(from) + S.speakerTestSec));
    const j = begin(), wasOut = S.output;
    S.output = "speaker";                                          // 시험하는 동안은 스피커처럼 후보를 모두 구한다
    clearResult();
    let T = null, rec = null;
    try {
      setMsg(`🔊 반주만 나와요 — ${S.speakerTestSec}초 동안 가만히 있어 주세요`);
      eng.startRecord();
      await playRange({ player, sound }, j, { from, to, mix: MIX.accomp(player, partId(), { withAcc: true, hasAcc, melodyVol: 0, countIn: false, accVol: pref.accVol }), onStart: (t) => { T = t; } });
      rec = eng.stopRecord();
    } finally { S.output = wasOut; end(); }
    if (!rec || !T || j.cancelled) { setMsg("시험을 멈췄어요."); return; }
    const fr = rec.frames.filter((f) => f.db !== undefined);
    const targets = targetsFrom(notes(), player.tl, from, to, { base: T(from), transpose: cfg.transpose || 0, opt: S });
    const after = speakerFilter(fr, targets, { ...opt(), speaker: true, accAt: accAtFor(T) });
    const share = (a) => (a.length ? Math.round(a.filter((f) => f.pitch !== null && f.pitch !== undefined).length / a.length * 100) : 0);
    const a = share(fr), b = share(after);
    setMsg(`가만히 있는데 목소리로 잡힌 소리: 거르기 전 ${a}% → 거른 뒤 ${b}%` + (b > S.speakerTestOkPct ? " · 반주를 줄이거나 이어폰을 써 주세요" : " · 스피커로 써도 괜찮아요"), b > S.speakerTestOkPct);
  }

  // 음표 점을 누르면 그 음의 그래프 (5단계). 내 소리: 녹음에서 그 음 자리만 (늦게 들어온 만큼 맞춰서)
  const tapNote = (n, el) => {
    if (!last || job) return;
    const lag = (last.res.summary.lagMs || 0) / 1000;
    openNotePopup(n, el, last.opt, song, {
      timingText: timingText(n),
      onMine: last.rec ? () => { if (stopPlayback) stopPlayback(); stopPlayback = playRecording(sound, last.rec, n.t0 + lag - 0.05, n.t1 + lag + 0.08); } : null,
      onOrig: () => tone(sound, n.target, Math.min(2, Math.max(0.3, n.t1 - n.t0))),
    });
  };
  // 박자·길이를 쉬운 말로 (그래프 팝업)
  const sec = (ms) => (Math.abs(ms) / 1000).toFixed(2) + "초";
  const timingText = (n) => {
    const t = n.timing;
    let out;
    if (!t || t.verdict === null) out = n.verdict === "missed" ? "" : n.ref && n.ref.fermata && S.timingSkipFermata ? "페르마타라 박자는 보지 않아요" : "음 시작을 찾지 못했어요";
    else out = t.verdict === "ok" ? `맞음 (${t.offsetMs >= 0 ? sec(t.offsetMs) + " 늦게" : sec(t.offsetMs) + " 빠르게"}, ±${sec(t.tolMs)} 안)`
      : `${sec(t.offsetMs)} ${t.verdict === "late" ? "늦게" : "빠르게"} 들어옴`;
    if (n.length) out += ` · 길이: 악보 ${sec(n.length.scoreMs)} / 부른 ${sec(n.length.sungMs)}` + (n.length.short ? " (짧게 끊음)" : "");
    if (out && last && last.res.summary.latencyGuessed) out += " · 박자 보정 전이라 어림";
    return out;
  };
  function show(res, rec, range, partial = false) {
    const s = res.summary;
    result.hidden = tools.hidden = false;
    pct.textContent = s.accuracy + "%";
    counts.textContent = (partial ? "멈춘 곳까지 · " : "") + `정확 ${s.ok} · 틀림 ${s.wrong}` + (s.missed ? ` · 인식 안 됨 ${s.missed}` : "") + (s.ambiguous ? ` · 애매 ${s.ambiguous}` : "");
    sub.textContent = `빠른 음 ${s.early} · 늦은 음 ${s.late}` + (s.latencyGuessed ? " (박자 어림)" : "");
    ov.results(res.notes, { partId: partId(), transpose: cfg.transpose || 0, onTap: tapNote });
    app.scrollTo(range.k0);
    const err = s.voicedShare < 0.3;
    const note = err ? `목소리가 거의 안 잡혔어요 (${Math.round(s.voicedShare * 100)}%). 폰을 입 가까이 두고 다시 해 보세요.`
      : "음표의 점을 누르면 그 음의 그래프가 나와요";
    last = { res, rec, range, note, err, opt: res.opt };
    melBtn.hidden = mode !== "echo";
    worstBtn.hidden = mode !== "sing" || !worstK(res.notes);
    table.textContent = "";
    const t = h("table"), hr = h("tr");
    for (const c of ["마디", "박", "가사", "목표", "부른 음", "차이", "판정", "박자"]) hr.append(h("th", null, c));
    t.append(hr);
    for (const n of res.notes) {
      const tr = h("tr", "v-" + (n.color || n.verdict)), mm = n.ref ? song.measures[n.ref.m] : null;
      const cells = [mm ? mm.n : "", n.ref ? Math.round((n.ref.beat + 1) * 100) / 100 : "", n.ref ? n.ref.lyric : "",
        noteName(n.target) + (n.refs && n.refs.length > 1 ? " (화음 중)" : ""), n.sung ? n.sung.name : "—",
        n.cents === null ? "—" : (n.cents > 0 ? "+" : "") + Math.round(n.cents),
        n.ambiguous ? "애매(반주와 같은 음)" : VERDICT[n.verdict] + (n.dir === "high" ? " ↑" : n.dir === "low" ? " ↓" : ""),
        n.timing && n.timing.verdict ? (n.timing.verdict === "ok" ? "맞음" : (n.timing.offsetMs > 0 ? "+" : "") + (n.timing.offsetMs / 1000).toFixed(2) + "초") : "—"];
      for (const c of cells) tr.append(h("td", null, String(c)));
      t.append(tr);
    }
    table.append(t);
  }
  // 가장 많이 틀린(틀림·인식 안 됨) 마디 → 연주 순서 번호 (없으면 null)
  function worstK(ns) {
    const bad = new Map();
    for (const n of ns) if (n.verdict !== "ok" && n.ref) bad.set(n.ref.k, (bad.get(n.ref.k) || 0) + 1);
    let best = null;
    for (const [k, c] of bad) if (best === null || c > bad.get(best) || (c === bad.get(best) && k < best)) best = k;
    return best;
  }
  worstBtn.onclick = () => {                                       // 반주와 부르기 결과 → 가장 많이 틀린 마디를 메아리로 (2마디씩)
    if (!last || job) return;
    const k = worstK(last.res.notes);
    if (k === null) return;
    setMode("echo");
    unitSel.echo.value = "2";
    pick(k);
    setMsg(`${measureN(k)}마디에서 가장 많이 틀렸어요. 메아리로 연습해요`);
  };
  tableBtn.onclick = () => { table.hidden = !table.hidden; tableBtn.textContent = table.hidden ? "📋 표" : "📋 표 닫기"; };
  myBtn.onclick = () => {
    if (!last || !last.rec) return;
    if (stopPlayback) { stopPlayback(); stopPlayback = null; myBtn.textContent = "🎤 내 녹음"; return; }
    stopPlayback = playRecording(sound, last.rec);
    myBtn.textContent = "■ 그만";
    const secs = last.rec.audio.length / last.rec.sampleRate;
    setTimeout(() => { stopPlayback = null; myBtn.textContent = "🎤 내 녹음"; }, secs * 1000 + 200);
  };
  melBtn.onclick = async () => {                                   // 원래 멜로디 다시 듣기 (마이크 없이)
    if (job || !nav.cur) return;
    const j = begin();
    try { await Echo.listen(ctlFor(j), pref.listenAcc); } finally { end(); }
  };
  go.onclick = () => run(mode === "echo" && !(last && last.range === nav.cur));

  function shut() {
    if (closed) return;
    closed = true;
    clearTimeout(autoTimer);
    clearTimeout(idleTimer);
    closeNotePopup();
    if (closeSheet) closeSheet();
    if (job) { job.cancelled = true; player.pause(); if (job.restore) job.restore(); }      // 앱이 곡을 닫으며 저장하기 전에 되돌린다
    if (stopPlayback) stopPlayback();
    if (kara) kara.destroy();
    eng.stop();
    ov.clear();
    document.removeEventListener("visibilitychange", onHide);
    app.score.removeEventListener("click", onScoreTap, true);
    app.back.removeEventListener("click", shut, true);
    app.practice.classList.remove("sing-on", "sing-k");
    panel.remove();
    karaBox.remove();
    app.refresh();
    app.save();
  }
  function onHide() {
    if (!document.hidden) return;
    clearTimeout(autoTimer);
    if (job) { job.cancelled = true; player.pause(); if (job.restore) job.restore(); app.save(true); }      // 앱이 내려간 채 꺼져도 바꾼 재생 설정이 남지 않게
    if (eng.running) { eng.stop(); setMsg("화면을 벗어나서 멈추고 마이크를 껐어요. 다시 눌러 주세요."); }
  }
  document.addEventListener("visibilitychange", onHide);
  app.back.addEventListener("click", shut, true);                  // 앱이 곡을 닫기(저장) 전에 설정부터 되돌린다
  close.onclick = shut;
  return { close: shut, engine: eng, panel, result: () => last, setMode, run };
}
