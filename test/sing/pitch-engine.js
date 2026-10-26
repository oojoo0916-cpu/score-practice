// 노래 채점 1단계: 마이크로 들어온 목소리의 음높이를 찾는다. 화면과 무관하다 (튜너·메아리·부르기 모드가 가져다 쓴다).
//
// 쓰는 법:
//   const eng = new PitchEngine({ getCtx: () => sound.ensure() });   // 반주와 같은 소리 시계를 쓴다 (그래야 박자를 견줄 수 있다)
//   eng.onPitch = (p) => { ... };       // 음높이를 구할 때마다 (1초에 60번쯤)
//   await eng.start();                  // 단추를 누른 그 순간에 불러야 한다 (아이폰은 단추를 눌러야 소리가 켜진다)
//   eng.startRecord(); ... const rec = eng.stopRecord();   // 그 사이의 음높이 기록 전체 + 원본 소리
//   eng.stop();                         // 마이크를 확실히 끈다 (주소창의 마이크 표시가 사라진다)
//
// 음높이 기록 하나: { t: 소리 시계(초), hz, name: "G4", midi: 67, cents: 가장 가까운 음에서 몇 센트 벗어났는지,
//                    pitch: 소수까지의 음높이(67.12 = G4 보다 12센트 높음), conf: 또렷함(0~1, 신뢰도), db: 소리 크기(dBFS) }
// 음이 없을 때(무음·숨소리·잡음)는 hz: 0, name: "", midi·cents·pitch: null.
//
// 음 찾기는 YIN 방식(소리가 몇 칸마다 되풀이되는지 재는 방식)을 직접 짰다. 바깥 라이브러리를 쓰지 않는다(인터넷 없이도 동작).
// 폰에서 가볍게: 소리를 1/3 쯤으로 줄여서(16000 점/초) 계산한다. 노래의 기본음(최고 1100Hz)을 찾기에는 충분하다.
import { SING } from "./settings.js";
import { noteName } from "../edits.js";

// ---- 순수 계산 (시험할 수 있게 밖으로 꺼내 둔다)

export const hzToPitch = (hz, a4 = SING.a4) => 69 + 12 * Math.log2(hz / a4);
export const pitchToHz = (p, a4 = SING.a4) => a4 * Math.pow(2, (p - 69) / 12);

export function rmsDb(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / Math.max(1, x.length) + 1e-12);
}

// YIN: 한 토막(x, 초당 sr 점)에서 기본 주파수를 찾는다. → { hz (못 찾으면 0), conf: 또렷함 0~1 }
export function detectPitch(x, sr, opt = SING) {
  const tauMin = Math.max(2, Math.floor(sr / opt.maxHz));
  const tauMax = Math.floor(sr / opt.minHz);
  const w = x.length - tauMax;
  if (tauMax <= tauMin + 2 || w < tauMax) return { hz: 0, conf: 0 };        // 토막이 가장 낮은 음 두 주기보다 짧다
  const d = new Float32Array(tauMax + 2);
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let s = 0;
    for (let j = 0; j < w; j++) { const v = x[j] - x[j + tau]; s += v * v; }
    d[tau] = s;
  }
  // 누적 평균으로 나눈 차이 (d' — 0 에 가까울수록 그 주기로 되풀이된다)
  const dn = new Float32Array(tauMax + 2);
  dn[0] = 1;
  let acc = 0;
  for (let tau = 1; tau <= tauMax + 1; tau++) { acc += d[tau]; dn[tau] = acc > 0 ? d[tau] * tau / acc : 1; }
  // 문턱 아래로 처음 내려가는 골 (낮은 옥타브로 잘못 잡는 것을 막는다). 없으면 가장 깊은 골
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (dn[t] < opt.yinThreshold) { while (t + 1 <= tauMax && dn[t + 1] < dn[t]) t++; tau = t; break; }
  }
  if (tau < 0) { tau = tauMin; for (let t = tauMin + 1; t <= tauMax; t++) if (dn[t] < dn[tau]) tau = t; }
  const conf = Math.max(0, Math.min(1, 1 - dn[tau]));
  // 골 바닥을 포물선으로 다듬어 한 칸보다 잘게 (높은 음에서 몇 센트까지 맞추려면 필요하다)
  let ft = tau;
  if (tau > 1 && tau <= tauMax) {
    const a = dn[tau - 1], b = dn[tau], c = dn[tau + 1], den = a - 2 * b + c;
    if (den > 0) ft = tau + Math.max(-1, Math.min(1, 0.5 * (a - c) / den));
  }
  return { hz: sr / ft, conf };
}

