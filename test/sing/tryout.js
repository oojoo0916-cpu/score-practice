// 노래 채점: 불러보기 화면. 지금 위치(또는 구간 반복 구간)부터 몇 마디를 불러 보면 음표마다 판정을 표로 보여 준다.
// 흐름: 시작 → 첫 음을 한 번 들려줌 → 카운트인 한 마디 → 부르기(앱 소리 없음) → 표.
// 고른 곳에 노래가 없으면(전주·간주) 노래가 나오는 마디로 저절로 옮긴다.
// 앱의 재생기(player)는 읽기만 한다: 박 ↔ 초 지도(player.tl, ♩= 가 반영된 것), 성부로 나눈 음(player.vl), 키 옮기기(cfg.transpose), 구간 반복(cfg.loop).
import { PitchEngine, MicError } from "./pitch-engine.js";
import { targetsFrom, scoreAll } from "./scoring.js";
import { current } from "./settings.js";
import { loadCss } from "./tuner.js";
import { beatPlan, meterKind } from "../music.js";
import { noteName } from "../edits.js";

const h = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
const VERDICT = { ok: "정확", wrong: "틀림", missed: "인식 안 됨" };
const LINES = { all: "전체", top: "위", mid: "가운데", bottom: "아래" };
const EPS = 1e-6;

