// 읽은 악보(song.json)를 재생할 수 있는 모양으로 바꾸는 계산들. 화면·소리와 무관한 순수 계산만 둔다.

// 연주 순서로 펼친 각 마디가 곡 처음부터 몇 번째 박에서 시작하는지
export function unfold(song) {
  const starts = [];
  let acc = 0;
  for (const oi of song.order) { starts.push(acc); acc += song.measures[oi].len; }
  return { starts, total: acc };
}

// 한 파트의 음표를 연주 순서로 펼치고, 붙임줄로 이어진 음은 첫 음 하나로 합쳐 길게 만든다.
export function mergedNotes(song, part, starts) {
  const byM = new Map();
  for (const n of part.notes) { if (!byM.has(n.m)) byM.set(n.m, []); byM.get(n.m).push(n); }
  const seq = [];
  song.order.forEach((oi, k) => {
    for (const n of byM.get(oi) || []) seq.push({ ...n, k, start: starts[k] + n.beat, heads: [{ page: n.page, x: n.x, y: n.y, at: starts[k] + n.beat }] });
  });
  seq.sort((a, b) => a.start - b.start || a.midi - b.midi);
  const out = [], open = new Map();
  for (const n of seq) {
    const prev = open.get(n.midi);
    if (prev && Math.abs(prev.start + prev.dur - n.start) < 1e-6) {
      prev.dur += n.dur;
      prev.heads.push(n.heads[0]);
      if (!n.tie) open.delete(n.midi);
      continue;
    }
    open.delete(n.midi);
    out.push(n);
    if (n.tie) open.set(n.midi, n);
  }
  return out;
}

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const acc = (s) => (s === "#" ? 1 : s === "b" ? -1 : 0);