// 튀는 값을 다듬는다: 최근 n 개의 중앙값. 옥타브를 한두 번 잘못 잡아도 사라진다
export class Smoother {
  constructor(n = SING.medianFrames) { this.n = Math.max(1, n); this.v = []; }
  reset() { this.v = []; }
  push(p) {
    this.v.push(p);
    if (this.v.length > this.n) this.v.shift();
    const s = this.v.slice().sort((a, b) => a - b), k = s.length >> 1;
    return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
  }
}

const NONE = { hz: 0, name: "", midi: null, cents: null, pitch: null };

// 들어오는 소리를 받아 hop 마다 음높이 기록 하나를 내놓는다. sr: 원래 소리의 초당 점 수.
// push(data, t0): data = 소리 조각, t0 = 그 첫 점의 소리 시계(초). 기록의 t 는 들여다본 토막의 가운데 시각이다
export class Analyzer {
  constructor(sr, onFrame, opt = SING) {
    this.opt = opt;
    this.onFrame = onFrame;
    this.sr = sr;
    this.f = Math.max(1, Math.round(sr / opt.analysisRate));      // 몇 점마다 한 점을 남길지
    this.ar = sr / this.f;                                      // 줄인 뒤의 초당 점 수
    this.win = Math.ceil(opt.windowMs / 1000 * this.ar);
    this.hop = Math.max(1, Math.round(opt.hopMs / 1000 * this.ar));
    this.ring = new Float32Array(this.win);
    this.w = 0; this.filled = 0; this.since = 0; this.phase = 0;
    this.frame = new Float32Array(this.win);
    this.smooth = new Smoother(opt.medianFrames);
    this.silentSince = null;
    // 줄이기 전에 높은 소리를 걸러 낸다 (줄일 때 높은 소리가 낮은 소리로 섞여 들지 않게): 2차 저역 필터, 차단 = 줄인 뒤 범위의 40%
    const fc = Math.min(0.45 * sr, 0.4 * this.ar), q = Math.SQRT1_2, w0 = 2 * Math.PI * fc / sr, al = Math.sin(w0) / (2 * q), cs = Math.cos(w0), a0 = 1 + al;
    this.bq = { b0: (1 - cs) / 2 / a0, b1: (1 - cs) / a0, b2: (1 - cs) / 2 / a0, a1: -2 * cs / a0, a2: (1 - al) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
  }

  push(data, t0) {
    const bq = this.bq, f = this.f;
    for (let i = 0; i < data.length; i++) {
      const x = data[i];
      const y = f > 1 ? bq.b0 * x + bq.b1 * bq.x1 + bq.b2 * bq.x2 - bq.a1 * bq.y1 - bq.a2 * bq.y2 : x;
      if (f > 1) { bq.x2 = bq.x1; bq.x1 = x; bq.y2 = bq.y1; bq.y1 = y; }
      if (this.phase++ % f) continue;
      this.ring[this.w] = y;
      this.w = (this.w + 1) % this.win;
      if (this.filled < this.win) this.filled++;
      if (++this.since >= this.hop && this.filled === this.win) {
        this.since = 0;
        this.analyze(t0 + i / this.sr - (this.win / 2) / this.ar);
      }
    }
  }

  analyze(t) {
    const o = this.opt, fr = this.frame, n = this.win;
    for (let k = 0; k < n; k++) fr[k] = this.ring[(this.w + k) % n];
    const db = rmsDb(fr);
    let out;
    if (db < o.minDb) out = { t, ...NONE, conf: 0, db };
    else {
      const { hz, conf } = detectPitch(fr, this.ar, o);
      if (!hz || conf < o.minClarity || hz < o.minHz * 0.97 || hz > o.maxHz * 1.03) out = { t, ...NONE, conf, db };
      else {
        const pitch = this.smooth.push(hzToPitch(hz, o.a4));
        const midi = Math.round(pitch);
        out = { t, hz: pitchToHz(pitch, o.a4), name: noteName(midi), midi, cents: Math.round((pitch - midi) * 1000) / 10, pitch, conf, db };
        this.silentSince = null;
      }
    }
    if (out.hz === 0) {                       // 음 없음이 이어지면 다듬기를 새로 시작한다 (앞 음이 다음 음에 섞이지 않게)
      if (this.silentSince === null) this.silentSince = t;
      else if (t - this.silentSince >= o.gapResetMs / 1000) this.smooth.reset();
    }
    this.onFrame(out);
  }
}

// ---- 마이크

// 마이크를 켜지 못한 까닭 → 쉬운 말
export const MIC_TEXT = {
  insecure: "이 주소에서는 마이크를 쓸 수 없어요. 인터넷 주소(https://…)로 연 앱에서 해 주세요. (집 와이파이 주소로 연 앱에서는 마이크가 꺼져 있어요)",
  unsupported: "이 브라우저는 마이크를 쓸 수 없어요. 아이폰은 Safari, 안드로이드는 크롬으로 열어 주세요. (카카오톡 안의 브라우저에서는 안 될 수 있어요)",
  denied: "마이크 사용을 허락하지 않았어요. 아이폰: 설정 → Safari → 마이크 → '허용'. 안드로이드: 주소창 왼쪽 자물쇠 → 권한 → 마이크 '허용'. 그다음 이 화면을 다시 열어 주세요.",
  nodevice: "마이크를 찾지 못했어요. 이어폰 마이크가 제대로 꽂혔는지 확인해 주세요.",
  busy: "다른 앱(전화·녹음·영상통화)이 마이크를 쓰고 있어요. 그 앱을 끄고 다시 해 주세요.",
  ended: "마이크가 끊겼어요 (전화가 왔거나 이어폰을 뺐을 수 있어요). 다시 켜 주세요.",
  other: "마이크를 켜지 못했어요. 앱을 닫았다가 다시 열어 주세요.",
};

export class MicError extends Error {
  constructor(kind, cause) { super(MIC_TEXT[kind] || MIC_TEXT.other); this.kind = kind; this.cause = cause; }
}

function micKind(err) {
  const n = err && err.name;
  if (n === "NotAllowedError" || n === "SecurityError" || n === "PermissionDeniedError") return "denied";
  if (n === "NotFoundError" || n === "OverconstrainedError" || n === "DevicesNotFoundError") return "nodevice";
  if (n === "NotReadableError" || n === "AbortError" || n === "TrackStartError") return "busy";
  return "other";
}

const loaded = new WeakSet();             // 워크릿 파일을 불러온 소리 시계

export class PitchEngine {
  constructor({ getCtx, settings = SING } = {}) {
    this.getCtx = getCtx;
    this.opt = settings;
    this.onPitch = () => {};
    this.onError = () => {};              // 켜 둔 마이크가 도중에 끊겼을 때 (MicError)
    this.running = false;
    this.rec = null;
    this.last = null;                     // 가장 최근 기록
  }

