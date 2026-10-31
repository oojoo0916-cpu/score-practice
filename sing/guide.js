// 노래 채점 9단계: 처음 쓰는 사람을 위한 3장짜리 안내 (부르기 칸을 처음 열 때 한 번, ⚙ 설정의 "처음 안내 다시 보기"로 다시).
//   1) 마이크 허용  2) 이어폰 권장 / 스피커도 가능 (여기서 고른다)  3) 박자 보정 한 번 (지금 하기 / 나중에)
// → Promise { output: "earphones" | "speaker" | null(고르지 않음), calibrate: 참이면 바로 박자 보정 }
const h = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };

const CARDS = [
  { icon: "🎤", title: "마이크를 허용해 주세요",
    text: "처음 부를 때 '마이크 사용'을 묻는 창이 떠요. '허용'을 눌러 주세요. 내 목소리는 이 기기 안에서만 듣고, 어디로도 보내지 않아요." },
  { icon: "🎧", title: "이어폰을 끼면 가장 정확해요",
    text: "스피커로 반주를 틀어도 돼요 — 반주 소리를 걸러서 들어요. 어느 쪽으로 할까요? (나중에 ⚙ 에서 바꿀 수 있어요)", choose: true },
  { icon: "⏱", title: "박자 보정을 한 번 해 주세요",
    text: "폰과 이어폰마다 소리가 늦게 들리는 정도가 달라요. 박자 소리에 맞춰 \"따!\"만 하면 돼요 (30초). 안 해도 부를 수 있지만 박자는 어림으로 봐요.", last: true },
];

export function openGuide(current = "earphones") {
  return new Promise((done) => {
    const back = h("div", "sg-back");
    const card = h("section", "sg-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "노래 연습 처음 안내");
    document.body.append(back, card);
    let i = 0, output = null;
    const finish = (calibrate) => { back.remove(); card.remove(); done({ output, calibrate }); };
    const show = () => {
      const c = CARDS[i];
      card.textContent = "";
      const skip = h("button", "sg-skip", "건너뛰기");
      skip.onclick = () => finish(false);
      const dots = h("div", "sg-dots");
      CARDS.forEach((_, k) => dots.append(h("span", k === i ? "on" : "")));
      card.append(skip, h("div", "sg-icon", c.icon), h("h2", "sg-title", c.title), h("p", "sg-text", c.text), dots);
      const row = h("div", "sg-btns");
      const btn = (t, cls, fn) => { const b = h("button", cls, t); b.onclick = fn; row.append(b); return b; };
      if (c.choose) {
        for (const [v, t] of [["earphones", "🎧 이어폰"], ["speaker", "🔊 스피커"]]) {
          const b = btn(t, "sg-btn" + ((output || current) === v ? " primary" : ""), () => { output = v; i++; show(); });
          b.setAttribute("aria-pressed", String((output || current) === v));
        }
      } else if (c.last) {
        btn("나중에", "sg-btn", () => finish(false));
        btn("지금 하기", "sg-btn primary", () => finish(true));
      } else btn("다음", "sg-btn primary", () => { i++; show(); });
      card.append(row);
    };
    back.onclick = () => finish(false);
    show();
  });
}
