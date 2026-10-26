// 노래 채점: 연습 화면 아래 조작판 자리에 들어가는 칸. 악보는 그대로 보인다.
// [메아리 | 반주와 부르기] 를 고르고, 부를 구간(프레이즈·마디)을 악보 위에 칠하고, 끝나면 음표 머리마다 판정을 칠한다.
// 흐름은 echo-mode.js(메아리)·sing-mode.js(반주와 부르기), 재생은 take.js, 구간은 ranges.js, 채점은 scoring.js, 악보 위 표시는 overlay.js.
import { PitchEngine, MicError } from "./pitch-engine.js";
import { targetsFrom, scoreAll } from "./scoring.js";
import { current, loadUser, saveUser } from "./settings.js";
import { loadCss } from "./tuner.js";
import { Overlay } from "./overlay.js";
import { RangeNav } from "./ranges.js";
import { playRecording, sleep, tone } from "./take.js";
import { openNotePopup, closeNotePopup } from "./note-popup.js";
import { openCalibrate } from "./calibrate.js";
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
  const { sound, player } = app;
  const song = player.song, cfg = player.cfg, K = player.starts.length;
  const ov = new Overlay({ pages: app.pages, boxes: app.boxes, song, root: app.practice, opt: S });
  let job = null, closed = false, last = null, wake = null, stopPlayback = null, autoTimer = 0;

  const panel = h("section", "sing-panel");
  panel.setAttribute("aria-label", "노래 연습");
  const close = h("button", "icon sing-close", "✕");
  close.setAttribute("aria-label", "노래 연습 닫기");
  if (!player.parts.length) {
    panel.append(h("p", "sing-msg err", "이 악보에는 노래 줄이 없어서 부를 수 없어요."), close);
    app.practice.insertBefore(panel, app.dock);
    close.onclick = () => panel.remove();
    return;
  }
  const sel = (parent, items, val, label) => {
    const l = h("label", "sing-sel"), s = h("select");
    for (const [v, t] of items) { const o = h("option", null, t); o.value = v; s.append(o); }
    s.value = val;
    l.append(s);
    s.setAttribute("aria-label", label);
    parent.append(l);
    return s;
  };
  const chk = (parent, label, on) => {
    const l = h("label", "chk sing-chk"), i = h("input");
    i.type = "checkbox"; i.checked = on;
    l.append(i, h("span", null, label));
    parent.append(l);
    return i;
  };
  const button = (parent, text, label) => { const b = h("button", "btn sm", text); if (label) b.setAttribute("aria-label", label); parent.append(b); return b; };

  // 0줄: [메아리] [반주와 부르기] ………… [✕]
  const row0 = h("div", "sing-tabs");
  const tabs = {};
  for (const [k, t] of Object.entries(MODES)) { tabs[k] = button(row0, t); tabs[k].classList.add("toggle"); }
  row0.append(h("span", "sing-grow"), close);
  // 1줄: [◀] 3 ~ 4마디 · 가사 [▶] [단위]
  const row1 = h("div", "sing-range");
  const prev = button(row1, "◀", "앞 구간");
  const rangeText = h("b", "sing-rangetext");
  row1.append(rangeText);
  const next = button(row1, "▶", "다음 구간");
  const unitBox = h("span");
  row1.append(unitBox);
  // 2줄: 모드별 선택 · 노래 줄 · 성부 · 판정
  const row2 = h("div", "sing-opts");
  const echoOpts = h("span", "sing-optgroup"), singOpts = h("span", "sing-optgroup");
  const listenAcc = chk(echoOpts, "듣기 때 반주도", !!S.echoListenAcc);
  const autoNext = chk(echoOpts, `${S.echoAutoNextPct}% 넘으면 다음`, !!S.echoAutoNext);
  const hasAcc = player.hasPiano || song.measures.some((m) => m.chords.length);
  const accOn = chk(singOpts, hasAcc ? "반주" : "메트로놈", true);
  const melOn = chk(singOpts, "멜로디 작게", false);
  row2.append(echoOpts, singOpts);
  const partSel = sel(row2, player.parts.map((p, i) => [String(i), p.name]), "0", "부를 노래 줄");
  const lineSel = sel(row2, [], "all", "부를 성부");
  const more = h("details", "sing-more");
  more.append(h("summary", null, "판정"));
  const moreBox = h("div", "sing-opts");
  more.append(moreBox);
  const levelSel = sel(moreBox, Object.entries(S.levels).map(([k, v]) => [k, `${v.name} ±${v.cents}센트`]), S.level, "판정 난이도");
  const oct = chk(moreBox, "옥타브 무시", !!S.octaveFree);
  const cb = chk(moreBox, "색맹 모드(○ × △)", !!S.colorblind);
  const hide = chk(moreBox, "채점 표시 끄기", !!S.hideMarks);
  const calBtn = button(moreBox, "");                              // 박자 보정 (6단계)
  const calText = () => { calBtn.textContent = typeof S.latencyMs === "number" ? `⏱ 박자 보정 (지금 ${(S.latencyMs / 1000).toFixed(2)}초)` : "⏱ 박자 보정 (아직 안 함)"; };
  calText();
  row2.append(more);
  // 3줄: [▶ 듣고 부르기] 안내
  const row3 = h("div", "sing-go");
  const go = h("button", "btn primary sing-start", "▶ 시작");
  const msg = h("p", "sing-msg");
  const calNow = h("button", "btn sm", "⏱ 박자 보정");            // 보정하지 않았으면 눈에 띄게 한 번 권한다
  calNow.hidden = typeof S.latencyMs === "number";
  row3.append(go, msg, calNow);
  // 4줄: 결과 요약 + [멜로디 듣기] [내 녹음 듣기] [표 보기]
  const row4 = h("div", "sing-result");
  const sum = h("p", "sing-sum");
  row4.append(sum);
  const tools = h("div", "sing-tools");
  const melBtn = button(tools, "🎹 멜로디 듣기");
  const myBtn = button(tools, "🎤 내 녹음 듣기");
  const tableBtn = button(tools, "표 보기");
  row4.append(tools);
  const table = h("div", "sing-table");
  table.hidden = true;
  panel.append(row0, row1, row2, row3, row4, table);
  app.practice.insertBefore(panel, app.dock);
  app.practice.classList.add("sing-on");

  // ---- 상태
  let mode = loadUser().mode === "sing" ? "sing" : "echo";
  let nav = null;
  const unitSel = { echo: null, sing: null };
  const unitItems = (m) => {
    const list = (m === "echo" ? S.echoUnits : ["phrase", ...S.singLengths]).map((u) => [String(u), u === "phrase" ? "프레이즈" : u + "마디"]);
    if (cfg.loop) list.push(["loop", "구간 반복"]);
    return list;
  };
  for (const m of Object.keys(MODES)) {
    unitSel[m] = sel(unitBox, unitItems(m), cfg.loop ? "loop" : String(m === "echo" ? S.echoUnit : S.singMeasures), "구간 단위");
    unitSel[m].onchange = () => pick(nav && nav.cur ? nav.cur.k0 : player.kAt(player.pos));
  }
  const measureN = (k) => song.measures[song.order[Math.min(K - 1, Math.max(0, k))]].n;
  const notes = () => { const i = +partSel.value, line = lineSel.value; return line === "all" ? player.vl[i].all : player.vl[i].lines[line] || []; };
  function setMsg(t, err = false) { msg.textContent = t; msg.classList.toggle("err", err); }
  function clearResult() { closeNotePopup(); sum.textContent = ""; table.textContent = ""; table.hidden = true; tools.hidden = true; ov.clearMarks(); last = null; }

  function pick(k, dir = 0) {
    nav = new RangeNav({ notes: notes(), starts: player.starts, total: player.totalBeats, loop: cfg.loop, opt: S });
    nav.unit = unitSel[mode].value === "phrase" || unitSel[mode].value === "loop" ? unitSel[mode].value : +unitSel[mode].value;
    const r = dir > 0 ? (nav.at(k), nav.next()) || nav.cur : dir < 0 ? (nav.at(k), nav.prev()) || nav.cur : nav.at(k);
    nav.cur = r;
    clearResult();
    showRange(nav.skipped ? "노래가 없는 곳(전주·간주)은 건너뛰고 노래가 나오는 곳부터 해요." : "");
  }
  function lyricsOf(r) {
    const t = notes().filter((n) => n.start >= r.noteFrom - 1e-6 && n.start < r.noteTo - 1e-6).map((n) => n.lyric || "").join("").replace(/\s+/g, "");
    return t.length > 10 ? t.slice(0, 10) + "…" : t;
  }
  const READY = () => (mode === "echo"
    ? "멜로디를 듣고 → 첫 음 → 박자 한 마디를 센 다음, 반주 없이 따라 불러요. 부르는 동안 앱 소리는 나지 않아요."
    : (hasAcc ? "박자를 세고 반주가 나오면 같이 부르세요. 이어폰을 끼면 반주 소리가 마이크에 섞이지 않아 더 정확해요." : "박자 소리에 맞춰 부르세요."))
    + " 악보에서 마디를 누르면 거기서부터 해요.";
  function showRange(note = "") {
    const r = nav.cur;
    if (!r) { rangeText.textContent = "—"; prev.disabled = next.disabled = true; ov.range(0, 0); setMsg("이 곡에는 고른 노래 줄의 음이 없어요.", true); go.disabled = true; return; }
    go.disabled = false;
    const a = measureN(r.k0), b = measureN(r.k1 - 1), ly = lyricsOf(r);
    rangeText.textContent = (a === b ? `${a}마디` : `${a} ~ ${b}마디`) + (ly ? ` · ${ly}` : "");
    prev.disabled = !nav.hasPrev();
    next.disabled = !nav.hasNext();
    ov.range(r.k0, r.k1);
    app.scrollTo(r.k0);
    setMsg(note || READY());
    go.textContent = mode === "echo" ? "▶ 듣고 부르기" : "● 시작";
  }
  function fillLines() {
    const i = +partSel.value, has = player.vl[i].has, want = (cfg.tracks[player.parts[i].id] || {}).line || "all";
    lineSel.textContent = "";
    for (const v of ["all", "top", "mid", "bottom"]) if (v === "all" || has[v]) { const o = h("option", null, LINES[v] + (v === "all" ? "" : " 성부")); o.value = v; lineSel.append(o); }
    lineSel.value = [...lineSel.options].some((o) => o.value === want) ? want : "all";
    lineSel.parentNode.hidden = lineSel.options.length < 2;
  }
  function setMode(m) {
    mode = m;
    saveUser({ ...loadUser(), mode: m });
    for (const [k, b] of Object.entries(tabs)) { b.classList.toggle("on", k === m); b.setAttribute("aria-pressed", String(k === m)); }
    echoOpts.hidden = m !== "echo";
    singOpts.hidden = m !== "sing";
    for (const [k, s] of Object.entries(unitSel)) s.parentNode.hidden = k !== m;
    pick(nav && nav.cur ? nav.cur.k0 : player.kAt(player.pos));
  }
  partSel.parentNode.hidden = player.parts.length < 2;
  const soloI = player.parts.findIndex((p) => cfg.tracks[p.id] && cfg.tracks[p.id].solo);
  if (soloI > 0) partSel.value = String(soloI);
  fillLines();
  for (const [k, b] of Object.entries(tabs)) b.onclick = () => { if (!job) setMode(k); };
  partSel.onchange = () => { fillLines(); pick(nav.cur ? nav.cur.k0 : 0); };
  lineSel.onchange = () => pick(nav.cur ? nav.cur.k0 : 0);
  prev.onclick = () => { if (!job && nav.cur) pick(nav.cur.k0, -1); };
  next.onclick = () => { if (!job && nav.cur) pick(nav.cur.k0, 1); };
  // 고른 판정·표시를 기기에 기억
  const remember = () => saveUser({ ...loadUser(), level: levelSel.value, octaveFree: oct.checked, colorblind: cb.checked, hideMarks: hide.checked });
  levelSel.onchange = remember;
  oct.onchange = remember;
  cb.onchange = hide.onchange = () => { remember(); ov.style({ colorblind: cb.checked, hidden: hide.checked }); };
  setMode(mode);
  const calibrate = () => { if (job) return; openCalibrate({ sound, onDone: (ms) => { S.latencyMs = ms; calText(); calNow.hidden = true; } }); };
  calBtn.onclick = calNow.onclick = calibrate;
  if (typeof S.latencyMs !== "number" && !loadUser().calibAsked) {
    saveUser({ ...loadUser(), calibAsked: true });
    setMsg("박자까지 정확히 보려면 '⏱ 박자 보정'을 한 번 해 주세요 (30초). 안 해도 바로 부를 수 있어요 — 그때는 박자를 어림으로 봐요.");
  }

  // 악보에서 마디를 누르면(앱이 재생 위치를 옮긴 뒤) 거기서부터. 하는 중에는 악보를 눌러도 아무 일도 없게 막는다
  const onScoreTap = (e) => {
    if (job) { e.stopPropagation(); e.preventDefault(); return; }
    if (!e.target.closest || !e.target.closest(".mbox")) return;
    setTimeout(() => { if (job || closed) return; pick(player.kAt(player.pos)); }, 0);
  };
  app.score.addEventListener("click", onScoreTap, true);

  const eng = new PitchEngine({ getCtx: () => sound.ensure(), settings: S });
  eng.onError = (err) => { if (job) job.cancelled = true; setMsg(err.message, true); };

  // ---- 하기
  const busyEls = () => [prev, next, partSel, lineSel, accOn, melOn, listenAcc, unitSel.echo, unitSel.sing, ...Object.values(tabs), melBtn, myBtn];
  function begin() {
    clearTimeout(autoTimer);
    if (stopPlayback) { stopPlayback(); stopPlayback = null; }
    job = { cancelled: false };
    for (const el of busyEls()) el.disabled = true;
    go.textContent = "■ 그만";
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
    for (const el of busyEls()) el.disabled = false;
    if (wake) { wake.release().catch(() => {}); wake = null; }
    if (nav.cur) player.pos = nav.cur.from;
    app.refresh();
    app.save();                                                    // 되돌린 재생 설정을 저장
    showRange(msg.classList.contains("err") ? msg.textContent : "");
    if (last) setMsg(last.note, last.err);
    if (last) go.textContent = mode === "echo" ? "● 다시 부르기" : "● 다시 부르기";
    prev.disabled = !nav.hasPrev(); next.disabled = !nav.hasNext();
  }
  const ctlFor = (j) => {
    const r = nav.cur, list = notes();
    const first = list.find((n) => n.start >= r.noteFrom - 1e-6 && n.start < r.noteTo - 1e-6);
    return { player, sound, eng, S, me: player.parts[+partSel.value].id, line: lineSel.value, range: r, list, job: j,
      first: first ? first.midi + (cfg.transpose || 0) : 60, withAcc: accOn.checked, hasAcc, melody: melOn.checked,
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
    const j = begin(), ctl = ctlFor(j), opt = { ...S, level: levelSel.value, octaveFree: oct.checked };
    clearResult();
    try {
      let took = null;
      if (mode === "echo") {
        if (fullEcho && !(await Echo.listen(ctl, listenAcc.checked))) return;
        if (fullEcho) { setMsg("이제 따라 부를 차례예요"); await sleep(S.echoGapSec * 1000); }
        if (j.cancelled) return;
        took = await Echo.sing(ctl);
      } else took = await Sing.sing(ctl);
      if (!took) return;
      const targets = targetsFrom(ctl.list, player.tl, ctl.range.noteFrom, ctl.range.noteTo, { base: took.T(ctl.range.noteFrom), transpose: cfg.transpose || 0, opt });
      show({ ...scoreAll(targets, took.rec ? took.rec.frames : [], opt), opt }, took.rec, ctl.range);
    } catch (err) {
      console.error(err);
      setMsg("하다가 멈췄어요: " + (err && err.message), true);
    } finally {
      const cancelled = j.cancelled;
      end();
      if (cancelled && !last) setMsg("멈췄어요.");
      else if (last && mode === "echo" && autoNext.checked && last.res.summary.accuracy >= S.echoAutoNextPct && nav.hasNext()) {
        setMsg(last.note + ` — 정확 ${last.res.summary.accuracy}%! 잠시 뒤 다음 구간으로 가요.`);
        autoTimer = setTimeout(() => { if (closed || job) return; pick(nav.cur.k0, 1); run(true); }, S.echoAutoNextDelaySec * 1000);
      }
    }
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
  function show(res, rec, range) {
    const s = res.summary;
    sum.textContent = `정확 ${s.accuracy}% — 정확 ${s.ok} · 틀림 ${s.wrong} · 인식 안 됨 ${s.missed} (음표 ${s.total}개)`
      + ` · 박자: 빠른 음 ${s.early} · 늦은 음 ${s.late}` + (s.latencyGuessed ? " (보정 전 어림)" : "");
    ov.results(res.notes, { partId: player.parts[+partSel.value].id, transpose: cfg.transpose || 0, onTap: tapNote });
    app.scrollTo(range.k0);
    const lagTxt = s.lagMs ? ` · 늦게 들어온 소리 ${(s.lagMs / 1000).toFixed(2)}초를 맞춰서 판정` : "";
    const heard = `마이크가 목소리를 들은 시간 ${Math.round(s.voicedShare * 100)}%` + lagTxt;
    const err = s.voicedShare < 0.3;
    const note = err ? `목소리가 거의 잡히지 않았어요 (${heard}). 폰을 입 가까이 두고, 보관함의 '마이크 테스트'에서 음이 잡히는지 확인해 보세요.`
      : `${heard}. 초록 정확 · 빨강 틀림(옆 글자가 부른 음) · 노랑 박자만 틀림 · 회색 인식 안 됨. 점을 누르면 그 음의 그래프가 나와요.`;
    last = { res, rec, range, note, err, opt: res.opt };
    tools.hidden = false;
    melBtn.hidden = mode !== "echo";
    table.textContent = "";
    const t = h("table"), hr = h("tr");
    for (const c of ["마디", "박", "가사", "목표", "부른 음", "차이", "판정", "박자", "음 잡힘"]) hr.append(h("th", null, c));
    t.append(hr);
    for (const n of res.notes) {
      const tr = h("tr", "v-" + (n.color || n.verdict)), mm = n.ref ? song.measures[n.ref.m] : null;
      const cells = [mm ? mm.n : "", n.ref ? Math.round((n.ref.beat + 1) * 100) / 100 : "", n.ref ? n.ref.lyric : "",
        noteName(n.target) + (n.refs && n.refs.length > 1 ? " (화음 중)" : ""), n.sung ? n.sung.name : "—",
        n.cents === null ? "—" : (n.cents > 0 ? "+" : "") + Math.round(n.cents),
        VERDICT[n.verdict] + (n.dir === "high" ? " ↑" : n.dir === "low" ? " ↓" : ""),
        n.timing && n.timing.verdict ? (n.timing.verdict === "ok" ? "맞음" : (n.timing.offsetMs > 0 ? "+" : "") + (n.timing.offsetMs / 1000).toFixed(2) + "초") : "—",
        Math.round(n.voiced * 100) + "%"];
      for (const c of cells) tr.append(h("td", null, String(c)));
      t.append(tr);
    }
    table.append(t);
  }
  tableBtn.onclick = () => { table.hidden = !table.hidden; tableBtn.textContent = table.hidden ? "표 보기" : "표 닫기"; };
  myBtn.onclick = () => {
    if (!last || !last.rec) return;
    if (stopPlayback) { stopPlayback(); stopPlayback = null; myBtn.textContent = "🎤 내 녹음 듣기"; return; }
    stopPlayback = playRecording(sound, last.rec);
    myBtn.textContent = "■ 그만 듣기";
    const sec = last.rec.audio.length / last.rec.sampleRate;
    setTimeout(() => { stopPlayback = null; myBtn.textContent = "🎤 내 녹음 듣기"; }, sec * 1000 + 200);
  };
  melBtn.onclick = async () => {                                   // 원래 멜로디 다시 듣기 (마이크 없이)
    if (job || !nav.cur) return;
    const j = begin();
    try { await Echo.listen(ctlFor(j), listenAcc.checked); } finally { end(); }
  };
  go.onclick = () => run(mode === "echo" && !(last && last.range === nav.cur));

  function shut() {
    if (closed) return;
    closed = true;
    clearTimeout(autoTimer);
    closeNotePopup();
    if (job) { job.cancelled = true; player.pause(); if (job.restore) job.restore(); }      // 앱이 곡을 닫으며 저장하기 전에 되돌린다
    if (stopPlayback) stopPlayback();
    eng.stop();
    ov.clear();
    document.removeEventListener("visibilitychange", onHide);
    app.score.removeEventListener("click", onScoreTap, true);
    app.back.removeEventListener("click", shut, true);
    app.practice.classList.remove("sing-on");
    panel.remove();
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
