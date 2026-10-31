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

// YIN: 한 토막(x, 초당 sr 점)에서 기본 주파수를 찾는다. → { hz (못 찾으면 0), conf: 또렷함 0~1, cands: [{ hz, conf }] }
// cands: 골이 여럿이면 그 후보들(또렷한 순, 가장 그럴듯한 것 포함) — 스피커로 반주가 섞일 때 반주 음을 빼고 목소리를 고르는 데 쓴다(8단계)
export function detectPitch(x, sr, opt = SING) {
  const tauMin = Math.max(2, Math.floor(sr / opt.maxHz));
  const tauMax = Math.floor(sr / opt.minHz);
  const w = x.length - tauMax;
  if (tauMax <= tauMin + 2 || w < tauMax) return { hz: 0, conf: 0, cands: [] };        // 토막이 가장 낮은 음 두 주기보다 짧다
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
  const refine = (t) => {
    if (t <= 1 || t > tauMax) return t;
    const a = dn[t - 1], b = dn[t], c = dn[t + 1], den = a - 2 * b + c;
    return den > 0 ? t + Math.max(-1, Math.min(1, 0.5 * (a - c) / den)) : t;
  };
  // 다른 골들(후보): 이웃보다 낮고 문턱(candThreshold) 아래인 곳. 이미 고른 골과 거의 같은 주기는 빼고, 또렷한 순으로 몇 개만
  const cands = [{ hz: sr / refine(tau), conf }];
  const others = [];
  for (let t = tauMin + 1; t < tauMax; t++) {
    if (dn[t] < (opt.candThreshold || 0) && dn[t] <= dn[t - 1] && dn[t] < dn[t + 1] && Math.abs(t - tau) > 1) others.push(t);
  }
  others.sort((a, b) => dn[a] - dn[b]);
  for (const t of others.slice(0, Math.max(0, (opt.maxCands || 1) - 1))) cands.push({ hz: sr / refine(t), conf: Math.max(0, 1 - dn[t]) });
  return { hz: cands[0].hz, conf, cands };
}

// ---- 섞인 소리의 후보 (8단계): 소리를 주파수별로 나눠(FFT) 음마다 "배음이 얼마나 센지"를 더해 본다(배음 합).
// YIN 은 섞인 소리에서 두 음의 "가운데쯤"을 하나 내놓지만, 배음 합은 목소리와 피아노 음을 따로 봉우리로 보여 준다.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k], br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi; re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
const HS_N = 2048;
const hsBuf = { re: new Float64Array(HS_N), im: new Float64Array(HS_N), mag: new Float64Array(HS_N / 2) };

