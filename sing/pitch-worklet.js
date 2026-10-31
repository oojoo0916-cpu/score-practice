// 마이크 소리를 오디오 처리 줄(오디오 스레드)에서 받아 일정한 크기로 모아 화면 쪽(pitch-engine.js)으로 넘긴다.
// 여기서는 계산하지 않는다 — 반주 소리와 같은 줄에서 돌기 때문에 무거운 일을 하면 소리가 끊긴다.
// 넘기는 것: { frame: 첫 점의 번호(소리 시계, 초 = frame / sampleRate), data: Float32Array }
const SIZE = 1024;

class PitchTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(SIZE);
    this.n = 0;
    this.start = 0;
    this.on = true;
    this.port.onmessage = (e) => { if (e.data === "stop") this.on = false; };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        if (this.n === 0) this.start = currentFrame + i;
        const k = Math.min(ch.length - i, SIZE - this.n);
        this.buf.set(ch.subarray(i, i + k), this.n);
        this.n += k; i += k;
        if (this.n === SIZE) {
          this.port.postMessage({ frame: this.start, data: this.buf }, [this.buf.buffer]);
          this.buf = new Float32Array(SIZE);
          this.n = 0;
        }
      }
    }
    return this.on;
  }
}

registerProcessor("pitch-tap", PitchTap);
