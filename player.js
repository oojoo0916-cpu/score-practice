// 재생기: 음표를 조금 앞서 예약해 두는 방식. 멈춤·이어서·구간 반복·빠르기 변경에도 위치(박)를 잃지 않는다.
import { unfold, mergedNotes, voiceLines, voiceKey, chordEvents, clickEvents, buildTimeline, beatPlan, meterKind } from "./music.js";

const AHEAD = 0.35;          // 몇 초 앞까지 미리 예약할지
const TICK = 30;             // 예약 점검 간격(ms)

export class Player {
  constructor(song, sound, cfg) {
    this.song = song;
    this.sound = sound;
    this.cfg = cfg;                       // {ratio, transpose, countIn, metro, style, tracks:{id:{vol,mute,solo}}, loop, sub, groups}
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
    // 노래 줄마다 성부(위·가운데·아래)로 나눠 둔다. vl[i] = { all: 전체로 들을 때의 음, lines: 성부별 음, has, guess, info } (music.js 의 voiceLines)
    this.vl = this.parts.map((p) => voiceLines(song, p, this.starts));
    this.merged = this.vl.map((x) => x.all);
    this.lines = this.vl.map((x) => x.has);         // lines[i] = 그 줄에 그 성부만의 음이 몇 개 있는지 {top, mid, bottom}
    // 악보에 적힌 피아노 줄(오른손·왼손)은 "piano" 한 트랙으로 묶어 재생한다
    this.pianoNotes = song.parts.filter((p) => p.role === "piano").flatMap((p) => mergedNotes(song, p, this.starts));
    this.hasPiano = this.pianoNotes.length > 0;
    this.rebuild();
    if (this.playing) this.restartFrom(beat);
  }

  get trackIds() { return [...this.parts.map((p) => p.id), ...(this.hasPiano ? ["piano"] : []), "chord", "metro"]; }

  rebuild() {
    const ev = [];
    this.vl.forEach((vl, i) => {
      // 줄마다 "전체 / 위만 / 가운데만 / 아래만" (cfg.tracks[id].line). 한 성부를 고르면 그 성부의 음과 같이 부르는 음만 낸다.
      // 고른 성부가 이 줄에 없어도 전체로 돌아가지 않는다(다른 성부의 음이 섞이지 않게): 같이 부르는 음만 내고, 없다는 것은 missing(id)로 알린다
      const want = (this.cfg.tracks[this.parts[i].id] || {}).line || "all";
      for (const n of want === "all" ? vl.all : vl.lines[want] || []) {
        ev.push({ b: n.start, d: n.dur, midi: n.midi, tr: this.parts[i].id, v: 0.8, legato: n.slur === "start" || n.slur === "mid" });
      }
    });
    for (const n of this.pianoNotes) ev.push({ b: n.start, d: n.dur, midi: n.midi, tr: "piano", v: 0.62 });
    ev.push(...chordEvents(this.song, this.starts, this.cfg.style, this.beatOpt()));
    ev.push(...clickEvents(this.song, this.starts, this.beatOpt()));
    ev.sort((a, b) => a.b - b.b);
    this.events = ev;
    this.retime();
  }

  // 빠르기 지도. 페르마타는 노래 줄뿐 아니라 피아노 줄에 적힌 것도 반영한다 (노래가 쉬는 동안 피아노가 늘이는 곳)
  retime() { this.tl = buildTimeline(this.song, this.starts, this.cfg.ratio, this.song.parts.filter((p) => p.role === "vocal" || p.role === "piano")); }

  // 박을 어떻게 칠지: 세분박 듣기(cfg.sub: true | false | 정하지 않음 = 겹박자면 켬·홑박자면 끔), 5/8·7/8 의 묶음(cfg.groups)
  beatOpt() { return { sub: this.cfg.sub, groups: this.cfg.groups }; }
  setSub(v) { const beat = this.now(); this.cfg.sub = v; this.rebuild(); this.restartFrom(beat); }
  setGroup(key, g) { const beat = this.now(); this.cfg.groups = { ...(this.cfg.groups || {}), [key]: g }; this.rebuild(); this.restartFrom(beat); }

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
      // 시작하는 마디의 박자·묶음·빠르기로 한 마디를 센다 (메트로놈과 같은 박 계산. 못갖춘마디에서 시작해도 박자표대로 한 마디)
      const m = this.measureAt(this.pos);
      const q = 60 / (m.bpm * this.cfg.ratio);                        // 4분음표 하나의 길이(초)
      const full = meterKind(m.meter) === "unknown" ? m.len : m.meter[0] * 4 / m.meter[1];
      for (const x of beatPlan({ meter: m.meter, len: full }, this.beatOpt())) this.sound.click(t0 + x.b * q, x.level, "count");
      this.sound.track("count").gain.value = 0.8;
      t0 += full * q;
    }
    this.fromSec = this.tl.secOf(this.pos);
    this.start = t0 - this.fromSec;
    this.epochs = [{ at: 0, start: this.start }];
    this.cursor = this.fromSec;
    this.idx = this.lower(this.pos);
    this.endAt = null;
    this.carry(this.pos, t0);
    this.playing = true;
    this.timer = setInterval(() => this.tick(), TICK);
    this.tick();
  }

  // 시작하는 자리보다 먼저 시작해서 아직 울리고 있어야 하는 음(긴 음의 중간, 앞 마디에서 붙임줄로 넘어온 음)을 남은 길이만큼 낸다.
  // 긴 음의 중간에서 이어 재생하거나, 마디를 옮기거나, 재생 중에 빠르기를 바꿨을 때 그 음이 사라지지 않게 한다
  carry(beat, when) {
    const tl = this.tl, from = tl.secOf(beat);
    for (let i = 0; i < this.idx; i++) {
      const e = this.events[i];
      if (e.click || e.b + e.d <= beat + 0.05) continue;
      const loop = this.loopRange();
      this.sound.note(e.tr, e.midi + this.cfg.transpose, when, Math.min(tl.secOf(e.b + e.d), loop ? tl.secOf(loop[1]) : Infinity) - from, e.v, e.legato);
    }
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
        if (e.click) this.sound.click(when, e.level);
        else this.sound.note(e.tr, e.midi + this.cfg.transpose, when, Math.min(tl.secOf(e.b + e.d), loop ? limit : Infinity) - s, e.v, e.legato);      // 구간 반복: 구간 끝을 넘는 음은 끝에서 자른다
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
      this.carry(loop[0], wrapAt);                          // 구간 처음에 걸쳐 있는 음: 바퀴마다 처음 시작할 때와 같게
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

  // 그 줄에서 고른 성부가 이 줄에 없는가 (전체를 골랐으면 언제나 false)
  missing(id) {
    const i = this.parts.findIndex((p) => p.id === id), want = (this.cfg.tracks[id] || {}).line || "all";
    return i >= 0 && want !== "all" && !this.vl[i].has[want];
  }

  // 그 줄에서 성부를 어림했거나 가리지 못한 마디들 (song.measures 의 순서 번호)
  guessMeasures(id) {
    const i = this.parts.findIndex((p) => p.id === id);
    return i >= 0 ? this.vl[i].guess : [];
  }

  // 한 음이 어느 성부로 갔는지 { line: "one"(같이) | "top" | "mid" | "bottom", by: 어떻게 정했는지 }. 모르면 null
  voiceOf(id, m, beat, midi) {
    const i = this.parts.findIndex((p) => p.id === id);
    return (i >= 0 && this.vl[i].info.get(voiceKey(m, beat, midi))) || null;
  }

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
