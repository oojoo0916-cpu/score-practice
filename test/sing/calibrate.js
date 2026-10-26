// 노래 채점 6단계: 박자 보정. 박자 소리 8번에 맞춰 "따!" 하고 소리를 내면, 박자 소리와 내 소리가 마이크로 들어온 때의 차이(중앙값)를
// 이 기기의 지연으로 기억한다. 소리가 스피커·이어폰으로 나가는 시간 + 마이크로 들어오는 시간이 모두 들어 있다(기기·이어폰마다 다르다).
// 박자 판정은 이 값을 빼고 견준다. 블루투스 이어폰은 지연이 커서(0.2~0.3초 넘게) 안내한다.
import { PitchEngine, MicError } from "./pitch-engine.js";
import { current, loadUser, saveUser } from "./settings.js";
import { loadCss } from "./tuner.js";

const h = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
const median = (a) => { const s = a.slice().sort((x, y) => x - y), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const voiced = (f) => f.pitch !== null && f.pitch !== undefined;

// "따" 소리의 시작들: 목소리가 opt.calibMinVoiceMs 이상 이어지는 곳의 시작. 바로 앞 0.08초 안에 소리가 커진 순간(자음 ㄸ)이 있으면 그때로.
// 짧게 새어 들어온 박자 소리(0.05초)는 목소리로 치지 않는다
export function voiceOnsets(frames, opt) {
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    if (!voiced(frames[i]) || (i > 0 && voiced(frames[i - 1]) && frames[i].t - frames[i - 1].t < 0.05)) continue;
    let j = i;
    while (j + 1 < frames.length && voiced(frames[j + 1]) && frames[j + 1].t - frames[j].t < 0.05) j++;
    if ((frames[j].t - frames[i].t) * 1000 + opt.hopMs < opt.calibMinVoiceMs) continue;
    let t = frames[i].t;
    for (let k = i - 1; k >= 0 && frames[k].t >= frames[i].t - 0.08; k--) {
      let mn = Infinity;
      for (let q = k - 1; q >= 0 && frames[q].t >= frames[k].t - 0.1; q--) mn = Math.min(mn, frames[q].db === undefined ? -120 : frames[q].db);
      if (frames[k].db !== undefined && frames[k].db - (mn === Infinity ? -120 : mn) >= opt.onsetRiseDb) t = frames[k].t;
    }
    out.push(t);
  }
  return out;
}

// 박자 소리 시각들과 기록 → { latencyMs, matched, spreadMs, ok }. 박자 소리마다 그 뒤(−0.2 ~ +0.6초) 첫 "따"
export function calibrationResult(frames, clicks, opt) {
  const ons = voiceOnsets(frames, opt);
  const diffs = [];
  for (const c of clicks) {
    const o = ons.find((t) => t >= c - 0.2 && t <= c + 0.6);
    if (o !== undefined) diffs.push(o - c);
  }
  if (!diffs.length) return { latencyMs: null, matched: 0, spreadMs: null, ok: false };
  const m = median(diffs), spread = median(diffs.map((d) => Math.abs(d - m)));
  const out = { latencyMs: Math.round(m * 1000), matched: diffs.length, spreadMs: Math.round(spread * 1000) };
  out.ok = out.matched >= opt.calibMinMatches && out.spreadMs <= opt.calibMaxSpreadMs && out.latencyMs >= 0;
  return out;
}

