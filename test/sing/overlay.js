// 노래 채점: 원본 악보 위에 표시하기. 부를 구간(마디 상자 색)과 판정 결과(음표 머리 위 색 점, 틀린 음은 부른 음이름)를 그린다.
// 앱이 만든 쪽마다의 겹침 층(.ov)에 붙였다가 지운다. 자리는 쪽 크기에 대한 % 라서 확대·축소해도 음표에 붙어 있다.
import { noteName } from "../edits.js";

export class Overlay {
  // pages: 앱의 쪽들 (번호 → { ov, w, h }), boxes: 마디 상자(악보 순서), song: 곡
  constructor({ pages, boxes, song }) {
    this.pages = pages; this.boxes = boxes; this.song = song;
    this.marks = []; this.inRange = [];
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

  clear() { this.clearMarks(); this.range(0, 0); }

  // 판정 결과(scoring.js 의 notes)를 음표 머리 위에 칠한다. 붙임줄로 이어진 머리는 모두 칠한다.
  // 화음(같이 시작하는 여러 음 중 하나를 부르면 되는 곳)은 판정에 쓴 음만 칠한다.
  results(notes) {
    this.clearMarks();
    for (const n of notes) {
      const refs = n.refs && n.refs.length ? n.refs : n.ref ? [n.ref] : [];
      const mine = refs.filter((r) => r.midi === undefined || r.midi === n.target);
      (mine.length ? mine : refs).forEach((r, ri) => (r.heads || []).forEach((h, hi) => {
        const pg = this.pages.get(h.page);
        if (!pg || typeof h.x !== "number" || typeof h.y !== "number") return;
        const dot = document.createElement("span");
        dot.className = "sing-mark v-" + n.verdict;
        dot.style.left = (h.x / pg.w * 100) + "%";
        dot.style.top = (h.y / pg.h * 100) + "%";
        pg.ov.append(dot);
        this.marks.push(dot);
        if (n.verdict === "wrong" && ri === 0 && hi === 0 && n.sung) {        // 틀린 음: 실제로 부른 음이름과 방향
          const lab = document.createElement("span");
          lab.className = "sing-label";
          lab.textContent = noteName(Math.round(n.shown)) + (n.dir === "high" ? "↑" : "↓");
          lab.style.left = (h.x / pg.w * 100) + "%";
          lab.style.top = (h.y / pg.h * 100) + "%";
          pg.ov.append(lab);
          this.marks.push(lab);
        }
      }));
    }
  }
}