// → [{ hz, conf }] 배음 합이 큰 순 (가장 큰 것의 opt.hsMinRel 배 넘는 봉우리만, opt.hsTopN 개까지)
export function harmonicCands(x, sr, opt = SING) {
  const { re, im, mag } = hsBuf, n = Math.min(x.length, HS_N);
  re.fill(0); im.fill(0);
  for (let i = 0; i < n; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));      // 한 토막의 양 끝을 부드럽게
  fft(re, im);
  for (let k = 0; k < HS_N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
  const binOf = (f) => f * HS_N / sr, at = (f) => { const b = Math.round(binOf(f)); return b > 0 && b < HS_N / 2 - 1 ? Math.max(mag[b - 1], mag[b], mag[b + 1]) : 0; };
  const grid = [], hs = [];
  for (let c = 1200 * Math.log2(opt.minHz / 440); c <= 1200 * Math.log2(opt.maxHz / 440); c += opt.hsStepCents) {
    const f = 440 * Math.pow(2, c / 1200);
    let sum = 0, w = 1;
    for (let h = 1; h <= opt.hsHarmonics && h * f < sr / 2; h++) { sum += w * at(h * f); w *= opt.hsDecay; }
    grid.push(f); hs.push(sum);
  }
  const top = Math.max(...hs);
  if (!(top > 0)) return [];
  const span = Math.max(1, Math.round(30 / opt.hsStepCents)), peaks = [];
  for (let i = 0; i < hs.length; i++) {
    if (hs[i] < top * opt.hsMinRel) continue;
    let isPeak = true;
    for (let j = Math.max(0, i - span); j <= Math.min(hs.length - 1, i + span); j++) if (hs[j] > hs[i]) { isPeak = false; break; }
    if (isPeak) peaks.push(i);
  }
  peaks.sort((a, b) => hs[b] - hs[a]);
  return peaks.slice(0, opt.hsTopN).map((i) => ({ hz: grid[i], conf: Math.round(hs[i] / top * 0.9 * 100) / 100 }));
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

// 녹음해 두는 소리: 분석용으로 줄인 소리(초당 16000점쯤, 목소리에는 충분하다)를 토막으로 모은다.
// 원래 소리(48000점)를 그대로 두면 곡 하나(3~4분)에 수십 MB 라 폰 메모리가 모자랄 수 있다
class RecBuf {
  constructor(max) { this.max = max; this.blocks = []; this.cur = new Float32Array(16384); this.pos = 0; this.n = 0; this.t0 = null; }
  add(y, t) {
    if (this.n >= this.max) return;
    if (this.t0 === null) this.t0 = t;
    if (this.pos === this.cur.length) { this.blocks.push(this.cur); this.cur = new Float32Array(16384); this.pos = 0; }
    this.cur[this.pos++] = y;
    this.n++;
  }
  toArray() {
    const out = new Float32Array(this.n);
    let k = 0;
    for (const b of this.blocks) { out.set(b, k); k += b.length; }
    out.set(this.cur.subarray(0, this.pos), k);
    return out;
  }
}

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
    this.keep = null;                      // 녹음 중이면 RecBuf (줄인 소리를 모은다)
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
      if (this.keep) this.keep.add(y, t0 + i / this.sr);
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
      const { hz, conf, cands: yc } = detectPitch(fr, this.ar, o);
      // 후보 = YIN 의 골들 + 배음 합의 봉우리 (거의 같은 음은 하나로)
      // 배음 합(FFT)은 스피커일 때만 — 이어폰이면 반주가 섞이지 않아 필요 없고, 폰에서 계산을 아낀다
      const hc = o.output === "speaker" ? harmonicCands(fr, this.ar, o) : [];
      const cands = [...yc.map((c) => ({ ...c, src: "y" })), ...hc.map((c) => ({ ...c, src: "h" }))];
      // 후보들(다듬지 않은 소수 음높이): 스피커로 반주가 섞일 때 쓴다. 범위 밖은 뺀다
      const cp = cands.filter((c) => c.hz >= o.minHz * 0.97 && c.hz <= o.maxHz * 1.03 && (c.src === "h" || c.conf >= o.candMinClarity))
        .map((c) => ({ p: Math.round(hzToPitch(c.hz, o.a4) * 1000) / 1000, c: Math.round(c.conf * 100) / 100, s: c.src }));
      if (!hz || conf < o.minClarity || hz < o.minHz * 0.97 || hz > o.maxHz * 1.03) out = { t, ...NONE, conf, db, cands: cp };
      else {
        const pitch = this.smooth.push(hzToPitch(hz, o.a4));
        const midi = Math.round(pitch);
        out = { t, hz: pitchToHz(pitch, o.a4), name: noteName(midi), midi, cents: Math.round((pitch - midi) * 1000) / 10, pitch, conf, db, cands: cp };
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
    this.analyzer.push(data, t0);
  }

  frame(p) {
    this.last = p;
    if (this.rec) this.rec.frames.push(p);
    this.onPitch(p);
  }

  // 지금부터 음높이 기록과 소리를 모은다
  startRecord() {
    this.rec = { t0: this.ctx ? this.ctx.currentTime : 0, frames: [] };
    if (this.analyzer) this.analyzer.keep = new RecBuf(Math.round(this.opt.maxRecordSec * this.analyzer.ar));
  }

  // 녹음하는 동안 지금까지의 음높이 기록 (부르는 중에 색칠하기·박자 보정 점 표시용)
  liveFrames() { return this.rec ? this.rec.frames : []; }

  // 모은 것을 돌려주고 그만 모은다 → { t0, t1, frames: [기록...], audio: Float32Array (소리, 줄인 것), audioT0: 그 첫 점의 시각, sampleRate }
  stopRecord() {
    const r = this.rec, a = this.analyzer, keep = a && a.keep;
    this.rec = null;
    if (a) a.keep = null;
    if (!r) return null;
    return { t0: r.t0, t1: this.ctx ? this.ctx.currentTime : r.t0, frames: r.frames, audio: keep ? keep.toArray() : new Float32Array(0),
      audioT0: keep && keep.t0 !== null ? keep.t0 : r.t0, sampleRate: a ? a.ar : 16000 };
  }

  // 마이크를 끈다. 반주와 같이 쓰는 소리 시계는 끄지 않는다
  stop() {
    this.running = false;
    this.rec = null;
    if (this.analyzer) this.analyzer.keep = null;
    try { if (this.node && this.node.port) { this.node.port.postMessage("stop"); this.node.port.onmessage = null; } } catch (err) { /* 이미 끊김 */ }
    if (this.node) { this.node.onaudioprocess = null; try { this.node.disconnect(); } catch (err) { /* 이미 끊김 */ } }
    if (this.src) try { this.src.disconnect(); } catch (err) { /* 이미 끊김 */ }
    if (this.mute) try { this.mute.disconnect(); } catch (err) { /* 이미 끊김 */ }
    if (this.stream) for (const tr of this.stream.getTracks()) { tr.onended = null; tr.stop(); }
    this.node = this.src = this.mute = this.stream = null;
  }
}
