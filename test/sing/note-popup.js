// 노래 채점 5단계: 악보 위 판정 점을 누르면 그 음표의 음정 그래프를 띄운다.
// 자리: 누른 음표 바로 위 (화면 위쪽이라 자리가 없으면 아래). 바깥을 누르거나 악보를 움직이면 닫힌다.
// 그래프: 가로 = 그 음표의 시간(앞뒤로 조금 여유), 세로 = 센트(목표 음 = 0), 목표 기준선 + 허용 범위 띠,
//         내 음정 선(범위 안 초록 / 밖 빨강), 판정에서 뺀 구간(음 시작·끝, 앞뒤 여유)은 흐리게.
// 글: 목표 음 / 부른 중심 음 / 평균 차이, "끝에서 떨어짐/올라감", "아래에서 긁어 올림", 박자(6단계).
import { describeNote, tolerance } from "./scoring.js";
import { noteName } from "../edits.js";

const h = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
const signed = (x) => (x > 0 ? "+" : "") + Math.round(x);
let openOne = null;                         // 한 번에 하나만

// n: 판정 결과 하나(scoring.js), anchor: 누른 점, opt: 설정, song, extra: { timingText, onMine(), onOrig() }
export function openNotePopup(n, anchor, opt, song, extra = {}) {
  if (openOne) openOne();
  const tol = tolerance(opt), d = describeNote(n, opt);
  const pop = h("div", "sing-pop");
  pop.setAttribute("role", "dialog");
  const mm = n.ref ? song.measures[n.ref.m] : null;
  const head = h("div", "sing-pop-head");
  head.append(h("b", null, (mm ? `${mm.n}마디 ${Math.round((n.ref.beat + 1) * 100) / 100}박` : "음표") + (n.ref && n.ref.lyric ? ` · "${n.ref.lyric}"` : "")));
  const x = h("button", "icon sing-close", "✕");
  x.setAttribute("aria-label", "그래프 닫기");
  head.append(x);
  const canvas = h("canvas", "sing-pop-graph");
  const facts = h("div", "sing-pop-facts");
  const row = (k, v, cls = "") => { const r = h("div", "sing-pop-row " + cls); r.append(h("span", null, k), h("b", null, v)); facts.append(r); };
  row("목표 음", noteName(n.target));
  if (n.sung) {
    row("부른 중심 음", `${n.sung.name} (${signed(n.cents)}센트${opt.octaveFree && Math.round(n.sung.pitch) - n.target >= 6 ? ", 옥타브 위" : opt.octaveFree && n.target - Math.round(n.sung.pitch) >= 6 ? ", 옥타브 아래" : ""})`);
    if (d.mean !== null) row("평균 차이", `${signed(d.mean)}센트 ${Math.abs(d.mean) <= tol ? "— 허용 범위 안" : d.mean > 0 ? "높음" : "낮음"}`);
  } else row("부른 음", "목소리가 잡히지 않았어요");
  const notes = [];
  if (d.drift === "drop") notes.push(`끝에서 떨어짐 (${signed(d.driftCents)}센트)`);
  if (d.drift === "rise") notes.push(`끝에서 올라감 (${signed(d.driftCents)}센트)`);
  if (d.scoop) notes.push("아래에서 긁어 올림");
  if (notes.length) row("모양", notes.join(" · "), "warn");
  if (extra.timingText) row("박자", extra.timingText);
  const tools = h("div", "sing-tools");
  const mine = h("button", "btn sm", "🎤 내 소리 (이 음)"), orig = h("button", "btn sm", "🎹 원래 음");
  mine.disabled = !extra.onMine;
  tools.append(mine, orig);
  pop.append(head, canvas, facts, tools);
  document.body.append(pop);

  // 자리: 음표 바로 위, 자리가 없으면 아래. 화면 양옆 16px 안
  const r = anchor.getBoundingClientRect(), W = Math.min(360, window.innerWidth - 32);
  pop.style.width = W + "px";
  const ph = pop.offsetHeight;
  const top = r.top - ph - 10 >= 8 ? r.top - ph - 10 : Math.min(window.innerHeight - ph - 8, r.bottom + 10);
  pop.style.top = Math.max(8, top) + "px";
  pop.style.left = Math.max(16, Math.min(window.innerWidth - W - 16, r.left + r.width / 2 - W / 2)) + "px";
  draw(canvas, n, opt, tol);

  const close = () => {
    pop.remove();
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("scroll", close, true);
    window.removeEventListener("resize", close);
    if (openOne === close) openOne = null;
  };
  const outside = (e) => { if (!pop.contains(e.target) && e.target !== anchor) close(); };
  document.addEventListener("pointerdown", outside, true);
  setTimeout(() => window.addEventListener("scroll", close, true), 300);      // 띄우면서 생긴 스크롤에는 닫히지 않게
  window.addEventListener("resize", close);
  x.onclick = close;
  mine.onclick = () => extra.onMine && extra.onMine();
  orig.onclick = () => extra.onOrig && extra.onOrig();
  openOne = close;
  return close;
}

