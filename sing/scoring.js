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

// 판정 난이도 → 허용 센트, 박자 허용 ms
export const tolerance = (opt = SING) => (opt.levels[opt.level] || opt.levels.normal).cents;
export const timingTolerance = (opt = SING) => (opt.levels[opt.level] || opt.levels.normal).timingMs;
// 기기 지연(초): 박자 보정으로 잰 값, 없으면 어림값
export const latencyOf = (opt = SING) => ((typeof opt.latencyMs === "number" ? opt.latencyMs : opt.defaultLatencyMs) || 0) / 1000;

// 연주 순서로 펼친 음(music.js 의 voiceLines(...).all 또는 .lines.top 등) 가운데 [fromBeat, toBeat) 에서 시작하는 음 → 목표 음 목록.
// tl: 박 ↔ 초 지도(player.tl — ♩= 빠르기, rit., 페르마타가 반영된 것). base: fromBeat 가 소리 시계로 몇 초인지.
// transpose: 키를 옮겨 듣고 있으면 그만큼 옮긴 음이 목표다. 구간 끝을 넘는 음은 끝에서 자른다.
export function targetsFrom(notes, tl, fromBeat, toBeat, { base = 0, transpose = 0, opt = SING } = {}) {
  const s0 = tl.secOf(fromBeat), sEnd = tl.secOf(toBeat), eps = 1e-6;
  const pick = notes.filter((n) => n.start >= fromBeat - eps && n.start < toBeat - eps).sort((a, b) => a.start - b.start || b.midi - a.midi);
  const out = [];
  for (const n of pick) {
    const t0 = base + tl.secOf(n.start) - s0, t1 = base + Math.min(tl.secOf(n.start + n.dur), sEnd) - s0;
    const ref = { m: n.m, k: n.k, beat: n.beat, start: n.start, dur: n.dur, midi: n.midi + transpose, lyric: n.lyric || "", heads: n.heads || [], fermata: !!n.fermata };
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

// 음표 하나를 쉬운 말로 풀어 보기 (5단계 그래프 팝업): 평균 차이, 끝에서 떨어짐/올라감, 아래에서 긁어 올림
// → { mean: 판정 구간의 평균 센트(없으면 null), drift: "drop" | "rise" | null, driftCents, scoop: 참/거짓 }
export function describeNote(res, opt = SING) {
  const judged = res.trace.filter((f) => f.skip === null && f.c !== null);
  const avg = (a) => a.reduce((s, f) => s + f.c, 0) / a.length;
  const out = { mean: judged.length ? r1(avg(judged)) : null, drift: null, driftCents: null, scoop: false };
  if (judged.length >= 6 && (res.t1 - res.t0) * 1000 >= opt.driftMinMs) {
    const cut = judged[0].t + (judged[judged.length - 1].t - judged[0].t) * 2 / 3;
    const head = judged.filter((f) => f.t < cut), tail = judged.filter((f) => f.t >= cut);
    if (head.length >= 2 && tail.length >= 2) {
      const d = avg(tail) - avg(head);
      out.driftCents = r1(d);
      if (d <= -opt.driftCents) out.drift = "drop";
      else if (d >= opt.driftCents) out.drift = "rise";
    }
  }
  const early = res.trace.filter((f) => f.c !== null && f.t >= res.t0 && f.t < res.t0 + opt.scoopWindowMs / 1000).slice(0, 2);
  if (early.length && judged.length && avg(early) <= -opt.scoopCents && avg(judged) - avg(early) >= opt.scoopCents) out.scoop = true;
  return out;
}

// 부를 음이 있는 동안 목소리가 잡힌 비율 (0~1) — 마이크가 목소리를 얼마나 듣고 있는지 알려 주는 숫자
function inSpan(targets, frames) {
  let all = 0, got = 0;
  for (const f of frames) {
    if (!targets.some((g) => f.t >= g.t0 && f.t < g.t1 + 0.3)) continue;
    all++;
    if (f.pitch !== null && f.pitch !== undefined) got++;
  }
  return all ? Math.round(got / all * 100) / 100 : 0;
}

// 부른 소리가 악보보다 얼마나 늦게(−면 일찍) 들어왔는지 찾는다(초). 폰은 마이크 소리가 0.1~0.3초 늦게 들어오고, 사람도 조금씩 늦게 들어간다.
// 늦음을 바꿔 가며 "그 순간 악보의 음과 같은 음(옥타브 무시)을 내고 있던 시간"이 가장 긴 값을 고른다. 맞는 시간이 너무 적으면 0.
// 박자 판정(6단계)과 별개로, 음정 판정이 늦음 때문에 앞 음을 섞어 보지 않게 하려는 것이다
export function estimateLag(targets, frames, opt = SING) {
  const voiced = frames.filter((f) => f.pitch !== null && f.pitch !== undefined);
  if (!targets.length || voiced.length < 5) return 0;
  const step = opt.lagStepMs / 1000, lo = opt.lagMinMs / 1000, hi = opt.lagMaxMs / 1000;
  const near = (p, m) => { let d = p - m; d -= 12 * Math.round(d / 12); return Math.abs(d) <= 0.5; };
  let best = 0, bestN = -1;
  for (let lag = lo; lag <= hi + 1e-9; lag += step) {
    let n = 0, j = 0;
    for (const f of voiced) {
      const t = f.t - lag;
      while (j < targets.length && targets[j].t1 <= t) j++;
      const g = targets[j];
      if (g && g.t0 <= t && (g.alts || [g.midi]).some((m) => near(f.pitch, m))) n++;
    }
    if (n > bestN || (n === bestN && Math.abs(lag) < Math.abs(best))) { best = lag; bestN = n; }
  }
  return bestN >= opt.lagMinFrames ? Math.round(best * 1000) / 1000 : 0;
}

// ---- 박자 (6단계)
const voicedF = (f) => f.pitch !== null && f.pitch !== undefined;
// 소리가 커지는 순간: 바로 앞 0.1초의 가장 작은 크기보다 opt.onsetRiseDb 이상 커진 첫 순간 (자음으로 시작해도 여기서 잡힌다). frames 는 시각 순서
function rises(frames, opt) {
  const out = [];
  let was = false;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    let mn = Infinity;
    for (let j = i - 1; j >= 0 && frames[j].t >= f.t - 0.1; j--) mn = Math.min(mn, frames[j].db === undefined ? -120 : frames[j].db);
    if (mn === Infinity) mn = -120;
    const up = f.db !== undefined && f.db >= opt.minDb + 6 && f.db - mn >= opt.onsetRiseDb;
    if (up && !was) out.push(i);
    was = up;
  }
  return out;
}

// 음 시작 찾기: [lo, hi] 안에서 expected 에 가장 가까운 "소리가 커지는 순간"(그 뒤 0.15초 안에 목소리가 잡혀야 한다).
// 없으면(이어 부르기 등) 음높이가 목표 음으로 들어온 첫 순간. 둘 다 없으면 null. frames: 지연을 뺀 시각
export function findOnset(frames, target, lo, hi, opt = SING) {
  const near = (p) => (target.alts || [target.midi]).some((m) => { let d = p - m; d -= 12 * Math.round(d / 12); return Math.abs(d) <= opt.onsetNearSemis; });
  let best = null;
  for (const i of rises(frames, opt)) {
    const f = frames[i];
    if (f.t < lo || f.t > hi) continue;
    if (!frames.some((g) => g.t >= f.t && g.t <= f.t + 0.15 && voicedF(g))) continue;
    if (best === null || Math.abs(f.t - target.t0) < Math.abs(best - target.t0)) best = f.t;
  }
  if (best !== null) return { t: best, by: "energy" };
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.t < lo || f.t > hi || !voicedF(f) || !near(f.pitch)) continue;
    const prev = frames[i - 1];
    if (!prev || !voicedF(prev) || !near(prev.pitch) || f.t - prev.t > 0.05) return { t: f.t, by: "pitch" };
  }
  return null;
}

