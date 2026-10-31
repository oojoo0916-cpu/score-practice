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
  minClarity: 0.65,        // 또렷함(0~1)이 이보다 낮으면 "음 없음" — 숨소리·잡음·자음 (0.75 였다가 숨 섞인 소리를 놓쳐서 낮춤, 2026-10-27)
  minDb: -52,              // 소리 크기(dBFS)가 이보다 작으면 "음 없음" — 무음
  medianFrames: 5,         // 튀는 값(옥타브 점프 등)을 다듬는 중앙값 필터의 길이(구한 값 개수)
  gapResetMs: 80,          // "음 없음"이 이만큼 이어지면 다듬기를 처음부터 다시 한다 (앞 음이 다음 음에 섞이지 않게)
  micIdleOffSec: 60,       // 부르기 칸을 열어 둔 채 이만큼 안 부르면 마이크를 끈다 (다시 부를 때 저절로 켠다)
  maxRecordSec: 600,       // 소리 녹음을 최대 몇 초까지 보관할지 (줄인 소리로 담는다 — 10분에 약 38MB)

  // ---- 채점 (scoring.js)
  levels: {                // 판정 난이도: 부른 중심 음이 목표 음에서 ±몇 센트 안이면 "정확"
    easy: { name: "쉬움", cents: 50, timingMs: 200 },      // timingMs: 음 시작이 악보보다 ±몇 ms 안이면 박자 맞음 (6단계)
    normal: { name: "보통", cents: 30, timingMs: 120 },
    strict: { name: "엄격", cents: 15, timingMs: 70 },
  },
  level: "easy",           // 처음 난이도. 보통(±30)으로 시작했다가 "너무 엄격하다"는 사용자 의견으로 쉬움(±50 = 옆 반음보다 목표 음에 가까우면 정확)으로 바꿈 (2026-10-27)
  octaveFree: true,        // 옥타브 무시: 한 옥타브(또는 몇 옥타브) 다르게 불러도 같은 음이면 "정확" (남자가 여자 줄을 부를 때 등)
  attackIgnoreMs: 80,      // 음 시작 직후 이만큼은 판정에서 뺀다 (아래에서 긁어 올리는 소리)
  attackMaxShare: 0.3,     // 짧은 음에서는 뺄 구간을 음 길이의 이 비율까지만 (짧은 음이 통째로 빠지지 않게)
  releaseIgnoreMs: 30,     // 음 끝 직전 이만큼도 뺀다 (다음 음으로 넘어가는 소리)
  minVoicedShare: 0.4,     // 판정 구간 중 음이 잡힌 시간이 이 비율보다 적으면 "인식 안 됨" (자음·숨 쉬는 틈이 있어 너무 높으면 억울하다)
  autoLag: true,           // 부른 소리가 늦게(일찍) 들어온 만큼을 한 번 부를 때마다 저절로 찾아서 맞춘 뒤 음정을 판정한다
  lagMinMs: -150,          // 찾는 범위: 이만큼 일찍 ~
  lagMaxMs: 450,           //            이만큼 늦게 (블루투스 이어폰은 0.2~0.3초)
  lagStepMs: 10,
  lagMinFrames: 10,        // 맞는 순간이 이보다 적으면 늦음을 찾지 않는다(0으로 둔다)
  traceMarginMs: 150,      // 음표 앞뒤로 이만큼 더 기록해 둔다 (5단계 그래프의 여유)
  sameStartMs: 30,         // 시작이 이만큼 안에서 같은 음들은 한 화음 = 그중 하나를 부르면 된다 (갈라 부르는 곳을 '전체'로 고른 경우)

  // ---- 박자 판정 (scoring.js 의 findOnset·timing) · 박자 보정 (calibrate.js)
  latencyMs: null,         // 기기 지연(소리가 나가서 내 소리가 마이크로 들어올 때까지). 박자 보정으로 기기마다 재서 기억한다. 없으면 아래 어림값
  defaultLatencyMs: 150,   // 보정하지 않았을 때 어림하는 지연 (이때 박자 판정은 "어림"이라고 알린다)
  btWarnMs: 250,           // 보정한 지연이 이보다 크면 "블루투스 이어폰이면 늦게 들려요" 안내
  onsetSearchMs: 450,      // 악보의 음 시작에서 앞뒤로 이만큼 안에서 내 음 시작을 찾는다 (앞뒤 음과의 가운데를 넘지는 않는다. 0.3 이었다가 느린 곡에서 반 박 늦은 것을 못 찾아 늘림)
  onsetRiseDb: 6,          // 소리가 바로 앞 0.1초의 가장 작은 크기보다 이만큼(dB) 커지면 "음 시작" (자음으로 시작해도 여기서 잡힌다)
  onsetNearSemis: 0.6,     // 음높이로 찾을 때: 목표 음에서 이만큼(반음) 안으로 들어온 첫 순간
  timingSkipFermata: true, // 페르마타 음은 박자 판정을 하지 않는다
  shortShare: 0.6,         // 부른 길이가 악보 길이의 이 비율보다 짧으면 "짧게 끊음" (기록만, 색 판정에는 안 씀)
  calibClicks: 8,          // 박자 보정: 이만큼의 박자 소리에 맞춰 "따"
  calibLeadClicks: 2,      //            앞에 듣기만 하는 박자 소리
  calibIntervalSec: 0.75,  //            박자 소리 간격 (♩=80)
  calibMinDb: -48,         //            "따"로 칠 가장 작은 소리 크기(dBFS)
  calibRiseDb: 10,         //            바로 앞보다 이만큼(dB) 갑자기 커지면 "따"의 시작 (음높이는 보지 않는다 — 짧게 끊는 소리라서)
  calibMinMatches: 5,      //            이만큼은 맞춰야 보정값을 저장한다
  calibMaxSpreadMs: 100,   //            맞춘 시각들이 이보다 들쭉날쭉하면 다시 하자고 한다

  // ---- 음표 그래프 팝업 (note-popup.js, scoring.describeNote)
  driftCents: 20,          // 음 끝 1/3 의 평균이 앞부분보다 이만큼 낮으면 "끝에서 떨어짐", 높으면 "끝에서 올라감"
  driftMinMs: 300,         // 이보다 짧은 음은 끝 처짐을 보지 않는다
  scoopCents: 50,          // 음 시작이 이만큼 아래에서 올라오면 "아래에서 긁어 올림"
  scoopWindowMs: 150,      // 음 시작 직후 몇 ms 를 볼지
  graphCentsMin: 150,      // 그래프 위아래 범위(센트): 적어도 ±이만큼
  graphCentsMax: 600,      //                         많아도 ±이만큼 (그 밖은 가장자리에 붙여 그린다)

  // ---- 악보 위 표시 (overlay.js). 색은 "빨강, 초록, 파랑" 숫자 (반투명은 화면 쪽에서 정한다)
  colors: {
    normal: { ok: "30, 150, 90", wrong: "215, 40, 30", missed: "110, 110, 110", timing: "230, 170, 0" },       // 초록 정확 · 빨강 틀림 · 회색 인식 안 됨 · 노랑 박자만 틀림(6단계)
    colorblind: { ok: "31, 111, 209", wrong: "214, 51, 138", missed: "110, 110, 110", timing: "20, 160, 140" }, // 색맹 모드: 파랑 · 분홍 · 회색 · 청록 (+ ○ × △ 기호)
  },
  colorblind: false,       // 색맹 모드 (처음 값, 화면에서 바꾸면 기억)
  hideMarks: false,        // 채점 표시 끄기 (처음 값)
  ghostOffsetSpaces: 1.8,  // 틀린 음의 "부른 높이" 머리를 원래 머리에서 오른쪽으로 오선 몇 칸 옆에 그릴지
  ghostMaxSteps: 8,        // 부른 높이가 이보다 많이(오선 자리 기준) 벗어나면 덧그리지 않고 ↑/↓ 와 음이름만
  timingShiftSpaces: 1.0,  // 박자만 틀린 음(6단계): 빠르면 왼쪽, 늦으면 오른쪽으로 오선 몇 칸 옮겨 그릴지

  // ---- 구간 나누기 (ranges.js)
  phraseGapBeats: 1,       // 프레이즈: 4분음표 한 박 이상 쉬면 끊는다
  phraseMaxMeasures: 4,    // 한 프레이즈가 이보다 길면 그 안에서 가장 길게 쉬는 곳에서 한 번 더 끊는다

  // ---- 메아리 모드 (echo-mode.js): 듣기 → 첫 음 → 카운트인 → 반주 없이 따라 부르기
  echoUnits: ["phrase", 1, 2, 4],   // 고를 수 있는 구간 단위 (프레이즈 · 1마디 · 2마디 · 4마디)
  echoUnit: "phrase",      // 처음 단위
  echoListenAcc: false,    // 듣기 때 반주도 같이 (처음 값)
  echoGapSec: 0.5,         // 듣기가 끝나고 첫 음을 들려주기까지 쉬는 시간
  echoPrimeSec: 0.6,       // 카운트인 전에 첫 음을 들려주는 길이
  echoTailSec: 0.5,        // 구간이 끝난 뒤 조금 더 녹음
  echoAutoNext: false,     // 정확도가 아래 값 이상이면 저절로 다음 구간 (처음 값)
  echoAutoNextPct: 80,
  echoAutoNextDelaySec: 1.5,
  // 카운트인은 1마디다 (앱 재생기의 카운트인을 그대로 쓴다)

  // ---- 스피커로 반주를 틀 때 (8단계, scoring.speakerFilter · pitch-engine 의 후보)
  output: "earphones",     // 처음 값: "earphones" 이어폰 | "speaker" 스피커 (스피커면 아래 거르기를 쓴다)
  candThreshold: 0.4,      // 음 찾기에서 이 문턱 아래인 골은 모두 후보로 남긴다
  maxCands: 4,             // YIN 후보를 몇 개까지
  hsHarmonics: 5,          // 배음 합: 몇 번째 배음까지 더할지
  hsDecay: 0.84,           //         위 배음일수록 이만큼씩 덜 쳐 준다
  hsStepCents: 10,         //         음높이를 몇 센트 간격으로 훑을지
  hsMinRel: 0.35,          //         가장 큰 봉우리의 이 배 넘는 봉우리만 후보로
  hsTopN: 4,               //         후보를 몇 개까지
  candMinClarity: 0.55,    // 후보의 또렷함이 이보다 낮으면 버린다
  accMatchCents: 40,       // 후보가 지금 울리는 반주 음(또는 그 2·3·4배, 반 옥타브 아래)에서 이 센트 안이면 반주 소리로 보고 뺀다
  accRingSec: 0.4,         // 반주 음이 끝난 뒤에도 이만큼은 울린다고 본다 (피아노 울림)
  searchSemis: 7,          // 목소리는 목표 음에서 ±이 반음 안에서 찾는다
  sustainMinMs: 150,       // 이보다 짧으면서
  decayDb: 5,              //   이만큼(dB) 줄어드는 소리는 "치고 사그라드는 소리"(피아노)로 보고 뺀다 — 목소리는 유지된다
  ambShare: 0.5,           // 목표 음과 같은 음을 반주가 음 길이의 이 비율 넘게 치면 "애매" (점수에 넣지 않는다)
  speakerVolHint: 0.6,     // 스피커인데 반주 크기가 이보다 크면 "반주를 조금 줄이면 더 정확해요"
  speakerTestSec: 8,       // "반주만 틀고 시험" 길이
  speakerTestOkPct: 10,    // 그 시험에서 거른 뒤에도 이 % 넘게 목소리로 잡히면 "반주를 줄이거나 이어폰을" 안내

  // ---- 반주와 부르기: 반주 크기, 노래방식 화면 (karaoke.js)
  accVol: 0.7,             // 반주 크기 처음 값 (0~1, 설정 창에서 바꾸면 기억)
  karaPastSec: 2,          // 노래방 화면: 지금 위치 왼쪽에 보여 줄 지난 시간
  karaAheadSec: 4,         //              오른쪽에 보여 줄 앞으로의 시간
  karaPlayheadAt: 0.3,     //              지금 위치 세로줄을 화면 너비의 몇 번째에
  karaMinSemis: 10,        //              위아래로 적어도 반음 몇 개만큼 보여 줄지
  karaFilterFrames: 400,   //              스피커일 때 걸러서 그릴 최근 기록 수 (약 6초)

  // ---- 반주와 부르기: 부르는 동안 지나간 음표 색칠 (panel.js)
  liveEverySec: 1.0,       // 몇 초마다 색칠할지
  liveWaitSec: 0.35,       // 음이 끝나고 이만큼 지나야 그 음을 색칠한다 (늦게 들어오는 소리까지 기다린다)
  liveContextSec: 3,       // 색칠할 때 그 음 앞 몇 초의 기록까지 보고 늦음을 맞출지

  // ---- 부르기 화면 (sing-mode.js)
  singTailSec: 0.5,        // 구간이 끝난 뒤 조금 더 녹음 (늦게 끝나는 음)
  singPrimeSec: 0.6,       // 카운트인 첫 박에 첫 음을 들려주는 길이
  singMelodyVol: 0.3,      // "멜로디 작게"를 켰을 때 멜로디 소리 크기 (보통 0.85)

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
