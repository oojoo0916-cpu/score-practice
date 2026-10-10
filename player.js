// 재생기: 음표를 조금 앞서 예약해 두는 방식. 멈춤·이어서·구간 반복·빠르기 변경에도 위치(박)를 잃지 않는다.
import { unfold, mergedNotes, splitLines, chordEvents, clickEvents, buildTimeline } from "./music.js";

const AHEAD = 0.35;          // 몇 초 앞까지 미리 예약할지
const TICK = 30;             // 예약 점검 간격(ms)

export class Player {
  constructor(song, sound, cfg) {
    this.song = song;
    this.sound = sound;
    this.cfg = cfg;                       // {ratio, transpose, countIn, metro, style, tracks:{id:{vol,mute,solo}}, loop}
    this.pos = 0;                         // 멈춰 있을 때의 위치(곡 처음부터의 박)
    this.playing = false;
    this.onEnd = () => {};
    this.load(song);
  }

  // 곡 데이터를 (다시) 싣는다. 편집 화면에서 음을 고칠 때마다 불린다. 재생 위치는 그대로 둔다.
  load(song) {
    const beat = this.playing ? this.now() : this.pos;
    this.song = song;
    const u = unfold(song);
    this.starts = u.starts;
    this.totalBeats = u.total;
    this.parts = song.parts.filter((p) => p.role === "vocal");
    this.merged = this.parts.map((p) => mergedNotes(song, p, this.starts));
    // 한 줄 안의 화음: 위·가운데·아래로 나눠 들을 수 있게 음마다 표시해 둔다. lines[i] = 그 줄에 있는 것 {top, mid, bottom}
    this.lines = this.merged.map((ns) => splitLines(ns));
    // 악보에 적힌 피아노 줄(오른손·왼손)은 "piano" 한 트랙으로 묶어 재생한다
    this.pianoNotes = song.parts.filter((p) => p.role === "piano").flatMap((p) => mergedNotes(song, p, this.starts));
    this.hasPiano = this.pianoNotes.length > 0;
    this.rebuild();
    if (this.playing) this.restartFrom(beat);
  }

  get trackIds() { return [...this.parts.map((p) => p.id), ...(this.hasPiano ? ["piano"] : []), "chord", "metro"]; }

  rebuild() {
    const ev = [];
    this.merged.forEach((ns, i) => {
      // 줄마다 "전체 / 위만 / 가운데만 / 아래만" (cfg.tracks[id].line). 혼자 울리는 음(같이 부르는 곳)은 어느 쪽을 골라도 낸다
      const want = (this.cfg.tracks[this.parts[i].id] || {}).line || "all";
      const pick = want !== "all" && this.lines[i][want] ? want : "all";
      for (const n of ns) {
        if (pick !== "all" && n.line !== "one" && n.line !== pick) continue;
        ev.push({ b: n.start, d: n.dur, midi: n.midi, tr: this.parts[i].id, v: 0.8, legato: n.slur === "start" || n.slur === "mid" });
      }
    });
    for (const n of this.pianoNotes) ev.push({ b: n.start, d: n.dur, midi: n.midi, tr: "piano", v: 0.62 });
    ev.push(...chordEvents(this.song, this.starts, this.cfg.style));
    ev.push(...clickEvents(this.song, this.starts));
    ev.sort((a, b) => a.b - b.b);
    this.events = ev;
    this.retime();
  }

  retime() { this.tl = buildTimeline(this.song, this.starts, this.cfg.ratio, this.parts); }