// 음표 하나의 박자: 음 시작이 악보보다 몇 ms 빠르거나 늦은지, 부른 길이. res 를 고친다
export function timeNote(res, target, frames, lo, hi, opt = SING) {
  const tol = timingTolerance(opt);
  if (res.verdict === "missed" || (opt.timingSkipFermata && target.ref && target.ref.fermata)) return res;
  const on = findOnset(frames, target, lo, hi, opt);
  if (!on) return res;
  const offsetMs = Math.round((on.t - target.t0) * 1000);
  const verdict = Math.abs(offsetMs) <= tol ? "ok" : offsetMs < 0 ? "early" : "late";
  // 부른 길이: 음 시작부터 목표 음(옥타브 무시)을 마지막으로 내던 때까지
  const near = (p) => { let d = p - res.target; d -= 12 * Math.round(d / 12); return Math.abs(d) <= 1; };
  let end = on.t;
  for (const f of frames) if (f.t >= on.t && f.t <= target.t1 + 0.2 && voicedF(f) && near(f.pitch)) end = f.t;
  const scoreMs = Math.round((target.t1 - target.t0) * 1000), sungMs = Math.max(0, Math.round((end - on.t) * 1000 + opt.hopMs));
  res.timing = { onset: on.t, by: on.by, offsetMs, verdict, tolMs: tol };
  res.length = { scoreMs, sungMs, short: sungMs < scoreMs * opt.shortShare };
  if (res.verdict === "ok" && verdict !== "ok") res.color = "timing";       // 음정은 맞고 박자만 벗어남 → 노랑
  return res;
}

