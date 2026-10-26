// 노래 채점: 판정 기준값과 음 찾기 설정을 모두 여기에 모은다 (다른 파일에는 숫자를 박아 넣지 않는다).
// 사용자가 화면에서 바꾸는 값만 기기에 기억한다(localStorage, 언제나 try/catch — Safari "모든 쿠키 차단"에서는 기억하지 못해도 그대로 쓴다).

export const SING = {
  // ---- 마이크 (getUserMedia). 브라우저가 소리를 다듬으면 음높이가 망가지므로 기본은 모두 끈다 (8단계에서 화면으로 켜고 끈다)
  mic: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },

  // ---- 음높이 찾기 (pitch-engine.js)
  a4: 440,                 // 기준 음 A4 (Hz)
  minHz: 70,               // 찾을 범위: 사람 목소리 (낮은 남자 목소리 ~ 높은 소프라노)
  maxHz: 1100,
  analysisRate: 16000,     // 분석할 때 소리를 이만큼(초당 점 수)으로 줄여서 계산한다 (폰에서 가볍게). 실제로는 원래 소리의 1/정수로 맞춘다
  windowMs: 46,            // 한 번에 들여다보는 소리 길이. 가장 낮은 음(minHz) 한 주기의 두 배보다 길어야 한다
  hopMs: 16,               // 몇 ms마다 음높이를 한 번 구할지
  yinThreshold: 0.15,      // 음 찾기(YIN) 문턱: 낮을수록 엄격하다
  minClarity: 0.75,        // 또렷함(0~1)이 이보다 낮으면 "음 없음" — 숨소리·잡음·자음
  minDb: -52,              // 소리 크기(dBFS)가 이보다 작으면 "음 없음" — 무음
  medianFrames: 5,         // 튀는 값(옥타브 점프 등)을 다듬는 중앙값 필터의 길이(구한 값 개수)
  gapResetMs: 80,          // "음 없음"이 이만큼 이어지면 다듬기를 처음부터 다시 한다 (앞 음이 다음 음에 섞이지 않게)
  maxRecordSec: 600,       // 원본 소리 녹음을 최대 몇 초까지 보관할지 (폰 메모리 보호)

  // ---- 채점 (scoring.js)
  levels: {                // 판정 난이도: 부른 중심 음이 목표 음에서 ±몇 센트 안이면 "정확"
    easy: { name: "쉬움", cents: 50 },
    normal: { name: "보통", cents: 30 },
    strict: { name: "엄격", cents: 15 },
  },
  level: "normal",
  octaveFree: true,        // 옥타브 무시: 한 옥타브(또는 몇 옥타브) 다르게 불러도 같은 음이면 "정확" (남자가 여자 줄을 부를 때 등)
  attackIgnoreMs: 80,      // 음 시작 직후 이만큼은 판정에서 뺀다 (아래에서 긁어 올리는 소리)
  attackMaxShare: 0.3,     // 짧은 음에서는 뺄 구간을 음 길이의 이 비율까지만 (짧은 음이 통째로 빠지지 않게)
  releaseIgnoreMs: 30,     // 음 끝 직전 이만큼도 뺀다 (다음 음으로 넘어가는 소리)
  minVoicedShare: 0.5,     // 판정 구간 중 음이 잡힌 시간이 이 비율보다 적으면 "인식 안 됨"
  traceMarginMs: 150,      // 음표 앞뒤로 이만큼 더 기록해 둔다 (5단계 그래프의 여유)
  sameStartMs: 30,         // 시작이 이만큼 안에서 같은 음들은 한 화음 = 그중 하나를 부르면 된다 (갈라 부르는 곳을 '전체'로 고른 경우)

  // ---- 채점 시험 화면 (debug.js)
  debugMeasures: 4,        // 악보 처음 몇 마디로 시험할지
  debugTailSec: 0.5,       // 구간이 끝난 뒤 조금 더 녹음 (늦게 끝나는 음)
  debugPrimeSec: 0.7,      // 카운트인 전에 첫 음을 들려주는 길이

  // ---- 튜너 화면 (tuner.js)
  tunerGoodCents: 10,      // ±이 안이면 초록
  tunerWarnCents: 25,      // ±이 안이면 주황, 밖이면 빨강
  tunerGraphSec: 5,        // 흐르는 선 그래프에 보여 줄 시간
  tunerGraphSemis: 7,      // 그래프의 위아래 범위(가운데 음에서 반음 몇 개)
};

const KEY = "sing.user";          // 사용자가 바꾼 값 (지금은 비어 있다)

export function loadUser() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch (err) { return {}; }
}

export function saveUser(v) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); return true; } catch (err) { return false; }
}

// 기본값 위에 사용자가 바꾼 값을 덮은 설정
export function current() {
  return { ...SING, ...loadUser() };
}