// 코드 이름 → 구성음. 예: Am7 → 라·도·미·솔, D/F# → 베이스 파#
export function parseChord(name) {
  const m = /^([A-G])([#b]?)(.*?)(?:\/([A-G])([#b]?))?$/.exec(name);
  if (!m) return null;
  const root = (PC[m[1]] + acc(m[2]) + 12) % 12;
  const bass = m[4] ? (PC[m[4]] + acc(m[5]) + 12) % 12 : root;
  const q = m[3];
  let third = 4, fifth = 7, seventh = null;
  const ext = [];
  if (/^(m|min)(?!aj)/.test(q)) third = 3;
  if (/dim|°/.test(q)) { third = 3; fifth = 6; if (/7/.test(q)) seventh = 9; }
  if (/ø/.test(q)) { third = 3; fifth = 6; seventh = 10; }
  if (/aug|\+/.test(q)) fifth = 8;
  if (/sus2/.test(q)) third = 2; else if (/sus/.test(q)) third = 5;
  if (/b5/.test(q)) fifth = 6;
  if (/#5/.test(q)) fifth = 8;
  if (/M7|maj7|M9|maj9/.test(q)) seventh = 11;
  // 7음은 괄호 밖에 7·9·11·13이 있을 때만 넣는다 (예: Dm(b13)에는 7음이 없다, A7(b9)에는 있다)
  else if (seventh === null && /7|9|11|13/.test(q.replace(/\([^)]*\)/g, "").replace(/add\d+/g, ""))) seventh = 10;
  if (/6/.test(q)) ext.push(9);
  if (/#9/.test(q)) ext.push(3); else if (/b9/.test(q)) ext.push(1); else if (/9/.test(q)) ext.push(2);
  if (/add2|^2|\(2\)/.test(q) && third !== 2) ext.push(2);
  if (/#11/.test(q)) ext.push(6); else if (/11/.test(q)) ext.push(5);
  if (/b13/.test(q)) ext.push(8); else if (/13/.test(q)) ext.push(9);
  let tones = [0, third, fifth];
  if (/omit3|no3|^5$/.test(q) || (/11/.test(q) && !/#11/.test(q) && third === 4)) tones = tones.filter((t) => t !== third);
  if (/omit5|no5/.test(q)) tones = tones.filter((t) => t !== fifth);
  if (seventh !== null) tones.push(seventh);
  for (const x of ext) if (!tones.includes(x)) tones.push(x);
  return { root, bass, tones };
}

// 코드 반주: 베이스는 낮게, 나머지 음은 가운데 음역에 모아서
export function chordVoicing(name) {
  const c = parseChord(name);
  if (!c) return null;
  const bass = 36 + c.bass + (c.bass > 7 ? -12 : 0);
  const tones = c.tones.map((t) => {
    const pc = (c.root + t) % 12;
    return 53 + ((pc - 53 % 12 + 12) % 12);          // 파3 ~ 미4 사이
  });
  return { bass: bass < 33 ? bass + 12 : bass, tones: [...new Set(tones)].sort((a, b) => a - b) };
}

// 코드 반주 음표. style: "long"(코드가 바뀔 때만 길게) | "beat"(박마다)
export function chordEvents(song, starts, style) {
  const ev = [];
  let last = null;
  song.order.forEach((oi, k) => {
    const m = song.measures[oi];
    const pts = m.chords.map((c) => ({ beat: c.beat, name: c.name }));
    if (last && (!pts.length || pts[0].beat > 0.01)) pts.unshift({ beat: 0, name: last });
    pts.forEach((p, i) => {
      const end = i + 1 < pts.length ? pts[i + 1].beat : m.len;
      const v = chordVoicing(p.name);
      if (!v || end <= p.beat) return;
      const strikes = [];
      if (style === "beat") for (let b = p.beat; b < end - 0.01; b = Math.floor(b + 1 + 1e-6)) strikes.push(b);
      else strikes.push(p.beat);
      strikes.forEach((b, j) => {
        const nxt = j + 1 < strikes.length ? strikes[j + 1] : end;
        const d = nxt - b;
        if (j === 0) ev.push({ b: starts[k] + b, d: end - b, midi: v.bass, tr: "chord", v: 0.75, fixed: true });
        for (const t of v.tones) ev.push({ b: starts[k] + b, d, midi: t, tr: "chord", v: j === 0 ? 0.55 : 0.4 });
      });
    });
    if (pts.length) last = pts[pts.length - 1].name;
  });
  return ev;
}

// 메트로놈: 박마다 한 번, 마디 첫 박은 높은 소리
export function clickEvents(song, starts) {
  const ev = [];
  song.order.forEach((oi, k) => {
    const m = song.measures[oi];
    const unit = 4 / m.meter[1];
    const compound = m.meter[1] === 8 && m.meter[0] % 3 === 0 && m.meter[0] > 3;
    const step = compound ? unit * 3 : unit;
    for (let b = 0, i = 0; b < m.len - 1e-6; b += step, i++) ev.push({ b: starts[k] + b, d: 0, tr: "metro", click: true, accent: i === 0 });
  });
  return ev;
}

// 빠르기 지도: 곡 처음부터의 박 ↔ 초. rit.은 점점 느리게, 페르마타는 그 음을 두 배로 늘인다.
export function buildTimeline(song, starts, ratio, parts) {
  const ferm = new Map();                              // 악보 마디 번호 → [[시작 박, 끝 박]]
  for (const p of parts) for (const n of p.notes) if (n.fermata) {
    if (!ferm.has(n.m)) ferm.set(n.m, []);
    ferm.get(n.m).push([n.beat, n.beat + Math.min(n.dur, 2)]);
  }
  const segs = [];
  let t = 0, rit = null, prevBpm = null;
  song.order.forEach((oi, k) => {
    const m = song.measures[oi];
    const spb = 60 / (m.bpm * ratio);
    if (prevBpm !== null && m.bpm !== prevBpm) rit = null;
    prevBpm = m.bpm;
    const ritMark = m.marks.find((x) => x.type === "rit");
    const aTempo = m.marks.find((x) => x.type === "a_tempo");
    if (rit && k > rit.k + 1) rit = null;
    const fs = ferm.get(oi) || [];
    const fine = rit || ritMark || aTempo || fs.length;
    const step = fine ? 0.25 : m.len;
    for (let x = 0; x < m.len - 1e-9; x += step) {
      const x1 = Math.min(m.len, x + step);
      if (aTempo && x >= aTempo.beat - 1e-6) rit = null;
      if (ritMark && !rit && x >= ritMark.beat - 1e-6 && !(aTempo && aTempo.beat > ritMark.beat && x >= aTempo.beat)) {
        rit = { k, from: starts[k] + ritMark.beat, span: Math.max(1, m.len - ritMark.beat) };
      }
      let f = 1;
      if (rit) f *= 1 - 0.3 * Math.min(1, Math.max(0, (starts[k] + x - rit.from) / rit.span));
      if (fs.some(([a, b]) => x >= a - 1e-6 && x < b - 1e-6)) f *= 0.5;
      segs.push({ b0: starts[k] + x, b1: starts[k] + x1, t0: t, spb: spb / f });
      t += (x1 - x) * spb / f;
    }
  });
  const find = (pred) => { let lo = 0, hi = segs.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pred(segs[mid])) lo = mid; else hi = mid - 1; } return segs[lo]; };
  return {
    total: t,
    secOf(b) { const s = find((g) => g.b0 <= b + 1e-9); return s.t0 + (Math.min(b, s.b1) - s.b0) * s.spb + Math.max(0, b - s.b1) * s.spb; },
    beatOf(sec) { const s = find((g) => g.t0 <= sec + 1e-9); return Math.min(s.b1, s.b0 + (sec - s.t0) / s.spb); },
  };
}
