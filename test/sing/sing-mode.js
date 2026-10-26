// 노래 채점: 부르기 화면. 악보를 그대로 보여 준 채 아래 조작판만 바뀐다.
// 부를 구간을 악보 위에 칠하고 → 카운트인 → 반주(고른 노래 줄만 끈다)를 틀면서 녹음 → 끝나면 음표 머리마다 판정을 칠한다.
// 재생은 앱의 재생기(player)를 그대로 쓴다(빠르기·키·세로줄·자동 넘김이 평소와 같다). 바꾼 설정(트랙 소리·카운트인·구간 반복·메트로놈)은 끝나면 되돌린다.
// 고른 곳에 노래가 없으면(전주·간주) 노래가 나오는 마디로 저절로 옮긴다. 악보에서 마디를 누르면 거기서부터.
import { PitchEngine, MicError } from "./pitch-engine.js";
import { targetsFrom, scoreAll } from "./scoring.js";
import { current } from "./settings.js";
import { loadCss } from "./tuner.js";
import { Overlay } from "./overlay.js";
import { noteName } from "../edits.js";

const h = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
const VERDICT = { ok: "정확", wrong: "틀림", missed: "인식 안 됨" };
const LINES = { all: "전체", top: "위", mid: "가운데", bottom: "아래" };
const EPS = 1e-6;

