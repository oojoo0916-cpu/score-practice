// 노래 채점 1단계: 마이크 테스트(튜너) 화면. 지금 내는 음이 무엇인지, 몇 센트 벗어났는지, 최근 몇 초의 음 높낮이를 보여 준다.
// 화면 요소는 여기서 만든다 (index.html 은 건드리지 않는다). 닫으면 마이크를 확실히 끈다.
import { PitchEngine, MicError } from "./pitch-engine.js";
import { current } from "./settings.js";
import { noteName } from "../edits.js";

let css = null;
export function loadCss() {
  css = css || new Promise((ok) => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = new URL("./sing.css", import.meta.url).href;
    l.onload = l.onerror = () => ok();
    document.head.append(l);
  });
  return css;
}

const h = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };

// sound: 앱의 소리(audio.js 의 Sound) — 반주와 같은 소리 시계를 쓴다
export async function openTuner({ sound }) {
  await loadCss();
  const S = current();
  const root = h("section", "sing-screen sing-tuner");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "마이크 테스트");
  const head = h("header", "sing-head");
  const close = h("button", "icon sing-close", "✕");
  close.setAttribute("aria-label", "마이크 테스트 닫기");
  head.append(h("b", null, "마이크 테스트"), close);
  const note = h("div", "sing-note", "—");
  const hz = h("div", "sing-hz", " ");
  const meter = h("div", "sing-meter");
  const needle = h("div", "sing-needle");
  meter.append(h("div", "sing-zone"), needle, h("span", "sing-tick l", "-50"), h("span", "sing-tick c", "0"), h("span", "sing-tick r", "+50"));
  const cents = h("div", "sing-cents", " ");
  const canvas = h("canvas", "sing-graph");
  const msg = h("p", "sing-msg", "아래 '마이크 켜기'를 누르고 한 음을 길게 불러 보세요. 처음에는 마이크를 써도 되는지 묻는 창이 떠요 — '허용'을 눌러 주세요.");
  const btn = h("button", "btn primary sing-start", "마이크 켜기");
  const foot = h("p", "sing-foot small", `기준 음 A4 = ${S.a4}Hz · 이어폰을 끼면 더 정확해요`);
  root.append(head, note, hz, meter, cents, canvas, msg, btn, foot);
  document.body.append(root);

  const eng = new PitchEngine({ getCtx: () => sound.ensure(), settings: S });
  const hist = [];                        // 그래프용 최근 기록 [{t, pitch}]
  let latest = null, raf = 0, center = null, closed = false;

  const setMsg = (t, err = false) => { msg.textContent = t; msg.classList.toggle("err", err); };
  eng.onPitch = (p) => {
    latest = p;
    hist.push({ t: p.t, pitch: p.pitch });
    const keep = p.t - S.tunerGraphSec - 0.5;
    while (hist.length && hist[0].t < keep) hist.shift();
  };
  eng.onError = (err) => { setMsg(err.message, true); btn.textContent = "마이크 켜기"; cancelAnimationFrame(raf); };

  function color(c) { const a = Math.abs(c); return a <= S.tunerGoodCents ? "good" : a <= S.tunerWarnCents ? "warn" : "bad"; }

  function draw() {
    raf = requestAnimationFrame(draw);
    const p = latest;
    if (p && p.hz > 0) {
      note.textContent = p.name;
      hz.textContent = p.hz.toFixed(1) + " Hz";
      cents.textContent = (p.cents > 0 ? "+" : "") + p.cents.toFixed(0) + " 센트" + (Math.abs(p.cents) <= S.tunerGoodCents ? " · 맞아요" : p.cents > 0 ? " · 조금 높아요" : " · 조금 낮아요");
      needle.style.left = (50 + Math.max(-50, Math.min(50, p.cents))) + "%";
      root.dataset.state = color(p.cents);
    } else if (p) {
      root.dataset.state = "none";
      cents.textContent = "소리를 기다리는 중…";
    }
    graph();
  }

  function graph() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3), W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const now = eng.ctx ? eng.ctx.currentTime : 0, span = S.tunerGraphSec, semis = S.tunerGraphSemis;
    // 가운데 음: 지금 음이 그래프 밖으로 나가려 하면 옮긴다
    const lastP = [...hist].reverse().find((x) => x.pitch !== null);
    if (lastP && (center === null || Math.abs(lastP.pitch - center) > semis - 1)) center = Math.round(lastP.pitch);
    const c0 = center === null ? 69 : center;
    const y = (p) => H / 2 - (p - c0) / semis * (H / 2);
    const x = (t) => W - (now - t) / span * W;
    g.font = "11px system-ui, sans-serif";
    for (let m = Math.ceil(c0 - semis); m <= Math.floor(c0 + semis); m++) {
      const nat = ![1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
      g.strokeStyle = m === Math.round(c0) ? "rgba(31,111,92,.45)" : nat ? "rgba(27,34,51,.16)" : "rgba(27,34,51,.06)";
      g.beginPath(); g.moveTo(0, y(m)); g.lineTo(W, y(m)); g.stroke();
      if (nat) { g.fillStyle = "rgba(27,34,51,.55)"; g.fillText(noteName(m), 4, y(m) - 2); }
    }
    g.lineWidth = 2.5;
    g.lineJoin = "round";
    let prev = null;
    for (const s of hist) {
      if (s.pitch === null || (prev && s.t - prev.t > 0.08)) { prev = s.pitch === null ? null : s; continue; }
      if (prev) {
        const cc = Math.abs((s.pitch - Math.round(s.pitch)) * 100);
        g.strokeStyle = cc <= S.tunerGoodCents ? "#1f6f5c" : cc <= S.tunerWarnCents ? "#d9822b" : "#b3261e";
        g.beginPath(); g.moveTo(x(prev.t), y(prev.pitch)); g.lineTo(x(s.t), y(s.pitch)); g.stroke();
      }
      prev = s;
    }
  }

  async function toggle() {
    if (eng.running) {
      eng.stop();
      cancelAnimationFrame(raf);
      btn.textContent = "마이크 켜기";
      setMsg("마이크를 껐어요.");
      return;
    }
    btn.disabled = true;
    setMsg("마이크를 켜는 중…");
    try {
      await eng.start();
      if (closed) { eng.stop(); return; }
      btn.textContent = "마이크 끄기";
      setMsg("한 음을 길게 불러 보세요. 초록이면 ±" + S.tunerGoodCents + "센트 안이에요.");
      draw();
    } catch (err) {
      setMsg(err instanceof MicError ? err.message : "마이크를 켜지 못했어요: " + (err && err.message), true);
      if (!(err instanceof MicError)) console.error(err);
    } finally { btn.disabled = false; }
  }

  function shut() {
    closed = true;
    eng.stop();
    cancelAnimationFrame(raf);
    document.removeEventListener("visibilitychange", onHide);
    root.remove();
  }
  // 앱을 내리거나 화면을 끄면 마이크도 끈다 (주소창의 마이크 표시가 남지 않게)
  function onHide() { if (document.hidden && eng.running) { eng.stop(); cancelAnimationFrame(raf); btn.textContent = "마이크 켜기"; setMsg("화면을 벗어나서 마이크를 껐어요. 다시 켜 주세요."); } }
  document.addEventListener("visibilitychange", onHide);
  btn.onclick = toggle;
  close.onclick = shut;
  return { close: shut, engine: eng, root };
}
