// 노래 채점: 원본 악보 위에 표시하기 (4단계). 앱이 만든 쪽마다의 겹침 층(.ov)에 붙였다가 지운다.
// 자리는 쪽 크기에 대한 % 라서 확대·축소·쪽 넘김에도 음표에 붙어 있다.
//   - 부를 구간: 마디 상자에 파란 칠
//   - 판정: 음표 머리 위에 반투명 점 (초록 정확 · 빨강 틀림 · 회색 인식 안 됨 · 노랑 박자만 틀림 — 노랑은 6단계)
//   - 틀린 음: 바로 오른쪽 옆, 실제로 부른 높이에 반투명 빨간 음표 머리를 덧그린다(오선 밖이면 덧줄까지). 너무 멀면 덧그리지 않고 ↑/↓ 와 음이름만
//   - 색맹 모드: 색을 바꾸고(파랑·분홍·청록) 점 위에 ○ × △ 를 같이. 채점 표시 끄기
// 오선 자리는 엔진이 곡 자료에 남기지 않으므로, 같은 줄(쪽·단)의 음표들의 높이와 음이름으로 계산한다(staffGeometry).
import { SING } from "./settings.js";
import { noteName } from "../edits.js";

const STEP = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
// 음이름("Eb4", "C#5", "Fx4") → 오선 위 자리 번호(도=0 … 시=6, 옥타브마다 7)
export function diatonicOfName(name) {
  const m = /^([A-G])(?:bb|b|#|x)?(-?\d+)$/.exec(name || "");
  return m ? STEP[m[1]] + 7 * +m[2] : null;
}
// 음높이(midi) → 자리 번호. 조표가 플랫 쪽이면 플랫으로(Eb), 아니면 샵으로(D#) 읽는다
const SHARP_STEPS = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6], FLAT_STEPS = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6];
const BLACK = [1, 3, 6, 8, 10];
export function diatonicOfMidi(midi, key = 0) {
  const pc = ((midi % 12) + 12) % 12, oct = Math.floor(midi / 12) - 1;
  return (key < 0 ? FLAT_STEPS : SHARP_STEPS)[pc] + 7 * oct;
}
const accOf = (midi, key) => (BLACK.includes(((midi % 12) + 12) % 12) ? (key < 0 ? "♭" : "♯") : "");

const median = (a) => { const s = a.slice().sort((x, y) => x - y), k = s.length >> 1; return s.length ? (s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2) : null; };
// 가운데 줄 후보: 높은음자리표(시4), 옥타브 아래 높은음자리표(시3 — 테너), 낮은음자리표(레3)
const MIDS = [34, 27, 22];

// 한 노래 줄의 오선 자리: "쪽|단" → { a, b, mid }  (자리 번호 d 의 세로 위치 y = a − b·d, b = 오선 칸의 반, mid = 가운데 줄의 자리 번호)
// 같은 단에 높이가 다른 음이 둘 이상 있으면 그것들로 맞추고, 없으면 같은 쪽(없으면 곡 전체)의 칸 크기를 쓴다
export function staffGeometry(song, part) {
  const groups = new Map();
  for (const n of part.notes) {
    const d = diatonicOfName(n.name), m = song.measures[n.m];
    if (d === null || !m || typeof n.y !== "number") continue;
    const key = (n.page || m.page) + "|" + m.system;
    if (!groups.has(key)) groups.set(key, { page: n.page || m.page, pts: [] });
    groups.get(key).pts.push([d, n.y]);
  }
  const fitB = new Map();
  for (const [key, g] of groups) {
    const ds = g.pts.map((p) => p[0]);
    if (Math.max(...ds) === Math.min(...ds)) continue;
    const md = ds.reduce((s, x) => s + x, 0) / ds.length, my = g.pts.reduce((s, p) => s + p[1], 0) / g.pts.length;
    let num = 0, den = 0;
    for (const [d, y] of g.pts) { num += (d - md) * (y - my); den += (d - md) * (d - md); }
    const b = -num / den;
    if (b > 0) fitB.set(key, b);
  }
  const all = [...fitB.values()];
  const out = new Map();
  for (const [key, g] of groups) {
    const page = [...fitB].filter(([k]) => groups.get(k).page === g.page).map(([, b]) => b);
    const b = fitB.get(key) || median(page) || median(all);
    if (!b) continue;
    const a = median(g.pts.map(([d, y]) => y + b * d));
    const yMed = median(g.pts.map((p) => p[1]));
    const mid = MIDS.reduce((best, c) => (Math.abs(a - b * c - yMed) < Math.abs(a - b * best - yMed) ? c : best), MIDS[0]);
    out.set(key, { a, b, mid });
  }
  return out;
}

export class Overlay {
  // pages: 앱의 쪽들 (번호 → { ov, w, h }), boxes: 마디 상자(악보 순서), song: 곡, root: 색맹·끄기 표시를 붙일 요소(연습 화면)
  constructor({ pages, boxes, song, root = null, opt = SING }) {
    this.pages = pages; this.boxes = boxes; this.song = song; this.root = root; this.opt = opt;
    this.marks = []; this.inRange = [];
    this.geo = new Map();                  // 노래 줄 id → staffGeometry
    this.style({ colorblind: !!opt.colorblind, hidden: !!opt.hideMarks });
  }

  // 색맹 모드 · 채점 표시 끄기. 색은 settings.js 의 colors 에서
  style({ colorblind, hidden }) {
    if (!this.root) return;
    const c = this.opt.colors[colorblind ? "colorblind" : "normal"];
    for (const [k, v] of Object.entries(c)) this.root.style.setProperty("--sing-" + k, v);
    this.root.classList.toggle("sing-cb", !!colorblind);
    this.root.classList.toggle("sing-hide", !!hidden);
  }