// app: { sound, player, pages, boxes, score, practice, dock, back, scrollTo(k), refresh(), save() } — 앱(app.js)이 넘겨준다
export async function openSing(app) {
  await loadCss();
  const S = { ...current() };
  const { sound, player } = app;
  const song = player.song, cfg = player.cfg, K = player.starts.length;
  const ov = new Overlay({ pages: app.pages, boxes: app.boxes, song });
  let run = null, closed = false, last = null, wake = null;     // 부르는 중인 것, 닫혔는지, 마지막 결과, 화면 켜 두기

  const panel = h("section", "sing-panel");
  panel.setAttribute("aria-label", "부르기");
  const close = h("button", "icon sing-close", "✕");
  close.setAttribute("aria-label", "부르기 닫기");
  if (!player.parts.length) {
    panel.append(h("p", "sing-msg err", "이 악보에는 노래 줄이 없어서 부르기를 할 수 없어요."), close);
    app.practice.insertBefore(panel, app.dock);
    close.onclick = () => panel.remove();
    return;
  }
  const sel = (parent, label, items, val) => {
    const l = h("label", "sing-sel"), s = h("select");
    for (const [v, t] of items) { const o = h("option", null, t); o.value = v; s.append(o); }
    s.value = val;
    if (label) l.append(h("span", null, label));
    l.append(s);
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

  // 1줄: [◀] 3 ~ 6마디 [▶] [4마디] [✕]
  const row1 = h("div", "sing-range");
  const prev = h("button", "btn sm", "◀"), next = h("button", "btn sm", "▶");
  prev.setAttribute("aria-label", "앞 구간");
  next.setAttribute("aria-label", "다음 구간");
  const rangeText = h("b", "sing-rangetext");
  row1.append(prev, rangeText, next);
  const lenItems = S.singLengths.map((n) => [String(n), n + "마디"]);
  if (cfg.loop) lenItems.unshift(["loop", "구간 반복"]);
  const lenSel = sel(row1, "", lenItems, cfg.loop ? "loop" : String(S.singMeasures));
  lenSel.setAttribute("aria-label", "몇 마디씩 부를지");
  row1.append(close);
  // 2줄: 반주 · 멜로디 작게 · 노래 줄 · 성부 · 판정 설정
  const row2 = h("div", "sing-opts");
  const hasAcc = player.hasPiano || song.measures.some((m) => m.chords.length);
  const accOn = chk(row2, hasAcc ? "반주" : "메트로놈", true);
  const melOn = chk(row2, "멜로디 작게", false);
  const partSel = sel(row2, "", player.parts.map((p, i) => [String(i), p.name]), "0");
  partSel.setAttribute("aria-label", "부를 노래 줄");
  const lineSel = sel(row2, "", [], "all");
  lineSel.setAttribute("aria-label", "부를 성부");
  const more = h("details", "sing-more");
  more.append(h("summary", null, "판정"));
  const moreBox = h("div", "sing-opts");
  more.append(moreBox);
  const levelSel = sel(moreBox, "", Object.entries(S.levels).map(([k, v]) => [k, `${v.name} ±${v.cents}센트`]), S.level);
  levelSel.setAttribute("aria-label", "판정 난이도");
  const oct = chk(moreBox, "옥타브 무시", !!S.octaveFree);
  row2.append(more);
  // 3줄: [● 시작] 안내
  const row3 = h("div", "sing-go");
  const btn = h("button", "btn primary sing-start", "● 시작");
  const msg = h("p", "sing-msg");
  row3.append(btn, msg);
  // 결과: 요약 + [표 보기]
  const row4 = h("div", "sing-result");
  const sum = h("p", "sing-sum");
  const tableBtn = h("button", "btn sm", "표 보기");
  tableBtn.hidden = true;
  row4.append(sum, tableBtn);
  const table = h("div", "sing-table");
  table.hidden = true;
  panel.append(row1, row2, row3, row4, table);
  app.practice.insertBefore(panel, app.dock);
  app.practice.classList.add("sing-on");

  // ---- 구간 (연주 순서의 마디 번호 k)
  let k0 = cfg.loop ? Math.min(cfg.loop[0], cfg.loop[1]) : player.kAt(player.pos);
  const loopLen = cfg.loop ? Math.abs(cfg.loop[1] - cfg.loop[0]) + 1 : 0;
  const length = () => (lenSel.value === "loop" ? loopLen : +lenSel.value || S.singMeasures);
  const beatOfK = (k) => (k < K ? player.starts[k] : player.totalBeats);
  const kEnd = () => Math.min(K, k0 + length());
  const measureN = (k) => song.measures[song.order[Math.min(K - 1, k)]].n;
  const notes = () => {
    const i = +partSel.value, line = lineSel.value;
    return line === "all" ? player.vl[i].all : player.vl[i].lines[line] || [];
  };
  const hasNotes = (a, b) => notes().some((n) => n.start >= beatOfK(a) - EPS && n.start < beatOfK(b) - EPS);
  function findSinging(dir) {
    if (hasNotes(k0, kEnd())) return "";
    const from = k0;
    for (let k = k0; k >= 0 && k < K; k += dir) if (hasNotes(k, k + 1)) { k0 = dir > 0 ? k : Math.max(0, k - length() + 1); return `노래가 없는 곳(전주·간주)이라 ${measureN(k0)}마디부터 불러요.`; }
    for (let k = from; k >= 0 && k < K; k -= dir) if (hasNotes(k, k + 1)) { k0 = k; return `${measureN(k)}마디부터 불러요.`; }
    return "";
  }
  const READY = () => (hasAcc ? "반주가 나오면 같이 부르세요. 이어폰을 끼면 반주 소리가 마이크에 섞이지 않아 더 정확해요." : "박자 소리에 맞춰 부르세요.")
    + " 악보에서 마디를 누르면 거기서부터 불러요.";
  function showRange(note = "") {
    const a = measureN(k0), b = measureN(kEnd() - 1);
    rangeText.textContent = a === b ? `${a}마디` : `${a} ~ ${b}마디`;
    prev.disabled = !hasNotes(0, k0);
    next.disabled = !hasNotes(kEnd(), K);
    ov.range(k0, kEnd());
    app.scrollTo(k0);
    const ok = hasNotes(k0, kEnd());
    setMsg(note || (ok ? READY() : "이 곡에는 고른 노래 줄의 음이 없어요."), !ok);
  }
  function fillLines() {
    const i = +partSel.value, has = player.vl[i].has, want = (cfg.tracks[player.parts[i].id] || {}).line || "all";
    lineSel.textContent = "";
    for (const v of ["all", "top", "mid", "bottom"]) if (v === "all" || has[v]) { const o = h("option", null, LINES[v] + (v === "all" ? "" : " 성부")); o.value = v; lineSel.append(o); }
    lineSel.value = [...lineSel.options].some((o) => o.value === want) ? want : "all";
    lineSel.parentNode.hidden = lineSel.options.length < 2;
  }
  partSel.parentNode.hidden = player.parts.length < 2;
  const soloI = player.parts.findIndex((p) => cfg.tracks[p.id] && cfg.tracks[p.id].solo);
  if (soloI > 0) partSel.value = String(soloI);
  fillLines();
  const reset = (note) => { clearResult(); showRange(note); };
  reset(findSinging(1));
  partSel.onchange = () => { fillLines(); reset(findSinging(1)); };
  lineSel.onchange = () => reset(findSinging(1));
  lenSel.onchange = () => reset(findSinging(1));
  prev.onclick = () => { k0 = Math.max(0, k0 - length()); reset(findSinging(-1)); };
  next.onclick = () => { k0 = Math.min(K - 1, k0 + length()); reset(findSinging(1)); };
  // 악보에서 마디를 누르면(앱이 재생 위치를 옮긴 뒤) 거기서부터. 부르는 중에는 악보를 눌러도 아무 일도 없게 막는다
  const onScoreTap = (e) => {
    if (run) { e.stopPropagation(); e.preventDefault(); return; }
    if (!e.target.closest || !e.target.closest(".mbox")) return;
    setTimeout(() => { if (run || closed) return; k0 = player.kAt(player.pos); reset(findSinging(1)); }, 0);
  };
  app.score.addEventListener("click", onScoreTap, true);

  const eng = new PitchEngine({ getCtx: () => sound.ensure(), settings: S });
  function setMsg(t, err = false) { msg.textContent = t; msg.classList.toggle("err", err); }
  function clearResult() { sum.textContent = ""; table.textContent = ""; table.hidden = true; tableBtn.hidden = true; ov.clearMarks(); last = null; }
  eng.onError = (err) => { stopRun(); setMsg(err.message, true); };

  // 재생기 설정을 잠시 바꾸고(반주만), 끝나면 되돌린다
  function borrow() {
    const keep = { tracks: JSON.parse(JSON.stringify(cfg.tracks)), countIn: cfg.countIn, loop: cfg.loop, metro: cfg.metro };
    const me = player.parts[+partSel.value].id;
    for (const [id, t] of Object.entries(cfg.tracks)) if (t) t.solo = false;
    for (const p of player.parts) {
      const t = cfg.tracks[p.id] = cfg.tracks[p.id] || { vol: 0.85, mute: false, solo: false };
      if (p.id === me) { t.mute = !melOn.checked; t.vol = S.singMelodyVol; }
    }
    if (!hasAcc) cfg.metro = accOn.checked;                     // 반주가 없는 악보: 메트로놈만
    else if (!accOn.checked) {                                   // 반주를 끄면 박자는 메트로놈으로
      if (cfg.tracks.piano) cfg.tracks.piano.mute = true;
      if (cfg.tracks.chord) cfg.tracks.chord.mute = true;
      cfg.metro = true;
    }
    cfg.countIn = true;
    cfg.loop = null;
    return keep;
  }
  function giveBack(keep) {
    cfg.tracks = keep.tracks; cfg.countIn = keep.countIn; cfg.loop = keep.loop; cfg.metro = keep.metro;
    player.applyMix();
  }

  function stopRun() {
    if (!run) return;
    const r = run;
    run = null;
    clearInterval(r.timer);
    player.pause();
    giveBack(r.keep);
    player.pos = player.starts[k0];
    if (wake) { wake.release().catch(() => {}); wake = null; }
    app.refresh();
    app.save();                                                  // 되돌린 설정을 저장 (부르는 동안 바꾼 소리 설정이 남지 않게)
    btn.textContent = "● 시작";
    for (const el of [prev, next, lenSel, partSel, lineSel, accOn, melOn]) el.disabled = false;
    showRange();
  }

  async function start() {
    if (run) { stopRun(); eng.stopRecord(); setMsg("멈췄어요."); return; }
    btn.disabled = true;
    try {
      await eng.start();
    } catch (err) {
      setMsg(err instanceof MicError ? err.message : "마이크를 켜지 못했어요: " + (err && err.message), true);
      return;
    } finally { btn.disabled = false; }
    if (closed) { eng.stop(); return; }
    const list = notes(), from = beatOfK(k0), to = beatOfK(kEnd());
    const first = list.find((n) => n.start >= from - EPS && n.start < to - EPS);
    if (!first) { setMsg("이 구간에는 고른 줄의 음이 없어요. ◀ ▶ 로 다른 구간을 골라 주세요.", true); return; }
    clearResult();
    const opt = { ...S, level: levelSel.value, octaveFree: oct.checked };
    const ns = song.parts.flatMap((p) => p.notes.map((n) => n.midi + cfg.transpose));
    sound.ensure();
    sound.load(Math.min(36, ...ns), Math.max(72, ...ns));
    const keep = borrow();
    player.pos = from;
    await player.play();
    if (!player.playing) { giveBack(keep); setMsg("재생을 시작하지 못했어요.", true); return; }
    const ctx = sound.ctx, tl = player.tl;
    // 카운트인 첫 박에 첫 음을 짧게 (어디서 시작하는지 귀로 잡게)
    sound.track("singref").gain.value = 0.8;
    sound.note("singref", first.midi + (cfg.transpose || 0), ctx.currentTime + 0.12, S.singPrimeSec, 0.75);
    const T0 = player.start + tl.secOf(from);                    // 구간 첫 박이 울리는 소리 시계
    const span = tl.secOf(to) - tl.secOf(from), end = T0 + span + S.singTailSec;
    eng.startRecord();
    try { wake = await navigator.wakeLock.request("screen"); } catch (e) { /* 지원하지 않는 기기 */ }
    run = { keep, timer: 0, list, from, to, opt, T0 };
    btn.textContent = "■ 그만";
    for (const el of [prev, next, lenSel, partSel, lineSel, accOn, melOn]) el.disabled = true;
    app.refresh();
    run.timer = setInterval(() => {
      if (!run) return;
      const t = ctx.currentTime;
      if (t < T0) { setMsg("준비… 박자를 세고 있어요"); return; }
      if (t < end) { setMsg("● 부르는 중 — " + measureN(player.kAt(player.now())) + "마디"); return; }
      const r = run;
      stopRun();
      const rec = eng.stopRecord();
      const targets = targetsFrom(r.list, tl, r.from, r.to, { base: r.T0, transpose: cfg.transpose || 0, opt: r.opt });
      show(scoreAll(targets, rec ? rec.frames : [], r.opt));
    }, 60);
  }

  function show(res) {
    last = res;
    const s = res.summary;
    sum.textContent = `정확 ${s.accuracy}% — 정확 ${s.ok} · 틀림 ${s.wrong} · 인식 안 됨 ${s.missed} (음표 ${s.total}개)`;
    ov.results(res.notes);
    app.scrollTo(k0);
    const lagTxt = s.lagMs ? ` · 늦게 들어온 소리 ${(s.lagMs / 1000).toFixed(2)}초를 맞춰서 판정` : "";
    const heard = `마이크가 목소리를 들은 시간 ${Math.round(s.voicedShare * 100)}%` + lagTxt;
    setMsg(s.voicedShare < 0.3 ? `목소리가 거의 잡히지 않았어요 (${heard}). 폰을 입 가까이 두고, 보관함의 '마이크 테스트'에서 음이 잡히는지 확인해 보세요.`
      : `${heard}. 초록 정확 · 빨강 틀림(옆 글자가 부른 음) · 회색 인식 안 됨. 다시 하려면 '시작', 다음은 ▶`, s.voicedShare < 0.3);
    tableBtn.hidden = false;
    tableBtn.textContent = "표 보기";
    const t = h("table"), hr = h("tr");
    for (const c of ["마디", "박", "가사", "목표", "부른 음", "차이", "판정", "음 잡힘"]) hr.append(h("th", null, c));
    t.append(hr);
    for (const n of res.notes) {
      const tr = h("tr", "v-" + n.verdict), mm = n.ref ? song.measures[n.ref.m] : null;
      const cells = [mm ? mm.n : "", n.ref ? Math.round((n.ref.beat + 1) * 100) / 100 : "", n.ref ? n.ref.lyric : "",
        noteName(n.target) + (n.refs && n.refs.length > 1 ? " (화음 중)" : ""), n.sung ? n.sung.name : "—",
        n.cents === null ? "—" : (n.cents > 0 ? "+" : "") + Math.round(n.cents),
        VERDICT[n.verdict] + (n.dir === "high" ? " ↑" : n.dir === "low" ? " ↓" : ""), Math.round(n.voiced * 100) + "%"];
      for (const c of cells) tr.append(h("td", null, String(c)));
      t.append(tr);
    }
    table.append(t);
  }
  tableBtn.onclick = () => { table.hidden = !table.hidden; tableBtn.textContent = table.hidden ? "표 보기" : "표 닫기"; };

  function shut() {
    if (closed) return;
    closed = true;
    stopRun();
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
  function onHide() { if (document.hidden && eng.running) { stopRun(); eng.stop(); setMsg("화면을 벗어나서 멈추고 마이크를 껐어요. 다시 '시작'을 눌러 주세요."); } }
  document.addEventListener("visibilitychange", onHide);
  app.back.addEventListener("click", shut, true);          // 앱이 곡을 닫기(저장) 전에 설정부터 되돌린다
  btn.onclick = start;
  close.onclick = shut;
  return { close: shut, engine: eng, panel, result: () => last };
}
