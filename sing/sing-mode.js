// 노래 채점: 반주와 부르기의 흐름. 화면(panel.js)이 부른다.
// 고른 곳(처음 또는 지금 마디)부터 곡 끝까지: 반주(고른 노래 줄만 끈다, "멜로디 작게"를 고르면 작게 같이)를 틀면서 녹음한다.
// 전주가 있으면 전주가 박자를 알려 주니 카운트인 없이 바로 시작하고, 첫 음이 시작 마디 안에 있을 때만 한 마디 세고 첫 음을 짧게 들려준다.
// 반주가 없는 악보는 메트로놈만. 부르는 동안 ctl.live(t, T) 로 화면이 지나간 음을 바로바로 색칠한다.
import { playRange, MIX, tone } from "./take.js";

// ctl: { player, sound, eng, S, me, range, first, job, status, withAcc, hasAcc, melody, countIn, live? }
// → { T, rec, cancelled, stopAt } — 중간에 그만둬도 그때까지의 기록을 돌려준다 (그때까지 부른 음을 채점한다)
export async function sing(ctl) {
  const { range, S, eng, sound, job, status } = ctl;
  eng.startRecord();
  let T = null;
  const r = await playRange(ctl, job, {
    from: range.from, to: range.to, tail: S.singTailSec,
    mix: MIX.accomp(ctl.player, ctl.me, { withAcc: ctl.withAcc, hasAcc: ctl.hasAcc, melodyVol: ctl.melody ? S.singMelodyVol : 0, countIn: ctl.countIn, accVol: ctl.accVol }),
    onStart: (t) => { T = t; if (ctl.countIn) tone(sound, ctl.first, S.singPrimeSec); },
    onTick: (t, TT) => {
      const before = t < TT(range.from);
      status(before ? "준비… 박자를 세요" : "● 부르는 중", before ? "count" : "sing");
      if (ctl.live) ctl.live(t, TT);                               // 카운트인 동안에도 불러서 노래방 화면이 미리 막대를 보여 주게
    },
  });
  const stopAt = sound.ctx.currentTime;
  const rec = eng.stopRecord();
  if (!T) return null;
  return { T, rec, cancelled: r.cancelled, stopAt };
}
