// 노래 채점 2단계: 채점 코어. 악보의 음표(목표)와 마이크 음높이 기록을 견줘 음표마다 판정한다. 화면·마이크와 무관한 순수 계산.
//
// 목표 음 하나: { midi, t0, t1 (초 — 음높이 기록과 같은 시계), alts?: [같이 시작하는 화음의 다른 음들], ref?: 악보 자리 }
//   붙임줄로 이어진 음은 이미 하나의 긴 음이다(music.js 의 voiceLines/mergedNotes). 쉼표는 목표가 아니다(채점하지 않는다).
// 음높이 기록: pitch-engine.js 의 { t, pitch (소수 음높이, 음이 없으면 null) }
//
// 음표 하나의 결과:
//   verdict  "ok" 정확 | "wrong" 틀림 | "missed" 인식 안 됨 (음이 잡힌 시간이 모자람)
//   dir      틀림일 때 "high" 높음 | "low" 낮음
//   cents    중심 음과 목표 음의 차이(센트, 옥타브 무시면 가장 가까운 옥타브로 옮겨서). 인식 안 됨이면 null
//   sung     실제로 부른 중심 음 { pitch, midi, name } (옮기기 전 그대로)
//   shown    악보 위에 덧그릴 높이 (옥타브 무시면 목표와 가장 가까운 옥타브로 옮긴 음높이, 4단계)
//   target   판정에 쓴 목표 음(화음이면 가장 가까운 음)
//   voiced   판정 구간 중 음이 잡힌 비율 (0~1)
//   judged   [판정 구간 시작, 끝] (초)
//   trace    음표 앞뒤 여유까지의 기록 [{ t, c: 목표 음에서 몇 센트(음 없으면 null), in: 허용 범위 안인가, skip: "pre"|"attack"|"release"|"post"|null }] (5단계 그래프)
//   timing   박자 판정 자리 (6단계에서 채운다): { onset, offsetMs, verdict }
import { SING } from "./settings.js";
import { noteName } from "../edits.js";

const median = (a) => { const s = a.slice().sort((x, y) => x - y), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const r1 = (x) => Math.round(x * 10) / 10;

// 판정 난이도 → 허용 센트
export const tolerance = (opt = SING) => (opt.levels[opt.level] || opt.levels.normal).cents;

// 연주 순서로 펼친 음(music.js 의 voiceLines(...).all 또는 .lines.top 등) 가운데 [fromBeat, toBeat) 에서 시작하는 음 → 목표 음 목록.
// tl: 박 ↔ 초 지도(player.tl — ♩= 빠르기, rit., 페르마타가 반영된 것). base: fromBeat 가 소리 시계로 몇 초인지.
// transpose: 키를 옮겨 듣고 있으면 그만큼 옮긴 음이 목표다. 구간 끝을 넘는 음은 끝에서 자른다.
export function targetsFrom(notes, tl, fromBeat, toBeat, { base = 0, transpose = 0, opt = SING } = {}) {
  const s0 = tl.secOf(fromBeat), sEnd = tl.secOf(toBeat), eps = 1e-6;
  const pick = notes.filter((n) => n.start >= fromBeat - eps && n.start < toBeat - eps).sort((a, b) => a.start - b.start || b.midi - a.midi);
  const out = [];
  for (const n of pick) {
    const t0 = base + tl.secOf(n.start) - s0, t1 = base + Math.min(tl.secOf(n.start + n.dur), sEnd) - s0;
    const ref = { m: n.m, k: n.k, beat: n.beat, start: n.start, dur: n.dur, lyric: n.lyric || "", heads: n.heads || [] };
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.t0 - t0) * 1000 <= opt.sameStartMs) {      // 같이 시작하는 화음: 그중 하나를 부르면 된다
      prev.alts.push(n.midi + transpose);
      prev.refs.push(ref);
      prev.t1 = Math.max(prev.t1, t1);
      continue;
    }
    out.push({ midi: n.midi + transpose, t0, t1, alts: [n.midi + transpose], ref, refs: [ref] });
  }
  // 앞 음이 끝나기 전에 다음 음이 시작하면(성부가 겹치는 곳) 다음 음이 시작할 때까지만 판정한다 — 부르는 사람은 다음 음으로 넘어갔다
  for (let i = 0; i + 1 < out.length; i++) if (out[i].t1 > out[i + 1].t0) out[i].t1 = out[i + 1].t0;
  return out.filter((x) => x.t1 > x.t0);
}

