// 노래 채점 3단계: 메아리 모드의 흐름. 화면(panel.js)이 부른다.
//   1. 듣기: 구간의 멜로디를 피아노로 (반주 같이 듣기는 고를 수 있다, 처음에는 끔)
//   2. 준비: 첫 음을 한 번 짧게 → 박자 소리로 한 마디 카운트인
//   3. 부르기: 앱 소리는 모두 끈다. 세로줄은 평소처럼 움직인다. 구간이 끝나고 조금 더(echoTailSec) 녹음한 뒤 저절로 멈춘다
// ♩= 빠르기·키는 재생기의 것을 그대로 쓰므로 듣기·카운트인·채점 시간이 모두 같은 빠르기다.
import { playRange, MIX, tone, sleep } from "./take.js";

// ctl: { player, sound, eng(음 찾기), S(설정), me(노래 줄 id), line(성부), range, first(첫 음 midi), job: { cancelled }, status(글) }
export async function listen(ctl, withAcc) {
  const { range, status } = ctl;
  status("🎧 멜로디를 들어 보세요", "listen");
  const r = await playRange(ctl, ctl.job, { from: range.from, to: range.to, tail: 0.15, mix: MIX.listen(ctl.player, ctl.me, ctl.line, withAcc) });
  return !r.cancelled;
}

// 첫 음 → 카운트인 → 반주 없이 부르기. → { T, rec } (T(박) = 그 박이 울린 소리 시계) 또는 취소되면 null
export async function sing(ctl) {
  const { range, S, eng, sound, job, status } = ctl;
  status("첫 음 ♪", "prime");
  tone(sound, ctl.first, S.echoPrimeSec);
  await sleep((S.echoPrimeSec + 0.3) * 1000);
  if (job.cancelled) return null;
  eng.startRecord();
  let T = null;
  const r = await playRange(ctl, job, {
    from: range.from, to: range.to, tail: S.echoTailSec, mix: MIX.silent(),
    onStart: (t) => { T = t; },
    onTick: (t, TT) => status(t < TT(range.from) ? "준비… 박자를 세요" : "● 따라 부르세요", t < TT(range.from) ? "count" : "sing"),
  });
  const rec = eng.stopRecord();
  if (r.cancelled) return null;
  return { T: T || r.T, rec };
}