// ---- 스피커로 반주를 틀 때 (8단계)
// accAt(t): 반주가 울리는 소리 시계 t 에 울리고 있는 반주 음들(midi) → 그 순간의 소리 후보 가운데
//   ① 반주 음(또는 그 2·3·4배, 반 옥타브 아래)과 같은 것은 빼고 ② 목표 음 ±searchSemis 안의 것만 남겨 ③ 가장 또렷한 것을 목소리로 고른다.
//   남는 것이 없으면 "음 없음". 그다음 ④ 짧게 쳤다가 사그라드는 소리(피아노)는 뺀다 — 목소리는 길게 유지된다.
// frames 의 시각은 마이크로 들어온 시각이라, 반주와 견줄 때는 기기 지연을 뺀다
export function speakerFilter(frames, targets, opt = SING) {
  if (!opt.accAt) return frames;
  const lat = latencyOf(opt);
  const ks = [0.5, 1, 2, 3, 4].map((k) => 12 * Math.log2(k));
  const isAcc = (p, accs) => accs.some((a) => ks.some((d) => Math.abs(p - (a + d)) * 100 <= opt.accMatchCents));
  let reg = 0;                                                     // 이 사람이 부르는 옥타브 (목표보다 몇 옥타브 위·아래): 반주가 없는 순간들에서 가장 많이 나온 값
  if (opt.octaveFree) {
    const votes = new Map();
    let k = 0;
    for (const f of frames) {
      if (!voicedF(f) || opt.accAt(f.t - lat).length) continue;
      while (k < targets.length && targets[k].t1 <= f.t - lat) k++;
      const g = targets[k];
      if (!g || g.t0 > f.t - lat) continue;
      const o = Math.round((f.pitch - g.midi) / 12);
      votes.set(o, (votes.get(o) || 0) + 1);
    }
    for (const [o, n] of votes) if (n > (votes.get(reg) || 0)) reg = o;
  }
  const dist = (p, m) => Math.abs(p - (m + 12 * reg));
  let gi = 0;
  const out = frames.map((f) => {
    const ts = f.t - lat, accs = opt.accAt(ts);
    if (!accs.length) return f;
    while (gi < targets.length && targets[gi].t1 + 0.1 <= ts) gi++;
    const g = targets[gi] && targets[gi].t0 - 0.3 <= ts ? targets[gi] : null;
    // 후보: 배음 합의 봉우리(s "h")를 믿는다 — 섞인 소리에서 YIN 하나만의 답은 두 음의 "가운데"일 수 있다.
    // 같은 자리에 YIN 후보도 있으면 그 값이 더 정밀하니 그것을 쓴다. 배음 합 후보가 없는 기록(예전 것·시험용)은 있는 후보를 그대로
    const all = f.cands && f.cands.length ? f.cands : voicedF(f) ? [{ p: f.pitch, c: f.conf }] : [];
    const hs = all.filter((c) => c.s === "h"), ys = all.filter((c) => c.s !== "h");
    const cands = hs.length ? hs.map((c) => { const y = ys.find((d) => Math.abs(d.p - c.p) < 0.5); return y ? { p: y.p, c: Math.max(y.c, c.c) } : c; }) : all;
    let ok = cands.filter((c) => !isAcc(c.p, accs));
    if (g) ok = ok.filter((c) => (g.alts || [g.midi]).some((m) => dist(c.p, m) <= opt.searchSemis));
    if (!ok.length) return { ...f, pitch: null, hz: 0, filtered: true };
    const best = ok.reduce((a, b) => (b.c > a.c ? b : a));
    return best.p === f.pitch ? f : { ...f, pitch: best.p, picked: true };
  });
  // 짧게 쳤다가 사그라드는 소리 빼기: 같은 높이로 이어지는 덩어리가 sustainMinMs 보다 짧고 소리가 decayDb 이상 줄면
  for (let i = 0; i < out.length;) {
    if (!voicedF(out[i])) { i++; continue; }
    let j = i;
    while (j + 1 < out.length && voicedF(out[j + 1]) && Math.abs(out[j + 1].pitch - out[j].pitch) < 0.5 && out[j + 1].t - out[j].t < 0.05) j++;
    const dur = (out[j].t - out[i].t) * 1000 + opt.hopMs;
    if (dur < opt.sustainMinMs && out[i].db !== undefined && out[i].db - out[j].db >= opt.decayDb) {
      for (let k = i; k <= j; k++) out[k] = { ...out[k], pitch: null, hz: 0, filtered: true };
    }
    i = j + 1;
  }
  return out;
}