  // 단추를 누른 그 순간에 부른다: 소리 시계를 여기서 깨운다(아이폰). 실패하면 MicError
  async start() {
    if (this.running) return;
    const ctx = this.getCtx();            // await 보다 먼저 (단추 누름이 이어지는 동안)
    if (ctx.state !== "running") ctx.resume().catch(() => {});
    if (typeof window !== "undefined" && window.isSecureContext === false) throw new MicError("insecure");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new MicError("unsupported");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...this.opt.mic, channelCount: 1 }, video: false });
    } catch (err) { throw new MicError(micKind(err), err); }
    try {
      if (ctx.state !== "running") await ctx.resume().catch(() => {});
      this.ctx = ctx;
      this.stream = stream;
      this.analyzer = new Analyzer(ctx.sampleRate, (p) => this.frame(p), this.opt);
      this.src = ctx.createMediaStreamSource(stream);
      this.mute = ctx.createGain();       // 처리 줄이 돌게 끝(스피커)까지 잇되 소리는 내지 않는다 (마이크 소리가 스피커로 나오지 않게)
      this.mute.gain.value = 0;
      this.mute.connect(ctx.destination);
      if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
        if (!loaded.has(ctx)) { await ctx.audioWorklet.addModule(new URL("./pitch-worklet.js", import.meta.url).href); loaded.add(ctx); }
        this.node = new AudioWorkletNode(ctx, "pitch-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
        this.node.port.onmessage = (e) => this.chunk(e.data.data, e.data.frame / ctx.sampleRate);
      } else {                            // 오래된 브라우저: 옛 방식(ScriptProcessor). 시각은 조금 덜 정확하다
        this.node = ctx.createScriptProcessor(2048, 1, 1);
        this.node.onaudioprocess = (e) => {
          const d = e.inputBuffer.getChannelData(0);
          this.chunk(new Float32Array(d), ctx.currentTime - d.length / ctx.sampleRate);
        };
      }
      this.src.connect(this.node);
      this.node.connect(this.mute);
      for (const tr of stream.getAudioTracks()) tr.onended = () => { if (this.running) { this.stop(); this.onError(new MicError("ended")); } };
      this.running = true;
    } catch (err) {
      for (const tr of stream.getTracks()) tr.stop();
      throw err instanceof MicError ? err : new MicError("other", err);
    }
  }

  chunk(data, t0) {
    if (!this.running) return;
    if (this.rec && this.rec.len < this.rec.max) { this.rec.audio.push(data); this.rec.len += data.length; if (this.rec.t0a === null) this.rec.t0a = t0; }
    this.analyzer.push(data, t0);
  }

  frame(p) {
    this.last = p;
    if (this.rec) this.rec.frames.push(p);
    this.onPitch(p);
  }

  // 지금부터 음높이 기록과 원본 소리를 모은다
  startRecord() {
    const sr = this.ctx ? this.ctx.sampleRate : 48000;
    this.rec = { t0: this.ctx ? this.ctx.currentTime : 0, frames: [], audio: [], len: 0, t0a: null, max: Math.round(this.opt.maxRecordSec * sr) };
  }

  // 모은 것을 돌려주고 그만 모은다 → { t0, t1, frames: [기록...], audio: Float32Array (원본 소리), audioT0: 그 첫 점의 시각, sampleRate }
  stopRecord() {
    const r = this.rec;
    this.rec = null;
    if (!r) return null;
    const audio = new Float32Array(r.len);
    let k = 0;
    for (const a of r.audio) { audio.set(a.subarray(0, Math.min(a.length, r.len - k)), k); k += a.length; if (k >= r.len) break; }
    return { t0: r.t0, t1: this.ctx ? this.ctx.currentTime : r.t0, frames: r.frames, audio, audioT0: r.t0a, sampleRate: this.ctx ? this.ctx.sampleRate : 48000 };
  }

  // 마이크를 끈다. 반주와 같이 쓰는 소리 시계는 끄지 않는다
  stop() {
    this.running = false;
    this.rec = null;
    try { if (this.node && this.node.port) { this.node.port.postMessage("stop"); this.node.port.onmessage = null; } } catch (err) { /* 이미 끊김 */ }
    if (this.node) { this.node.onaudioprocess = null; try { this.node.disconnect(); } catch (err) { /* 이미 끊김 */ } }
    if (this.src) try { this.src.disconnect(); } catch (err) { /* 이미 끊김 */ }
    if (this.mute) try { this.mute.disconnect(); } catch (err) { /* 이미 끊김 */ }
    if (this.stream) for (const tr of this.stream.getTracks()) { tr.onended = null; tr.stop(); }
    this.node = this.src = this.mute = this.stream = null;
  }
}
