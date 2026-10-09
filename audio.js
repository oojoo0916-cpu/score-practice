// 소리: 녹음된 그랜드 피아노(Salamander Grand Piano, Alexander Holm, CC BY 3.0)를 단3도 간격으로 받아
// 가장 가까운 녹음을 조금 올리거나 내려서 쓴다. 한 번 받은 소리는 기기에 저장되어 인터넷 없이도 난다.
// 아직 못 받은 음은 임시로 만든 소리로 대신 낸다.
const BASE = "https://tonejs.github.io/audio/salamander/";
const NAMES = ["A", "C", "Ds", "Fs"];
const SAMPLES = [];                                    // [{midi, name}]  A0(21)부터 C8(108)까지 3반음 간격
for (let midi = 21, i = 0; midi <= 108; midi += 3, i++) {
  const oct = Math.floor((midi - 12) / 12);
  SAMPLES.push({ midi, name: NAMES[i % 4] + oct });
}
const MAX_SEC = 7;                                     // 폰 메모리를 아끼려고 녹음을 7초까지만, 한 채널로 보관

export class Sound {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.loading = new Map();
    this.tracks = new Map();
    this.live = new Set();
    this.onStatus = () => {};
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: "interactive" });
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 3;
      this.master.connect(comp).connect(this.ctx.destination);
    }
    if (this.ctx.state !== "running") this.ctx.resume();
    return this.ctx;
  }

  track(id) {
    if (!this.tracks.has(id)) {
      const g = this.ctx.createGain();
      g.connect(this.master);
      this.tracks.set(id, g);
    }
    return this.tracks.get(id);
  }

  setTrackGain(id, v) {
    if (!this.ctx) return;
    this.track(id).gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  // 이 곡에 필요한 음역의 녹음만 받는다
  async load(lo, hi) {
    this.ensure();
    const need = SAMPLES.filter((s) => s.midi >= lo - 3 && s.midi <= hi + 3 && !this.buffers.has(s.midi));
    let done = 0, failed = 0;
    if (need.length) this.onStatus(`피아노 소리 받는 중 0/${need.length}`);
    await Promise.all(need.map((s) => {
      if (!this.loading.has(s.midi)) {
        this.loading.set(s.midi, fetch(BASE + s.name + ".mp3")
          .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
          .then((ab) => new Promise((ok, no) => this.ctx.decodeAudioData(ab, ok, no)))
          .then((buf) => { this.buffers.set(s.midi, this.trim(buf)); }));
      }
      return this.loading.get(s.midi).then(() => { done++; }, () => { failed++; this.loading.delete(s.midi); })
        .then(() => this.onStatus(done + failed < need.length ? `피아노 소리 받는 중 ${done + failed}/${need.length}` : ""));
    }));
    if (failed) this.onStatus("피아노 소리를 일부 받지 못했어요. 인터넷이 될 때 한 번 열어 주세요. (지금은 임시 소리로 나요)");
    return failed === 0;
  }

  trim(buf) {
    const n = Math.min(buf.length, Math.floor(buf.sampleRate * MAX_SEC));
    const out = this.ctx.createBuffer(1, n, buf.sampleRate);
    const d = out.getChannelData(0);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const s = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] += s[i] / buf.numberOfChannels;
    }
    const fade = Math.min(n, Math.floor(buf.sampleRate * 0.5));
    for (let i = 0; i < fade; i++) d[n - 1 - i] *= i / fade;
    return out;
  }

  note(trackId, midi, when, dur, vel = 0.7, legato = false) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.connect(this.track(trackId));
    let best = null;
    for (const m of this.buffers.keys()) if (best === null || Math.abs(m - midi) < Math.abs(best - midi)) best = m;
    const hold = Math.max(0.06, dur) + (legato ? 0.06 : 0);
    let src;
    if (best !== null && Math.abs(best - midi) <= 4) {
      src = ctx.createBufferSource();
      src.buffer = this.buffers.get(best);
      src.playbackRate.value = Math.pow(2, (midi - best) / 12);
      g.gain.setValueAtTime(vel, when);
    } else {                                            // 임시 소리
      src = ctx.createOscillator();
      src.type = "triangle";
      src.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(vel * 0.5, when + 0.01);
      g.gain.setTargetAtTime(vel * 0.25, when + 0.02, 0.3);
    }
    g.gain.setTargetAtTime(0, when + hold, 0.09);        // 건반에서 손을 뗄 때처럼 짧게 사라진다
    src.connect(g);
    src.start(when);
    src.stop(when + hold + 0.7);
    const item = { src, g };
    this.live.add(item);
    src.onended = () => { this.live.delete(item); g.disconnect(); };
  }

  click(when, accent, trackId = "metro") {
    const ctx = this.ctx;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.6, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g).connect(this.track(trackId));
    o.start(when); o.stop(when + 0.07);
    const item = { src: o, g };
    this.live.add(item);
    o.onended = () => { this.live.delete(item); g.disconnect(); };
  }

  // 지금 울리거나 예약된 소리를 모두 끈다
  silence() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const { src, g } of this.live) {
      try { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0, t, 0.02); src.stop(t + 0.12); } catch (e) { /* 이미 끝난 소리 */ }
    }
    this.live.clear();
  }
}
