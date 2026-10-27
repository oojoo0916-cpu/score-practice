// 노래 채점: 메아리·부르기 모드가 같이 쓰는 재생 도우미. 앱의 재생기(player)를 빌려 쓰고 끝나면 설정을 되돌린다.
// 재생기를 그대로 쓰므로 빠르기(♩=)·키·세로줄·자동 넘김·카운트인이 평소 재생과 같다.

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// 재생기 설정(트랙 소리·카운트인·구간 반복·메트로놈·성부)을 잠시 바꾼다 → 되돌리는 함수를 돌려준다
export function borrow(player, apply) {
  const cfg = player.cfg;
  const keep = { tracks: JSON.parse(JSON.stringify(cfg.tracks)), countIn: cfg.countIn, loop: cfg.loop, metro: cfg.metro };
  const lines = () => JSON.stringify(player.parts.map((p) => (cfg.tracks[p.id] || {}).line || "all"));
  const before = lines();
  for (const t of Object.values(cfg.tracks)) if (t) t.solo = false;
  cfg.loop = null;
  apply(cfg);
  const relined = lines() !== before;
  if (relined) player.rebuild();
  let done = false;
  return () => {                                                   // 여러 번 불러도 한 번만 되돌린다
    if (done) return;
    done = true;
    cfg.tracks = keep.tracks; cfg.countIn = keep.countIn; cfg.loop = keep.loop; cfg.metro = keep.metro;
    if (relined) player.rebuild();
    player.applyMix();
  };
}

const track = (cfg, id) => (cfg.tracks[id] = cfg.tracks[id] || { vol: 0.85, mute: false, solo: false });

// 소리 섞기 (cfg 를 바꾼다). me: 부를 노래 줄 id, line: 성부
export const MIX = {
  // 듣기: 부를 줄(그 성부)만. withAcc 면 반주도
  listen: (player, me, line, withAcc) => (cfg) => {
    for (const p of player.parts) { const t = track(cfg, p.id); t.mute = p.id !== me; if (p.id === me) { t.vol = Math.max(t.vol, 0.85); t.line = line; } }
    if (cfg.tracks.piano) cfg.tracks.piano.mute = !withAcc || cfg.tracks.piano.mute;
    if (cfg.tracks.chord) cfg.tracks.chord.mute = !withAcc || cfg.tracks.chord.mute;
    cfg.metro = false;
    cfg.countIn = false;
  },
  // 메아리로 부르기: 앱 소리를 모두 끈다 (카운트인 박자 소리만 난다). 세로줄은 평소처럼 움직인다
  silent: () => (cfg) => {
    for (const t of Object.values(cfg.tracks)) if (t && "mute" in t) t.mute = true;
    cfg.metro = false;
    cfg.countIn = true;
  },
  // 반주와 부르기: 부를 줄만 끈다(melodyVol 이 있으면 작게). withAcc 가 아니면 반주도 끄고 메트로놈
  accomp: (player, me, { withAcc, hasAcc, melodyVol, countIn = true, accVol = null }) => (cfg) => {
    if (hasAcc && withAcc && accVol !== null) {                   // 반주 크기 (설정 창에서 고른 값)
      if (cfg.tracks.piano) cfg.tracks.piano.vol = accVol;
      if (cfg.tracks.chord) cfg.tracks.chord.vol = accVol * 0.8;
    }
    for (const p of player.parts) if (p.id === me) { const t = track(cfg, p.id); t.mute = !melodyVol; if (melodyVol) t.vol = melodyVol; }
    if (!hasAcc) cfg.metro = withAcc;
    else if (!withAcc) {
      if (cfg.tracks.piano) cfg.tracks.piano.mute = true;
      if (cfg.tracks.chord) cfg.tracks.chord.mute = true;
      cfg.metro = true;
    }
    cfg.countIn = countIn;                                         // 전주가 있으면 카운트인 없이 (전주가 박자를 알려 준다)
  },
};

// [from, to) 를 재생하고, to 를 지나 tail 초가 더 지나면(또는 job.cancelled 면) 멈춘다.
// onStart(T): 재생이 시작된 직후 (T(박) = 그 박이 울리는 소리 시계). onTick(t, T): 0.05초마다.
// → { T, cancelled }  (T 는 멈춘 뒤에도 쓸 수 있다)
// job.restore: 화면을 닫거나 앱을 내릴 때 기다리지 않고 바로 설정을 되돌리는 데 쓴다 (앱이 곧바로 저장하므로)
export async function playRange({ player, sound }, job, { from, to, tail = 0, mix, onStart, onTick }) {
  const restore = job.restore = borrow(player, mix);
  try {
    player.pos = from;
    await player.play();
    if (!player.playing) throw new Error("재생을 시작하지 못했어요");
    const tl = player.tl, start = player.start;
    const T = (b) => start + tl.secOf(b);
    if (onStart) onStart(T);
    const end = T(to) + tail;
    while (!job.cancelled && sound.ctx.currentTime < end) {
      if (onTick) onTick(sound.ctx.currentTime, T);
      await sleep(50);
    }
    return { T, cancelled: !!job.cancelled };
  } finally {
    player.pause();
    restore();
  }
}

// 짧게 한 음 (첫 음 들려주기, "원래 음 듣기")
export function tone(sound, midi, sec, vel = 0.75) {
  const ctx = sound.ensure();
  sound.track("singref").gain.value = 0.85;
  sound.note("singref", midi, ctx.currentTime + 0.05, sec, vel);
}

export { sleep };

// 녹음해 둔 원본 소리 재생 (내 녹음 듣기). from·to: 소리 시계(초), 없으면 처음부터 끝까지 → 멈추는 함수
export function playRecording(sound, rec, from = null, to = null) {
  const ctx = sound.ensure();
  if (!rec || !rec.audio || !rec.audio.length) return () => {};
  const buf = ctx.createBuffer(1, rec.audio.length, rec.sampleRate);
  buf.getChannelData(0).set(rec.audio);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = 1;
  src.connect(g).connect(ctx.destination);
  const a = from === null ? 0 : Math.max(0, from - rec.audioT0), b = to === null ? buf.duration : Math.min(buf.duration, to - rec.audioT0);
  if (b <= a) return () => {};
  src.start(ctx.currentTime + 0.03, a, b - a);
  return () => { try { src.stop(); } catch (e) { /* 이미 끝남 */ } };
}
