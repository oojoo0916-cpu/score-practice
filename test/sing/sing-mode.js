// 노래 채점: 부르기 모드(반주와 부르기)의 흐름. 화면(panel.js)이 부른다.
// 카운트인 → 반주(고른 노래 줄만 끈다, "멜로디 작게"를 고르면 작게 같이)를 틀면서 녹음 → 구간이 끝나면 멈춘다.
// 반주가 없는 악보는 메트로놈만. 처음 카운트인 첫 박에 첫 음을 짧게 들려준다.
import { playRange, MIX, tone } from "./take.js";

// ctl: { player, sound, eng, S, me, range, first, job, status, withAcc, hasAcc, melody }
export async function sing(ctl) {
  const { range, S, eng, sound, job, status } = ctl;
  eng.startRecord();
  let T = null;
  const r = await playRange(ctl, job, {
    from: range.from, to: range.to, tail: S.singTailSec,
    mix: MIX.accomp(ctl.player, ctl.me, { withAcc: ctl.withAcc, hasAcc: ctl.hasAcc, melodyVol: ctl.melody ? S.singMelodyVol : 0 }),
    onStart: (t) => { T = t; tone(sound, ctl.first, S.singPrimeSec); },
    onTick: (t, TT) => status(t < TT(range.from) ? "준비… 박자를 세요" : "● 부르는 중", t < TT(range.from) ? "count" : "sing"),
  });
  const rec = eng.stopRecord();
  if (r.cancelled) return null;
  return { T: T || r.T, rec };
}