export async function openTryout({ sound, player }) {
  await loadCss();
  const S = { ...current() };
  const song = player.song, cfg = player.cfg, K = player.starts.length;
  const root = h("section", "sing-screen sing-try");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "불러보기");
  const head = h("header", "sing-head");
  const close = h("button", "icon sing-close", "✕");
  close.setAttribute("aria-label", "불러보기 닫기");
  head.append(h("b", null, "🎤 불러보기"), close);

  if (!player.parts.length) {
    root.append(head, h("p", "sing-msg err", "이 악보에는 노래 줄이 없어서 불러보기를 할 수 없어요."));
    document.body.append(root);
    close.onclick = () => root.remove();
    return;
  }

  const sel = (parent, label, items, val) => {
    const l = h("label", "sing-sel"), s = h("select");
    for (const [v, t] of items) { const o = h("option", null, t); o.value = v; s.append(o); }
    s.value = val;
    l.append(h("span", null, label), s);
    parent.append(l);
    return s;
  };

  // ---- 구간: [◀] 3마디 ~ 6마디 [▶] [4마디 ▾]
  const rangeRow = h("div", "sing-range");
  const prev = h("button", "btn sm", "◀"), next = h("button", "btn sm", "▶");
  prev.setAttribute("aria-label", "앞 구간");
  next.setAttribute("aria-label", "다음 구간");
  const rangeText = h("b", "sing-rangetext");
  rangeRow.append(prev, rangeText, next);
  const lenItems = S.tryLengths.map((n) => [String(n), n + "마디"]);
  if (cfg.loop) lenItems.unshift(["loop", "구간 반복"]);
  const lenSel = sel(rangeRow, "", lenItems, cfg.loop ? "loop" : String(S.tryMeasures));
  lenSel.setAttribute("aria-label", "몇 마디씩 부를지");

  // ---- 고르기: 노래 줄 · 성부 (고를 것이 하나뿐이면 숨긴다)
  const opts = h("div", "sing-opts");
  const partSel = sel(opts, "노래 줄", player.parts.map((p, i) => [String(i), p.name]), "0");
  const lineSel = sel(opts, "성부", [], "all");
  // ---- 판정 설정 (접어 둔다. 이 화면 안에서만 쓰고 저장하지 않는다)
  const more = h("details", "sing-more");
  more.append(h("summary", null, "판정 설정"));
  const moreBox = h("div", "sing-opts");
  more.append(moreBox);
  const levelSel = sel(moreBox, "난이도", Object.entries(S.levels).map(([k, v]) => [k, `${v.name} ±${v.cents}센트`]), S.level);
  const octL = h("label", "chk sing-chk"), oct = h("input");
  oct.type = "checkbox"; oct.checked = !!S.octaveFree;
  octL.append(oct, h("span", null, "옥타브 무시"));
  moreBox.append(octL);

  const info = h("p", "small sing-info", "");
  const big = h("div", "sing-big", "준비");
  const msg = h("p", "sing-msg", "");
  const btn = h("button", "btn primary sing-start", "시작");
  const sum = h("p", "sing-sum");
  const table = h("div", "sing-table");
  root.append(head, rangeRow, opts, more, info, big, msg, btn, sum, table);
  document.body.append(root);

  // ---- 구간 계산 (연주 순서의 마디 번호 k)
  let k0 = cfg.loop ? Math.min(cfg.loop[0], cfg.loop[1]) : player.kAt(player.pos);
  const length = () => (lenSel.value === "loop" && cfg.loop ? Math.abs(cfg.loop[1] - cfg.loop[0]) + 1 : +lenSel.value || S.tryMeasures);
  const beatOfK = (k) => (k < K ? player.starts[k] : player.totalBeats);
  const kEnd = () => Math.min(K, k0 + length());
  const notes = () => {
    const i = +partSel.value, line = lineSel.value;
    return line === "all" ? player.vl[i].all : player.vl[i].lines[line] || [];
  };
  const hasNotes = (a, b) => notes().some((n) => n.start >= beatOfK(a) - EPS && n.start < beatOfK(b) - EPS);
  // 고른 곳에 노래가 없으면 dir 쪽으로 노래가 나오는 구간을 찾는다. 끝까지 없으면 반대쪽
  function findSinging(dir) {
    if (hasNotes(k0, kEnd())) return "";
    const from = k0;
    for (let k = k0; k >= 0 && k < K; k += dir) if (hasNotes(k, k + 1)) { k0 = dir > 0 ? k : Math.max(0, k - length() + 1); return `노래가 없는 곳(전주·간주)이라 ${measureN(k)}마디부터 불러요.`; }
    for (let k = from; k >= 0 && k < K; k -= dir) if (hasNotes(k, k + 1)) { k0 = k; return `${measureN(k)}마디부터 불러요.`; }
    return "";
  }
  const measureN = (k) => song.measures[song.order[Math.min(K - 1, k)]].n;
  function showRange(note = "") {
    const a = measureN(k0), b = measureN(kEnd() - 1);
    rangeText.textContent = a === b ? `${a}마디` : `${a} ~ ${b}마디`;
    prev.disabled = !hasNotes(0, k0);                 // 앞(뒤)에 노래가 없으면 갈 곳이 없다
    next.disabled = !hasNotes(kEnd(), K);
    const bpm = Math.round(song.measures[song.order[k0]].bpm * cfg.ratio);
    info.textContent = `♩=${bpm}` + (cfg.transpose ? ` · 키 ${cfg.transpose > 0 ? "+" : ""}${cfg.transpose}` : "")
      + " · 첫 음을 한 번 들려주고 한 마디를 센 다음 부르기 시작해요. 부르는 동안 앱 소리는 나지 않아요.";
    setMsg(note || (hasNotes(k0, kEnd()) ? "'시작'을 누르세요. 처음에는 마이크를 써도 되는지 묻는 창이 떠요 — '허용'을 눌러 주세요." : "이 곡에는 고른 노래 줄의 음이 없어요."), !hasNotes(k0, kEnd()));
  }
  function fillLines() {
    const i = +partSel.value, has = player.vl[i].has, want = (cfg.tracks[player.parts[i].id] || {}).line || "all";
    lineSel.textContent = "";
    for (const v of ["all", "top", "mid", "bottom"]) if (v === "all" || has[v]) { const o = h("option", null, LINES[v]); o.value = v; lineSel.append(o); }
    lineSel.value = [...lineSel.options].some((o) => o.value === want) ? want : "all";
    lineSel.parentNode.hidden = lineSel.options.length < 2;
  }
  partSel.parentNode.hidden = player.parts.length < 2;
  // 처음 고른 노래 줄: 파트·반주에서 혼자 듣기(solo)로 고른 줄이 있으면 그 줄
  const soloI = player.parts.findIndex((p) => cfg.tracks[p.id] && cfg.tracks[p.id].solo);
  if (soloI > 0) partSel.value = String(soloI);
  fillLines();
  showRange(findSinging(1));
  partSel.onchange = () => { fillLines(); showRange(findSinging(1)); };
  lineSel.onchange = () => showRange(findSinging(1));
  lenSel.onchange = () => showRange(findSinging(1));
  prev.onclick = () => { if (run) return; k0 = Math.max(0, k0 - length()); showRange(findSinging(-1)); clearResult(); };
  next.onclick = () => { if (run) return; k0 = Math.min(K - 1, k0 + length()); showRange(findSinging(1)); clearResult(); };

  const eng = new PitchEngine({ getCtx: () => sound.ensure(), settings: S });
  let run = null, closed = false;
  function setMsg(t, err = false) { msg.textContent = t; msg.classList.toggle("err", err); }
  function clearResult() { sum.textContent = ""; table.textContent = ""; big.textContent = "준비"; }
  eng.onError = (err) => { stopRun(); setMsg(err.message, true); };

  function stopRun() {
    if (!run) return;
    clearInterval(run.timer);
    sound.silence();
    run = null;
    btn.textContent = "시작";
    for (const el of [prev, next, lenSel, partSel, lineSel]) el.disabled = false;
    showRange();
  }

  async function start() {
    if (run) { stopRun(); eng.stopRecord(); big.textContent = "준비"; setMsg("멈췄어요."); return; }
    btn.disabled = true;
    try {
      await eng.start();
    } catch (err) {
      setMsg(err instanceof MicError ? err.message : "마이크를 켜지 못했어요: " + (err && err.message), true);
      return;
    } finally { btn.disabled = false; }
    if (closed) { eng.stop(); return; }
    const opt = { ...S, level: levelSel.value, octaveFree: oct.checked };
    const list = notes();
    const from = beatOfK(k0), to = beatOfK(kEnd());
    const tl = player.tl;
    const first = list.find((n) => n.start >= from - EPS && n.start < to - EPS);
    if (!first) { setMsg("이 구간에는 고른 줄의 음이 없어요. ◀ ▶ 로 다른 구간을 골라 주세요.", true); return; }

    const ctx = sound.ensure();
    sound.silence();
    sound.track("count").gain.value = 0.8;
    sound.track("singref").gain.value = 0.9;
    const now = ctx.currentTime + 0.15;
    sound.note("singref", first.midi + (cfg.transpose || 0), now, S.tryPrimeSec, 0.8);
    const countAt = now + S.tryPrimeSec + 0.35;
    const m = song.measures[song.order[k0]];
    const q = 60 / (m.bpm * cfg.ratio);
    const full = meterKind(m.meter) === "unknown" ? m.len : m.meter[0] * 4 / m.meter[1];
    const clicks = beatPlan({ meter: m.meter, len: full }, { sub: cfg.sub, groups: cfg.groups });
    for (const x of clicks) sound.click(countAt + x.b * q, x.level, "count");
    const T0 = countAt + full * q;                               // 이때가 구간의 첫 박
    const span = tl.secOf(to) - tl.secOf(from);
    const end = T0 + span + S.tryTailSec;
    eng.startRecord();
    btn.textContent = "그만";
    for (const el of [prev, next, lenSel, partSel, lineSel]) el.disabled = true;
    clearResult();
    setMsg("");
    run = { timer: 0 };
    const mainBeats = clicks.filter((x) => x.main);
    run.timer = setInterval(() => {
      const t = ctx.currentTime;
      if (t < countAt) { big.textContent = "첫 음 ♪"; return; }
      if (t < T0) {
        const b = (t - countAt) / q, n = mainBeats.filter((x) => x.b <= b + EPS).length;
        big.textContent = String(Math.max(1, n));
        return;
      }
      if (t < end) {
        const beat = tl.beatOf(tl.secOf(from) + Math.min(span, t - T0)), k = player.kAt(beat);
        big.textContent = `● 부르는 중 — ${measureN(k)}마디 ${Math.floor(beat - player.starts[k] + EPS) + 1}박`;
        return;
      }
      stopRun();
      const rec = eng.stopRecord();
      const targets = targetsFrom(list, tl, from, to, { base: T0, transpose: cfg.transpose || 0, opt });
      show(scoreAll(targets, rec ? rec.frames : [], opt), rec);
    }, 50);
  }

  function show(res, rec) {
    const s = res.summary;
    big.textContent = `정확 ${s.accuracy}%`;
    sum.textContent = `음표 ${s.total}개 — 정확 ${s.ok} · 틀림 ${s.wrong} (높음 ${s.high}, 낮음 ${s.low}) · 인식 안 됨 ${s.missed}`
      + ` · 난이도 ±${s.tolerance}센트` + (s.octaveFree ? " · 옥타브 무시" : "");
    const voicedAll = rec && rec.frames.length ? rec.frames.filter((f) => f.hz > 0).length / rec.frames.length : 0;
    setMsg(voicedAll < 0.1 ? "목소리가 거의 잡히지 않았어요. 보관함의 '마이크 테스트'에서 음이 잡히는지 먼저 확인해 보세요."
      : "다시 부르려면 '시작', 다음 구간은 ▶ 를 누르세요.");
    const t = h("table");
    const hr = h("tr");
    for (const c of ["마디", "박", "가사", "목표", "부른 음", "차이", "판정", "음 잡힘"]) hr.append(h("th", null, c));
    t.append(hr);
    for (const n of res.notes) {
      const tr = h("tr", "v-" + n.verdict);
      const mm = n.ref ? song.measures[n.ref.m] : null;
      const cells = [mm ? mm.n : "", n.ref ? Math.round((n.ref.beat + 1) * 100) / 100 : "", n.ref ? n.ref.lyric : "",
        noteName(n.target) + (n.refs && n.refs.length > 1 ? " (화음 중)" : ""),
        n.sung ? n.sung.name : "—", n.cents === null ? "—" : (n.cents > 0 ? "+" : "") + Math.round(n.cents),
        VERDICT[n.verdict] + (n.dir === "high" ? " ↑" : n.dir === "low" ? " ↓" : ""), Math.round(n.voiced * 100) + "%"];
      for (const c of cells) tr.append(h("td", null, String(c)));
      t.append(tr);
    }
    table.append(t);
  }

  function shut() {
    closed = true;
    stopRun();
    eng.stop();
    document.removeEventListener("visibilitychange", onHide);
    root.remove();
  }
  function onHide() { if (document.hidden && eng.running) { stopRun(); eng.stop(); big.textContent = "준비"; setMsg("화면을 벗어나서 마이크를 껐어요. 다시 '시작'을 눌러 주세요."); } }
  document.addEventListener("visibilitychange", onHide);
  btn.onclick = start;
  close.onclick = shut;
  return { close: shut, engine: eng, root };
}