// 목표 음과 같은 음(옥타브는 상관없이)을 반주가 음 길이의 ambShare 넘게 치는가 — 그 음은 마이크가 반주를 들은 것인지 알 수 없다 → "애매"
export function ambiguousNote(target, opt = SING) {
  if (!opt.accAt) return false;
  const n = 8, alts = target.alts || [target.midi];
  let hit = 0;
  for (let i = 0; i < n; i++) {
    const t = target.t0 + (target.t1 - target.t0) * (i + 0.5) / n;
    if (opt.accAt(t).some((a) => alts.some((m) => { let d = a - m; d -= 12 * Math.round(d / 12); return Math.abs(d) * 100 <= opt.accMatchCents; }))) hit++;
  }
  return hit / n > opt.ambShare;
}

// 목표 음 여러 개 → 음표별 결과 + 요약 { total, ok, wrong, missed, high, low, accuracy: 정확 % (0~100, 인식 안 됨도 분모에 넣는다), lagMs, voicedShare }
export function scoreAll(targets, frames, opt = SING) {
  const raw = frames.slice().sort((a, b) => a.t - b.t);
  const sorted = opt.speaker && opt.accAt ? speakerFilter(raw, targets, opt) : raw;
  const lag = opt.autoLag ? estimateLag(targets, sorted, opt) : 0;
  const fr = lag ? sorted.map((f) => ({ ...f, t: f.t - lag })) : sorted;
  const notes = targets.map((t) => scoreNote(t, fr, opt));
  // 박자: 음정과 달리 늦음을 저절로 맞추지 않는다(늦게 들어간 것을 알려 줘야 하니까). 기기 지연만 뺀다
  const lat = latencyOf(opt), W = opt.onsetSearchMs / 1000;
  const shifted = sorted.map((f) => ({ ...f, t: f.t - lat }));
  targets.forEach((t, i) => {
    const prev = targets[i - 1], next = targets[i + 1];
    const lo = Math.max(t.t0 - W, prev ? (prev.t0 + t.t0) / 2 : -Infinity), hi = Math.min(t.t0 + W, next ? (t.t0 + next.t0) / 2 : Infinity);
    timeNote(notes[i], t, shifted, lo, hi, opt);
  });
  // 스피커: 반주가 같은 음을 치는 음은 "애매" — 표시만 하고 점수(정확 %)에는 넣지 않는다
  if (opt.speaker && opt.accAt) for (let i = 0; i < notes.length; i++) if (ambiguousNote(targets[i], opt)) { notes[i].ambiguous = true; notes[i].color = "amb"; }
  const scored = notes.filter((n) => !n.ambiguous);
  const count = (v) => scored.filter((n) => n.verdict === v).length;
  const tv = (v) => scored.filter((n) => n.timing && n.timing.verdict === v).length;
  const total = scored.length, ok = count("ok");
  return {
    notes,
    summary: { total, ok, wrong: count("wrong"), missed: count("missed"), high: notes.filter((n) => n.dir === "high").length,
      low: notes.filter((n) => n.dir === "low").length, accuracy: total ? Math.round(ok / total * 100) : 0, level: opt.level, tolerance: tolerance(opt), octaveFree: !!opt.octaveFree,
      lagMs: Math.round(lag * 1000), voicedShare: inSpan(targets, fr),
      early: tv("early"), late: tv("late"), onTime: tv("ok"), timingOnly: notes.filter((n) => n.color === "timing").length,
      latencyMs: Math.round(lat * 1000), latencyGuessed: typeof opt.latencyMs !== "number", timingTol: timingTolerance(opt),
      ambiguous: notes.length - scored.length, filtered: sorted.filter((f) => f.filtered).length, speaker: !!(opt.speaker && opt.accAt) },
  };
}
