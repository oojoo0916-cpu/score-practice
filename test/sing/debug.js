// 노래 채점 2단계: 채점 시험 화면. 악보의 첫 몇 마디를 불러 보면 음표마다 판정을 표로 보여 준다 (채점 코어를 폰에서 확인하는 용도).
// 흐름: 시작 → 첫 음을 한 번 들려줌 → 카운트인 한 마디 → 부르기(앱 소리 없음) → 표.
// 앱의 재생기(player)는 읽기만 한다: 박 ↔ 초 지도(player.tl, ♩= 가 반영된 것), 성부로 나눈 음(player.vl), 키 옮기기(cfg.transpose).
import { PitchEngine, MicError } from "./pitch-engine.js";
import { targetsFrom, scoreAll } from "./scoring.js";
import { current } from "./settings.js";
import { loadCss } from "./tuner.js";
import { beatPlan, meterKind } from "../music.js";
import { noteName } from "../edits.js";

const h = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
const VERDICT = { ok: "정확", wrong: "틀림", missed: "인식 안 됨" };
const LINES = { all: "전체", top: "위", mid: "가운데", bottom: "아래" };

export async function openDebug({ sound, player }) {
  await loadCss();
  const S = { ...current() };
  const song = player.song, cfg = player.cfg;
  const root = h("section", "sing-screen sing-debug");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "채점 시험");
  const head = h("header", "sing-head");
  const close = h("button", "icon sing-close", "✕");
  close.setAttribute("aria-label", "채점 시험 닫기");
  head.append(h("b", null, `채점 시험 — 악보 처음 ${S.debugMeasures}마디`), close);

  if (!player.parts.length) {
    root.append(head, h("p", "sing-msg err", "이 악보에는 노래 줄이 없어서 채점할 수 없어요."));
    document.body.append(root);
    close.onclick = () => root.remove();
    return;
  }

  // 고르기: 노래 줄 · 성부 · 난이도 · 옥타브 무시 (이 화면 안에서만, 저장하지 않는다)
  const opts = h("div", "sing-opts");
  const sel = (label, items, val) => {
    const l = h("label", "sing-sel"), s = h("select");
    for (const [v, t] of items) { const o = h("option", null, t); o.value = v; s.append(o); }
    s.value = val;
    l.append(h("span", null, label), s);
    opts.append(l);
    return s;
  };
  const partSel = sel("노래 줄", player.parts.map((p, i) => [String(i), p.name]), "0");
  const lineSel = sel("성부", [], "all");
  const fillLines = () => {
    const i = +partSel.value, has = player.vl[i].has, want = (cfg.tracks[player.parts[i].id] || {}).line || "all";
    lineSel.textContent = "";
    for (const v of ["all", "top", "mid", "bottom"]) if (v === "all" || has[v]) { const o = h("option", null, LINES[v]); o.value = v; lineSel.append(o); }
    lineSel.value = [...lineSel.options].some((o) => o.value === want) ? want : "all";
  };
  fillLines();
  partSel.onchange = fillLines;
  const levelSel = sel("난이도", Object.entries(S.levels).map(([k, v]) => [k, `${v.name} ±${v.cents}센트`]), S.level);
  const octL = h("label", "chk sing-chk"), oct = h("input");
  oct.type = "checkbox"; oct.checked = !!S.octaveFree;
  octL.append(oct, h("span", null, "옥타브 무시"));
  opts.append(octL);

  const bpm = Math.round(player.bpmHere() || song.measures[song.order[0]].bpm);
  const info = h("p", "small sing-info", `♩=${bpm}` + (cfg.transpose ? ` · 키 ${cfg.transpose > 0 ? "+" : ""}${cfg.transpose}` : "") + " · 처음에 첫 음을 한 번 들려주고, 한 마디를 세고 나서 부르기 시작해요. 부르는 동안 앱 소리는 나지 않아요.");
  const big = h("div", "sing-big", "준비");
  const msg = h("p", "sing-msg", "'시작'을 누르세요. 처음에는 마이크를 써도 되는지 묻는 창이 떠요 — '허용'을 눌러 주세요.");
  const btn = h("button", "btn primary sing-start", "시작");
  const sum = h("p", "sing-sum");
  const table = h("div", "sing-table");
  root.append(head, opts, info, big, msg, btn, sum, table);
  document.body.append(root);

  const eng = new PitchEngine({ getCtx: () => sound.ensure(), settings: S });
  let run = null, closed = false;
  const setMsg = (t, err = false) => { msg.textContent = t; msg.classList.toggle("err", err); };
  eng.onError = (err) => { stopRun(); setMsg(err.message, true); };

  function stopRun() {
    if (!run) return;
    clearInterval(run.timer);
    sound.silence();
    run = null;
    btn.textContent = "시작";
  }

  async function start() {
    if (run) { stopRun(); eng.stopRecord(); big.textContent = "준비"; setMsg("멈췄어요."); return; }
    btn.disabled = true;
    try {
      await eng.start();
    } catch (err) {
      btn.disabled = false;
      setMsg(err instanceof MicError ? err.message : "마이크를 켜지 못했어요: " + (err && err.message), true);
      return;
    } finally { btn.disabled = false; }
    if (closed) { eng.stop(); return; }
    const opt = { ...S, level: levelSel.value, octaveFree: oct.checked };
    const i = +partSel.value, line = lineSel.value;
    const notes = line === "all" ? player.vl[i].all : player.vl[i].lines[line] || [];
    const kEnd = Math.min(S.debugMeasures, player.starts.length);
    const from = player.starts[0], to = kEnd < player.starts.length ? player.starts[kEnd] : player.totalBeats;
    const tl = player.tl;
    const first = notes.find((n) => n.start >= from - 1e-6 && n.start < to - 1e-6);
    if (!first) { setMsg("이 구간에는 고른 줄의 음이 없어요. 다른 노래 줄이나 성부를 골라 주세요.", true); return; }

    const ctx = sound.ensure();
    sound.silence();
    sound.track("count").gain.value = 0.8;
    sound.track("singref").gain.value = 0.9;
    const now = ctx.currentTime + 0.15;
    sound.note("singref", first.midi + (cfg.transpose || 0), now, S.debugPrimeSec, 0.8);
    const countAt = now + S.debugPrimeSec + 0.35;
    const m = song.measures[song.order[0]];
    const q = 60 / (m.bpm * cfg.ratio);
    const full = meterKind(m.meter) === "unknown" ? m.len : m.meter[0] * 4 / m.meter[1];
    const clicks = beatPlan({ meter: m.meter, len: full }, { sub: cfg.sub, groups: cfg.groups });
    for (const x of clicks) sound.click(countAt + x.b * q, x.level, "count");
    const T0 = countAt + full * q;                               // 이때가 악보의 첫 박
    const span = tl.secOf(to) - tl.secOf(from);
    const end = T0 + span + S.debugTailSec;
    eng.startRecord();
    btn.textContent = "그만";
    sum.textContent = ""; table.textContent = "";
    setMsg("");
    run = { timer: 0 };
    const mainBeats = clicks.filter((x) => x.main);
    run.timer = setInterval(() => {
      const t = ctx.currentTime;
      if (t < countAt) { big.textContent = "첫 음 ♪"; return; }
      if (t < T0) {
        const b = (t - countAt) / q, n = mainBeats.filter((x) => x.b <= b + 1e-6).length;
        big.textContent = String(Math.max(1, n));
        return;
      }
      if (t < end) {
        const beat = tl.beatOf(tl.secOf(from) + Math.min(span, t - T0)), k = player.kAt(beat);
        const mm = song.measures[song.order[k]];
        big.textContent = `● 부르는 중 — ${mm.n}마디 ${Math.floor(beat - player.starts[k] + 1e-6) + 1}박`;
        return;
      }
      stopRun();
      const rec = eng.stopRecord();
      const targets = targetsFrom(notes, tl, from, to, { base: T0, transpose: cfg.transpose || 0, opt });
      show(scoreAll(targets, rec ? rec.frames : [], opt), rec);
    }, 50);
  }

  function show(res, rec) {
    const s = res.summary;
    big.textContent = `정확 ${s.accuracy}%`;
    sum.textContent = `음표 ${s.total}개 — 정확 ${s.ok} · 틀림 ${s.wrong} (높음 ${s.high}, 낮음 ${s.low}) · 인식 안 됨 ${s.missed}`
      + ` · 난이도 ±${s.tolerance}센트` + (s.octaveFree ? " · 옥타브 무시" : "");
    const voicedAll = rec && rec.frames.length ? rec.frames.filter((f) => f.hz > 0).length / rec.frames.length : 0;
    setMsg(voicedAll < 0.1 ? "목소리가 거의 잡히지 않았어요. 마이크 테스트에서 음이 잡히는지 먼저 확인해 보세요." : "다시 하려면 '시작'을 누르세요.");
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
