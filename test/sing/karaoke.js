// 노래 채점 7단계: 노래방식 화면. 악보 대신, 가로로 흐르는 화면에 목표 음을 막대(길이 = 음 길이, 높이 = 음높이)로,
// 내 목소리를 실시간 선으로 그린다. 막대 안에 들어온 부분은 초록으로 채워지고, 벗어난 선은 빨강. 가사가 있으면 막대 아래에.
// 부르는 도중에도 악보 화면과 바꿔 볼 수 있다(panel.js 의 "노래방 화면" 단추).
// 시각: 막대는 반주가 울리는 소리 시계, 목소리는 마이크로 들어온 시각에서 기기 지연을 뺀 것.
import { noteName } from "../edits.js";

const css = (name, fb) => (getComputedStyle(document.documentElement).getPropertyValue(name) || "").trim() || fb;

export class Karaoke {
  // root: 그릴 자리, S: 설정, now(): 소리 시계(초), targets(): 목표 음(scoring.targetsFrom) 또는 null, frames(): 지금까지의 음높이 기록,
  // latency: 기기 지연(초), tol: 허용 센트, octaveFree
  constructor({ root, S, now, targets, frames, latency, tol, octaveFree }) {
    Object.assign(this, { root, S, now, targets, frames, latency, tol, octaveFree });
    this.canvas = document.createElement("canvas");
    this.canvas.className = "kara-canvas";
    this.note = document.createElement("p");
    this.note.className = "kara-note";
    root.append(this.canvas, this.note);
    this.center = null;
    this.raf = 0;
  }

  start() { const loop = () => { this.draw(); this.raf = requestAnimationFrame(loop); }; loop(); }
  stop() { cancelAnimationFrame(this.raf); }
  destroy() { this.stop(); this.canvas.remove(); this.note.remove(); }

  draw() {
    const cv = this.canvas, dpr = Math.min(window.devicePixelRatio || 1, 3), W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const tg = this.targets();
    if (!tg || !tg.length) { this.note.textContent = "시작을 누르면 여기서 노래방처럼 음 막대가 흘러가요."; this.note.hidden = false; return; }
    this.note.hidden = true;
    const S = this.S, now = this.now(), past = S.karaPastSec, ahead = S.karaAheadSec;
    const px = W * S.karaPlayheadAt, x = (t) => px + (t - now) / (ahead) * (W - px);
    const xl = (t) => px - (now - t) / past * px;
    const X = (t) => (t >= now ? x(t) : xl(t));
    const vis = tg.filter((n) => n.t1 > now - past && n.t0 < now + ahead);
    const ps = (vis.length ? vis : tg.slice(0, 4)).map((n) => n.midi);
    const lo = Math.min(...ps), hi = Math.max(...ps);
    const want = (lo + hi) / 2;
    this.center = this.center === null ? want : this.center + (want - this.center) * 0.08;      // 천천히 따라간다 (화면이 출렁이지 않게)
    const span = Math.max(S.karaMinSemis, hi - lo + 4), top = 18, bot = H - 26;
    const y = (p) => bot - (p - (this.center - span / 2)) / span * (bot - top);
    const rowH = Math.max(6, Math.min(22, (bot - top) / span * 0.8));
    const ink = css("--ink", "#1b2233");
    // 반음마다 옅은 줄, 도(C)에는 이름
    g.font = "11px system-ui, sans-serif"; g.textBaseline = "middle";
    for (let p = Math.ceil(this.center - span / 2); p <= this.center + span / 2; p++) {
      const yy = y(p);
      g.fillStyle = p % 12 === 0 ? "rgba(27,34,51,.07)" : "rgba(27,34,51,.03)";
      g.fillRect(0, yy - 0.5, W, 1);
      if (p % 12 === 0) { g.fillStyle = "rgba(27,34,51,.45)"; g.fillText(noteName(p), 4, yy - 7); }
    }
    // 목소리(기기 지연을 뺀 시각) — 막대 색칠과 선에 같이 쓴다
    const lat = this.latency, fr = this.frames().filter((f) => f.t - lat > now - past - 0.2 && f.t - lat <= now + 0.05);
    const at = (t) => tg.find((n) => n.t0 <= t && t < n.t1);
    const fold = (p, m) => { let d = p - m; if (this.octaveFree) d -= 12 * Math.round(d / 12); return d; };
    // 목표 막대
    for (const n of vis) {
      const x0 = X(n.t0), x1 = Math.max(x0 + 3, X(n.t1)), yy = y(n.midi) - rowH / 2;
      const done = n.t0 < now;
      g.fillStyle = done ? "rgba(27,34,51,.12)" : "rgba(31,42,68,.22)";
      roundRect(g, x0, yy, x1 - x0, rowH, Math.min(6, rowH / 2)); g.fill();
      if (n.ref && n.ref.lyric) { g.fillStyle = done ? "rgba(27,34,51,.45)" : ink; g.font = "13px system-ui, sans-serif"; g.fillText(n.ref.lyric, x0 + 2, yy + rowH + 11); }
    }
    // 막대 안에 들어온 순간은 초록으로 채운다
    g.fillStyle = "rgba(30,150,90,.75)";
    for (const f of fr) {
      if (f.pitch === null || f.pitch === undefined) continue;
      const t = f.t - lat, n = at(t);
      if (!n || Math.abs(fold(f.pitch, n.midi)) * 100 > this.tol) continue;
      const x0 = X(t), yy = y(n.midi) - rowH / 2;
      g.fillRect(x0 - 2, yy, 4.5, rowH);
    }
    // 내 목소리 선: 막대 안이면 초록, 밖이면 빨강 (옥타브 무시면 목표와 가장 가까운 옥타브로 옮겨서)
    g.lineWidth = 3; g.lineCap = "round"; g.lineJoin = "round";
    let prev = null;
    for (const f of fr) {
      if (f.pitch === null || f.pitch === undefined) { prev = null; continue; }
      const t = f.t - lat, n = at(t) || tg.reduce((a, b) => (Math.abs(b.t0 - t) < Math.abs(a.t0 - t) ? b : a));
      const p = n.midi + fold(f.pitch, n.midi), ok = at(t) && Math.abs(fold(f.pitch, n.midi)) * 100 <= this.tol;
      const pt = [X(t), y(p)];
      if (prev && t - prev.t < 0.06) {
        g.strokeStyle = ok ? "rgba(30,150,90,1)" : "rgba(215,40,30,.95)";
        g.beginPath(); g.moveTo(prev.pt[0], prev.pt[1]); g.lineTo(pt[0], pt[1]); g.stroke();
      }
      prev = { t, pt };
    }
    // 지금 위치
    g.fillStyle = "rgba(217,130,43,.9)";
    g.fillRect(px - 1, 0, 2, H);
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}