// 보정 화면. onDone(latencyMs): 저장했을 때
export async function openCalibrate({ sound, onDone = () => {} }) {
  await loadCss();
  const S = { ...current() };
  const root = h("section", "sing-screen sing-calib");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "박자 보정");
  const head = h("header", "sing-head");
  const close = h("button", "icon sing-close", "✕");
  close.setAttribute("aria-label", "박자 보정 닫기");
  head.append(h("b", null, "박자 보정"), close);
  const now = loadUser().latencyMs;
  const intro = h("p", "sing-msg", `노래할 때처럼 이어폰(또는 스피커)을 두고 '시작'을 누르세요. 박자 소리가 ${S.calibLeadClicks + S.calibClicks}번 나요 — `
    + `처음 ${S.calibLeadClicks}번은 듣기만 하고, 그다음 ${S.calibClicks}번에 맞춰 "따!" 하고 짧게 소리 내 주세요.`);
  const dots = h("div", "sing-dots");
  const dotEls = [];
  for (let i = 0; i < S.calibLeadClicks + S.calibClicks; i++) { const d = h("span", "sing-dot" + (i < S.calibLeadClicks ? " lead" : "")); dots.append(d); dotEls.push(d); }
  const msg = h("p", "sing-msg", typeof now === "number" ? `지금 기억한 지연: ${(now / 1000).toFixed(2)}초` : "아직 보정하지 않았어요.");
  const btn = h("button", "btn primary sing-start", "시작");
  root.append(head, intro, dots, msg, btn);
  document.body.append(root);
  const eng = new PitchEngine({ getCtx: () => sound.ensure(), settings: S });
  let busy = false, closed = false, raf = 0;
  const setMsg = (t, err = false) => { msg.textContent = t; msg.classList.toggle("err", err); };

  btn.onclick = async () => {
    if (busy) return;
    busy = true; btn.disabled = true;
    try { await eng.start(); } catch (err) {
      busy = false; btn.disabled = false;
      setMsg(err instanceof MicError ? err.message : "마이크를 켜지 못했어요: " + (err && err.message), true);
      return;
    }
    const ctx = sound.ensure();
    const t0 = ctx.currentTime + 0.4, n = S.calibLeadClicks + S.calibClicks;
    const times = Array.from({ length: n }, (_, i) => t0 + i * S.calibIntervalSec);
    sound.track("calib").gain.value = 0.9;
    times.forEach((t, i) => sound.click(t, i < S.calibLeadClicks ? 1 : 2, "calib"));
    eng.startRecord();
    setMsg("듣고… 박자에 맞춰 \"따!\"");
    const tick = () => {
      const t = ctx.currentTime;
      dotEls.forEach((d, i) => d.classList.toggle("on", t >= times[i] - 0.02));
      if (t < times[n - 1] + 0.8 && !closed) { raf = requestAnimationFrame(tick); return; }
      const rec = eng.stopRecord();
      eng.stop();
      busy = false; btn.disabled = false; btn.textContent = "다시 하기";
      dotEls.forEach((d) => d.classList.remove("on"));
      if (closed) return;
      const r = calibrationResult(rec ? rec.frames : [], times.slice(S.calibLeadClicks), S);
      if (!r.ok) {
        setMsg(r.matched < S.calibMinMatches
          ? `"따" 소리를 ${r.matched}번밖에 못 들었어요. 폰을 입 가까이 두고 조금 더 크게, 박자 소리마다 한 번씩 "따!" 해 주세요.`
          : `소리 낸 때가 들쭉날쭉해요(±${(r.spreadMs / 1000).toFixed(2)}초). 박자 소리에 딱 맞춰 다시 한 번 해 주세요.`, true);
        return;
      }
      saveUser({ ...loadUser(), latencyMs: r.latencyMs, latencyAt: new Date().toLocaleDateString("sv-SE") });      // 이 기기의 날짜(YYYY-MM-DD)
      setMsg(`이 기기의 지연 ${(r.latencyMs / 1000).toFixed(2)}초로 기억했어요 (${r.matched}번 맞춤). 이제 박자 판정에서 이만큼 빼고 견줘요.`
        + (r.latencyMs > S.btWarnMs ? " 지연이 커요 — 블루투스 이어폰이면 소리가 늦게 들려요. 유선 이어폰이나 폰 스피커가 더 정확해요." : ""));
      onDone(r.latencyMs);
    };
    raf = requestAnimationFrame(tick);
  };
  function shut() { closed = true; cancelAnimationFrame(raf); eng.stop(); sound.silence(); root.remove(); document.removeEventListener("visibilitychange", onHide); }
  function onHide() { if (document.hidden) shut(); }
  document.addEventListener("visibilitychange", onHide);
  close.onclick = shut;
  return { close: shut, root };
}