function draw(canvas, n, opt, tol) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3), W = canvas.clientWidth || 320, H = canvas.clientHeight || 150;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const tr = n.trace, m = opt.traceMarginMs / 1000;
  const t0 = n.t0 - m, t1 = n.t1 + m;
  const big = Math.max(0, ...tr.filter((f) => f.c !== null).map((f) => Math.abs(f.c)));
  const span = Math.max(opt.graphCentsMin, Math.min(opt.graphCentsMax, big + 20));
  const L = 34, x = (t) => L + (t - t0) / (t1 - t0) * (W - L - 6), y = (c) => H / 2 - Math.max(-span, Math.min(span, c)) / span * (H / 2 - 8);
  // 판정에서 뺀 구간(음 시작·끝, 앞뒤 여유)은 옅은 회색 바탕
  g.fillStyle = "rgba(27,34,51,.05)";
  g.fillRect(L, 0, x(n.judged[0]) - L, H);
  g.fillRect(x(n.judged[1]), 0, W - x(n.judged[1]), H);
  // 허용 범위 띠와 목표 기준선
  g.fillStyle = "rgba(30,150,90,.13)";
  g.fillRect(L, y(tol), W - L, y(-tol) - y(tol));
  g.strokeStyle = "rgba(30,150,90,.8)"; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(L, y(0)); g.lineTo(W, y(0)); g.stroke();
  // 음표 시작·끝
  g.strokeStyle = "rgba(27,34,51,.35)"; g.setLineDash([3, 3]); g.lineWidth = 1;
  for (const t of [n.t0, n.t1]) { g.beginPath(); g.moveTo(x(t), 0); g.lineTo(x(t), H); g.stroke(); }
  g.setLineDash([]);
  // 눈금 글
  g.fillStyle = "rgba(27,34,51,.6)"; g.font = "10px system-ui, sans-serif"; g.textAlign = "right"; g.textBaseline = "middle";
  for (const c of [span, tol, 0, -tol, -span]) g.fillText((c > 0 ? "+" : "") + Math.round(c), L - 4, y(c));
  // 내 음정 선
  g.lineWidth = 2.5; g.lineJoin = "round"; g.lineCap = "round";
  for (let i = 1; i < tr.length; i++) {
    const a = tr[i - 1], b = tr[i];
    if (a.c === null || b.c === null || b.t - a.t > 0.05 || b.t < t0 || a.t > t1) continue;
    const faded = a.skip !== null || b.skip !== null;
    const ok = a.in && b.in;
    g.strokeStyle = ok ? `rgba(30,150,90,${faded ? 0.35 : 1})` : `rgba(215,40,30,${faded ? 0.35 : 1})`;
    g.beginPath(); g.moveTo(x(a.t), y(a.c)); g.lineTo(x(b.t), y(b.c)); g.stroke();
  }
  if (!tr.some((f) => f.c !== null)) {
    g.fillStyle = "rgba(27,34,51,.55)"; g.textAlign = "center"; g.font = "13px system-ui, sans-serif";
    g.fillText("목소리가 잡히지 않았어요", (L + W) / 2, H / 2 - 14);
  }
}

// 떠 있는 그래프를 닫는다 (다시 부르기·구간 바꾸기·화면 닫기)
export function closeNotePopup() { if (openOne) openOne(); }