  unstyle() {
    if (!this.root) return;
    for (const k of Object.keys(this.opt.colors.normal)) this.root.style.removeProperty("--sing-" + k);
    this.root.classList.remove("sing-cb", "sing-hide");
  }

  // 연주 순서 k0 ~ k1-1 마디를 "부를 구간"으로 칠한다
  range(k0, k1) {
    for (const b of this.inRange) b.classList.remove("sing-in");
    this.inRange = [];
    for (let k = k0; k < k1; k++) {
      const b = this.boxes[this.song.order[k]];
      if (b && !this.inRange.includes(b)) { b.classList.add("sing-in"); this.inRange.push(b); }
    }
  }

  clearMarks() { for (const el of this.marks) el.remove(); this.marks = []; }

  clear() { this.clearMarks(); this.range(0, 0); this.unstyle(); }

  put(pg, cls, x, y, text = null) {
    const el = document.createElement("span");
    el.className = cls;
    el.style.left = (x / pg.w * 100) + "%";
    el.style.top = (y / pg.h * 100) + "%";
    if (text !== null) el.textContent = text;
    pg.ov.append(el);
    this.marks.push(el);
    return el;
  }

  geometry(partId) {
    if (!this.geo.has(partId)) {
      const part = this.song.parts.find((p) => p.id === partId);
      this.geo.set(partId, part ? staffGeometry(this.song, part) : new Map());
    }
    return this.geo.get(partId);
  }

  // 판정 결과(scoring.js 의 notes)를 칠한다. 붙임줄로 이어진 머리는 모두 칠한다.
  // 화음(같이 시작하는 여러 음 중 하나를 부르면 되는 곳)은 판정에 쓴 음만 칠한다. onTap(n, el): 점을 눌렀을 때 (5단계 그래프)
  results(notes, { partId = null, transpose = 0, onTap = null } = {}) {
    this.clearMarks();
    const geo = partId ? this.geometry(partId) : new Map();
    for (const n of notes) {
      const refs = n.refs && n.refs.length ? n.refs : n.ref ? [n.ref] : [];
      const mine = refs.filter((r) => r.midi === undefined || r.midi === n.target);
      const cls = n.color || n.verdict;
      (mine.length ? mine : refs).forEach((r, ri) => (r.heads || []).forEach((hd, hi) => {
        const pg = this.pages.get(hd.page);
        if (!pg || typeof hd.x !== "number" || typeof hd.y !== "number") return;
        const dot = this.put(pg, "sing-mark v-" + cls, hd.x, hd.y);
        if (onTap) { dot.classList.add("tap"); dot.onclick = (e) => { e.stopPropagation(); onTap(n, dot); }; }
        if (ri || hi) return;
        const m = this.song.measures[r.m];
        const g = m ? geo.get(hd.page + "|" + m.system) : null;
        if (n.verdict === "wrong" && n.shown !== null) this.ghost(pg, n, hd, g, m ? m.key : 0, transpose);
        else if (cls === "timing" && n.timing && n.timing.offsetMs) this.shift(pg, n, hd, g);
      }));
    }
  }

  // 틀린 음: 부른 높이에 음표 머리 (+ 덧줄, 임시표). 너무 멀거나 오선 자리를 모르면 ↑/↓ 와 음이름만
  ghost(pg, n, hd, g, key, transpose) {
    const sungMidi = Math.round(n.shown) - transpose;                // 악보는 원래 키로 적혀 있다 (키를 옮겨 들어도 원래 자리)
    const name = noteName(Math.round(n.shown)) + (n.dir === "high" ? "↑" : "↓");
    const dT = g ? (g.a - hd.y) / g.b : null;                         // 목표 음의 자리 번호 (그려진 그대로)
    const dS = g ? diatonicOfMidi(sungMidi, key) + Math.round(dT - diatonicOfMidi(n.target - transpose, key)) : null;
    if (!g || Math.abs(dS - dT) > this.opt.ghostMaxSteps) { this.put(pg, "sing-label", hd.x, hd.y, name); return; }
    const sp = 2 * g.b, x = hd.x + this.opt.ghostOffsetSpaces * sp, y = g.a - g.b * dS;
    const head = this.put(pg, "sing-ghost", x, y);
    head.style.width = (1.3 * sp / pg.w * 100) + "%";
    head.style.height = (sp / pg.h * 100) + "%";
    const acc = accOf(sungMidi, key);
    if (acc) this.put(pg, "sing-acc", x - 1.15 * sp, y, acc);
    // 덧줄: 오선 밖이면 가운데 줄에서 ±6칸, ±8칸 … 까지
    const ledgers = [];
    for (let d = g.mid + 6; d <= dS; d += 2) ledgers.push(d);
    for (let d = g.mid - 6; d >= dS; d -= 2) ledgers.push(d);
    for (const d of ledgers) {
      const l = this.put(pg, "sing-ledger", x, g.a - g.b * d);
      l.style.width = (2.2 * sp / pg.w * 100) + "%";
    }
    this.put(pg, "sing-label small", x, y, name);
  }

  // 박자만 틀림(6단계): 빠르면 원래 자리보다 왼쪽, 늦으면 오른쪽에 반투명 머리
  shift(pg, n, hd, g) {
    const sp = g ? 2 * g.b : pg.w * 0.012;
    const x = hd.x + Math.sign(n.timing.offsetMs) * this.opt.timingShiftSpaces * sp;
    const head = this.put(pg, "sing-ghost timing", x, hd.y);
    head.style.width = (1.3 * sp / pg.w * 100) + "%";
    head.style.height = (sp / pg.h * 100) + "%";
  }
}
