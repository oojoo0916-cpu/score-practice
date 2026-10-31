// 노래 채점: 부를 구간 정하기. 화면과 무관한 순수 계산 (ranges.test.js 가 시험한다).
// 구간 하나: { k0, k1: 연주 순서 마디 번호 [k0, k1), from: 재생을 시작할 박(마디 처음), to: 재생·녹음을 끝낼 박,
//            noteFrom, noteTo: 채점할 음의 시작 박 범위 [noteFrom, noteTo) }
// 단위: 숫자 n = n마디씩 · "phrase" = 프레이즈(쉬는 곳에서 끊는다) · "loop" = 앱의 구간 반복 범위
// notes: 연주 순서로 펼친 음(music.js 의 voiceLines(...).all 또는 .lines.top 등, start·dur 는 곡 처음부터의 박)
import { SING } from "./settings.js";

const EPS = 1e-6;

// 곡 처음부터의 박 → 연주 순서 마디 번호
export function kAt(starts, beat) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= beat + EPS) lo = mid; else hi = mid - 1; }
  return lo;
}

export const hasNotes = (notes, a, b) => notes.some((n) => n.start >= a - EPS && n.start < b - EPS);

// 프레이즈로 나누기: 앞 음이 끝나고 다음 음이 시작할 때까지 opt.phraseGapBeats 박 이상 쉬면 끊는다.
// 한 프레이즈가 opt.phraseMaxMeasures 마디를 넘으면 그 안에서 가장 길게 쉬는 곳에서 한 번 더 끊는다(숨 쉴 곳).
// (숨표는 아직 악보에서 읽지 않는다 — 쉼표만 본다)
export function phrasesOf(notes, starts, opt = SING) {
  const ns = notes.slice().sort((a, b) => a.start - b.start);
  const groups = [];
  let cur = [];
  for (const n of ns) {
    const prev = cur[cur.length - 1];
    if (prev && n.start - Math.max(...cur.map((x) => x.start + x.dur)) >= opt.phraseGapBeats - EPS) { groups.push(cur); cur = []; }
    cur.push(n);
  }
  if (cur.length) groups.push(cur);
  const out = [];
  const split = (g) => {
    const k0 = kAt(starts, g[0].start), k1 = kAt(starts, g[g.length - 1].start) + 1;
    if (k1 - k0 <= opt.phraseMaxMeasures || g.length < 2) { out.push(g); return; }
    let best = -1, gap = -Infinity;                          // 가장 길게 쉬는 곳 (같으면 가운데에 가까운 곳)
    for (let i = 1; i < g.length; i++) {
      const d = g[i].start - (g[i - 1].start + g[i - 1].dur) - Math.abs(i - g.length / 2) * 1e-3;
      if (d > gap) { gap = d; best = i; }
    }
    split(g.slice(0, best));
    split(g.slice(best));
  };
  for (const g of groups) split(g);
  return out.map((g) => {
    const noteFrom = g[0].start, noteTo = Math.max(...g.map((x) => x.start + x.dur));
    const k0 = kAt(starts, noteFrom);
    return { k0, k1: kAt(starts, noteTo - 1e-3) + 1, from: starts[k0], to: noteTo, noteFrom, noteTo };
  });
}

// 마디 단위 구간 [k0, k0+n)
export function measureRange(k0, n, starts, total) {
  const K = starts.length, k1 = Math.min(K, k0 + Math.max(1, n));
  const from = starts[k0], to = k1 < K ? starts[k1] : total;
  return { k0, k1, from, to, noteFrom: from, noteTo: to };
}

// 구간 고르기와 앞뒤로 옮기기. 노래가 없는 곳(전주·간주)은 건너뛴다
export class RangeNav {
  constructor({ notes, starts, total, loop = null, opt = SING }) {
    this.notes = notes; this.starts = starts; this.total = total; this.loop = loop; this.opt = opt;
    this.unit = "phrase";
    this.phrases = phrasesOf(notes, starts, opt);
    this.cur = null;
    this.skipped = false;                  // 마지막으로 고를 때 노래가 없는 곳을 건너뛰었는가
  }

  sing(r) { return !!r && hasNotes(this.notes, r.noteFrom, r.noteTo); }

  // 연주 순서 마디 k 에서(또는 그 뒤에서) 시작하는 구간
  at(k) {
    this.skipped = false;
    const K = this.starts.length;
    if (this.unit === "loop" && this.loop) {
      const a = Math.min(this.loop[0], this.loop[1]), b = Math.max(this.loop[0], this.loop[1]);
      return (this.cur = measureRange(a, b - a + 1, this.starts, this.total));
    }
    if (this.unit === "phrase") {
      const b = this.starts[k];
      let i = this.phrases.findIndex((p) => p.noteTo > b + EPS);            // 이 마디에 걸쳐 있거나 뒤에 오는 첫 프레이즈
      if (i < 0) i = this.phrases.length - 1;
      if (i < 0) return (this.cur = null);
      this.skipped = this.phrases[i].k0 > k;
      return (this.cur = this.phrases[i]);
    }
    const n = +this.unit;
    const here = measureRange(k, n, this.starts, this.total);
    if (this.sing(here)) return (this.cur = here);                          // 고른 마디부터 (첫 마디가 쉬어도 구간 안에 노래가 있으면)
    for (let kk = k + 1; kk < K; kk++) {                                    // 노래가 없으면: 노래가 처음 나오는 마디부터
      if (this.sing(measureRange(kk, 1, this.starts, this.total))) { this.skipped = true; return (this.cur = measureRange(kk, n, this.starts, this.total)); }
    }
    for (let kk = k - 1; kk >= 0; kk--) {                                    // 뒤에는 노래가 없다 → 앞쪽에서
      const r = measureRange(kk, n, this.starts, this.total);
      if (this.sing(r)) { this.skipped = true; return (this.cur = r); }
    }
    return (this.cur = null);
  }

  next() {
    const c = this.cur;
    if (!c) return null;
    if (this.unit === "phrase") { const i = this.phrases.indexOf(c); return i >= 0 && i + 1 < this.phrases.length ? (this.cur = this.phrases[i + 1]) : null; }
    if (this.unit === "loop") return null;
    for (let kk = c.k1; kk < this.starts.length; kk++) {
      const r = measureRange(kk, +this.unit, this.starts, this.total);
      if (this.sing(r)) return (this.cur = r);
    }
    return null;
  }

  prev() {
    const c = this.cur;
    if (!c) return null;
    if (this.unit === "phrase") { const i = this.phrases.indexOf(c); return i > 0 ? (this.cur = this.phrases[i - 1]) : null; }
    if (this.unit === "loop") return null;
    const n = +this.unit;
    if (c.k0 <= 0) return null;
    for (let kk = c.k0 - n; ; kk--) {                        // 바로 앞 n마디부터, 노래가 없으면 한 마디씩 더 앞으로
      const a = Math.max(0, kk), r = measureRange(a, Math.min(n, c.k0 - a), this.starts, this.total);
      if (this.sing(r)) return (this.cur = r);
      if (a === 0) return null;
    }
  }

  hasNext() { const c = this.cur, nx = c && this.next(); this.cur = c; return !!nx; }
  hasPrev() { const c = this.cur, pv = c && this.prev(); this.cur = c; return !!pv; }
}