// 목표 음 하나 판정
export function scoreNote(target, frames, opt = SING) {
  const tol = tolerance(opt);
  const dur = target.t1 - target.t0;
  const attack = Math.min(opt.attackIgnoreMs / 1000, dur * opt.attackMaxShare);
  const release = Math.min(opt.releaseIgnoreMs / 1000, dur * opt.attackMaxShare);
  const j0 = target.t0 + attack, j1 = target.t1 - release;
  const inJ = frames.filter((f) => f.t >= j0 && f.t < j1);
  const got = inJ.filter((f) => f.pitch !== null && f.pitch !== undefined);
  const voiced = inJ.length ? got.length / inJ.length : 0;
  const alts = target.alts && target.alts.length ? target.alts : [target.midi];
  const res = { midi: target.midi, t0: target.t0, t1: target.t1, ref: target.ref, refs: target.refs, verdict: "missed", dir: null, cents: null,
    sung: null, shown: null, target: target.midi, voiced: r1(voiced * 100) / 100, judged: [j0, j1], trace: [], timing: { onset: null, offsetMs: null, verdict: null } };
  let shift = 0;                                           // 옥타브 무시: 부른 음을 몇 옥타브 옮겨서 견줬는지
  if (got.length && voiced >= opt.minVoicedShare) {
    const center = median(got.map((f) => f.pitch));       // 중심 음 (비브라토가 있어도 가운데)
    // 화음이면 가장 가까운 음이 목표
    const dist = (m) => { let d = center - m; if (opt.octaveFree) d -= 12 * Math.round(d / 12); return Math.abs(d); };
    const goal = alts.reduce((a, b) => (dist(b) < dist(a) ? b : a), alts[0]);
    let d = center - goal;
    if (opt.octaveFree) { shift = Math.round(d / 12); d -= 12 * shift; }
    res.target = goal;
    res.cents = r1(d * 100);
    res.sung = { pitch: Math.round(center * 1000) / 1000, midi: Math.round(center), name: noteName(Math.round(center)) };
    res.shown = Math.round((center - 12 * shift) * 1000) / 1000;
    if (Math.abs(res.cents) <= tol) res.verdict = "ok";
    else { res.verdict = "wrong"; res.dir = res.cents > 0 ? "high" : "low"; }
  }
  // 그래프용 기록: 음표 앞뒤 여유까지
  const m = opt.traceMarginMs / 1000;
  for (const f of frames) {
    if (f.t < target.t0 - m || f.t >= target.t1 + m) continue;
    const has = f.pitch !== null && f.pitch !== undefined;
    let c = null;
    if (has) {
      let d = f.pitch - res.target - 12 * shift;
      if (opt.octaveFree && Math.abs(d) > 6) d -= 12 * Math.round(d / 12);      // 옥타브가 한 번 튄 값도 같은 자리에
      c = r1(d * 100);
    }
    const skip = f.t < target.t0 ? "pre" : f.t < j0 ? "attack" : f.t >= target.t1 ? "post" : f.t >= j1 ? "release" : null;
    res.trace.push({ t: f.t, c, in: c !== null && Math.abs(c) <= tol, skip });
  }
  return res;
}

// 목표 음 여러 개 → 음표별 결과 + 요약 { total, ok, wrong, missed, high, low, accuracy: 정확 % (0~100, 인식 안 됨도 분모에 넣는다) }
export function scoreAll(targets, frames, opt = SING) {
  const fr = frames.slice().sort((a, b) => a.t - b.t);
  const notes = targets.map((t) => scoreNote(t, fr, opt));
  const count = (v) => notes.filter((n) => n.verdict === v).length;
  const total = notes.length, ok = count("ok");
  return {
    notes,
    summary: { total, ok, wrong: count("wrong"), missed: count("missed"), high: notes.filter((n) => n.dir === "high").length,
      low: notes.filter((n) => n.dir === "low").length, accuracy: total ? Math.round(ok / total * 100) : 0, level: opt.level, tolerance: tolerance(opt), octaveFree: !!opt.octaveFree },
  };
}