  // ---- 위치
  kAt(beat) {
    let lo = 0, hi = this.starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.starts[mid] <= beat + 1e-6) lo = mid; else hi = mid - 1; }
    return lo;
  }

  measureAt(beat) { return this.song.measures[this.song.order[this.kAt(beat)]]; }

  now() {
    if (!this.playing) return this.pos;
    const t = this.sound.ctx.currentTime;
    let ep = this.epochs[0];
    for (const e of this.epochs) if (e.at <= t) ep = e;
    while (this.epochs.length > 1 && this.epochs[1].at <= t) this.epochs.shift();
    const sec = Math.max(this.fromSec, t - ep.start);
    return Math.min(this.totalBeats, this.tl.beatOf(sec));
  }

  loopRange() {
    const L = this.cfg.loop;
    if (!L) return null;
    const a = Math.min(L[0], L[1]), b = Math.max(L[0], L[1]);
    const m = this.song.measures[this.song.order[b]];
    return [this.starts[a], this.starts[b] + m.len];
  }

  // ---- 재생
  async play() {
    if (this.playing) return;
    const ctx = this.sound.ensure();
    this.applyMix();
    const loop = this.loopRange();
    if (this.pos >= this.totalBeats - 1e-6) this.pos = loop ? loop[0] : 0;
    if (loop && (this.pos < loop[0] - 1e-6 || this.pos >= loop[1] - 1e-6)) this.pos = loop[0];
    let t0 = ctx.currentTime + 0.12;
    if (this.cfg.countIn) {
      const m = this.measureAt(this.pos);
      const spb = 60 / (m.bpm * this.cfg.ratio) * (4 / m.meter[1]);
      const n = m.meter[0] > 4 && m.meter[1] === 8 ? m.meter[0] / 3 : m.meter[0];
      const step = m.meter[0] > 4 && m.meter[1] === 8 ? spb * 3 : spb;
      for (let i = 0; i < n; i++) this.sound.click(t0 + i * step, i === 0, "count");
      this.sound.track("count").gain.value = 0.8;
      t0 += n * step;
    }
    this.fromSec = this.tl.secOf(this.pos);
    this.start = t0 - this.fromSec;
    this.epochs = [{ at: 0, start: this.start }];
    this.cursor = this.fromSec;
    this.idx = this.lower(this.pos);
    this.endAt = null;
    this.playing = true;
    this.timer = setInterval(() => this.tick(), TICK);
    this.tick();
  }

  lower(beat) {
    let lo = 0, hi = this.events.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.events[mid].b < beat - 1e-6) lo = mid + 1; else hi = mid; }
    return lo;
  }

  tick() {
    if (!this.playing) return;
    const ctx = this.sound.ctx, tl = this.tl;
    const horizon = ctx.currentTime + AHEAD;
    if (this.endAt !== null) {
      if (ctx.currentTime >= this.endAt) { this.stopAt(this.cfg.loop ? this.loopRange()[0] : 0); this.onEnd(); }
      return;
    }
    for (let guard = 0; guard < 8; guard++) {
      const loop = this.loopRange();
      const limit = loop ? tl.secOf(loop[1]) : tl.total;
      const upto = Math.min(limit, horizon - this.start);
      while (this.idx < this.events.length) {
        const e = this.events[this.idx];
        const s = tl.secOf(e.b);
        if (s >= upto - 1e-6) break;
        this.idx++;
        if (s < this.cursor - 1e-6) continue;
        const when = this.start + s;
        if (e.click) this.sound.click(when, e.accent);
        else this.sound.note(e.tr, e.midi + this.cfg.transpose, when, tl.secOf(e.b + e.d) - s, e.v, e.legato);
      }
      this.cursor = upto;
      if (upto < limit - 1e-6) return;
      if (!loop) { this.endAt = this.start + tl.total + 0.3; return; }
      const a = tl.secOf(loop[0]);
      const wrapAt = this.start + limit;
      this.start += limit - a;
      this.epochs.push({ at: wrapAt, start: this.start });
      this.fromSec = Math.min(this.fromSec, a);
      this.idx = this.lower(loop[0]);
      this.cursor = a;
    }
  }

  pause() {
    if (!this.playing) return;
    this.stopAt(this.now());
  }

  stopAt(beat) {
    clearInterval(this.timer);
    this.playing = false;
    this.pos = Math.max(0, Math.min(this.totalBeats, beat));
    this.sound.silence();
  }

  // 재생 중이면 그 자리에서 다시 예약한다 (빠르기·키·반주 방식이 바뀌었을 때)
  restartFrom(beat) {
    const was = this.playing;
    if (was) { clearInterval(this.timer); this.playing = false; this.sound.silence(); }
    this.pos = Math.max(0, Math.min(this.totalBeats, beat));
    if (was) { const ci = this.cfg.countIn; this.cfg.countIn = false; this.play(); this.cfg.countIn = ci; }
  }

  seekMeasure(k) { this.restartFrom(this.starts[Math.max(0, Math.min(this.starts.length - 1, k))]); }

  // ---- 설정
  bpmHere() { return this.measureAt(this.now()).bpm * this.cfg.ratio; }

  setBpm(v) {                              // 지금 위치의 ♩= 값을 v로. 곡 안의 빠르기 변화 비율은 유지된다
    const beat = this.now();
    const base = this.measureAt(beat).bpm;
    this.cfg.ratio = Math.max(20, Math.min(300, v)) / base;
    this.retime();
    this.restartFrom(beat);
  }

  setTranspose(v) { const beat = this.now(); this.cfg.transpose = Math.max(-12, Math.min(12, v)); this.restartFrom(beat); }

  setStyle(s) { const beat = this.now(); this.cfg.style = s; this.rebuild(); this.restartFrom(beat); }

  // 한 줄 안의 화음에서 어느 쪽을 들을지: "all" | "top" | "mid" | "bottom"
  setLine(id, line) {
    const beat = this.now();
    (this.cfg.tracks[id] = this.cfg.tracks[id] || { vol: 0.85, mute: false, solo: false }).line = line;
    this.rebuild();
    this.restartFrom(beat);
  }

  setLoop(loop) {
    const beat = this.now();
    this.cfg.loop = loop;
    if (this.playing) this.restartFrom(loop ? this.starts[Math.min(loop[0], loop[1])] : beat);
  }

  applyMix() {
    if (!this.sound.ctx) return;
    const tr = this.cfg.tracks;
    const anySolo = this.trackIds.some((id) => id !== "metro" && tr[id] && tr[id].solo);
    for (const id of this.trackIds) {
      const t = tr[id] || { vol: 0.8 };
      let g = t.mute ? 0 : t.vol;
      if (id === "metro") g = this.cfg.metro ? t.vol : 0;
      else if (anySolo && !t.solo) g = 0;
      this.sound.setTrackGain(id, g);
    }
  }
}
