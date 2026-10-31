// 노래 채점: ⚙ 설정 창. 부르기 칸을 깔끔하게 두려고 자주 바꾸지 않는 것은 모두 여기 한 곳에 모은다(9단계 "노래 채점 설정 한 묶음").
// 바꾼 값은 기기에 기억한다(settings.js 의 saveUser). 창을 닫아도 그대로다.
import { loadUser, saveUser } from "./settings.js";

const h = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };

// 줄 하나: 왼쪽 글, 오른쪽 켜고 끄기
export function switchRow(parent, label, on, hint = "") {
  const row = h("label", "ss-row");
  const txt = h("span", "ss-label", label);
  if (hint) txt.append(h("small", null, hint));
  const i = h("input");
  i.type = "checkbox"; i.checked = !!on; i.className = "ss-switch";
  row.append(txt, i);
  parent.append(row);
  return i;
}

// 줄 하나: 왼쪽 글, 오른쪽 고르기
export function selectRow(parent, label, items, val) {
  const row = h("label", "ss-row");
  const s = h("select", "ss-select");
  for (const [v, t] of items) { const o = h("option", null, t); o.value = v; s.append(o); }
  s.value = val;
  row.append(h("span", "ss-label", label), s);
  parent.append(row);
  return s;
}

// 붙은 단추 묶음(하나만 고름): items [[값, 글]] → { el, value(), set(v), onchange }
export function segmented(parent, items, val, label) {
  const box = h("div", "ss-seg");
  box.setAttribute("role", "radiogroup");
  box.setAttribute("aria-label", label);
  const api = { el: box, v: val, onchange: () => {} };
  const btns = items.map(([v, t]) => {
    const b = h("button", "ss-seg-btn", t);
    b.type = "button";
    b.onclick = () => { api.set(v); api.onchange(v); };
    box.append(b);
    return [v, b];
  });
  api.value = () => api.v;
  api.set = (v) => { api.v = v; for (const [k, b] of btns) { b.classList.toggle("on", k === v); b.setAttribute("aria-checked", String(k === v)); } };
  api.set(val);
  parent.append(box);
  return api;
}

export function rangeRow(parent, label, val, min = 0, max = 100) {
  const row = h("label", "ss-row");
  const r = h("input");
  r.type = "range"; r.min = min; r.max = max; r.value = val; r.className = "ss-range";
  row.append(h("span", "ss-label", label), r);
  parent.append(row);
  return r;
}

// 창 열기: build(body) 가 안을 채운다. → 닫는 함수
export function openSheet(title, build) {
  const back = h("div", "ss-back");
  const sheet = h("section", "ss-sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", title);
  const head = h("header", "ss-head");
  const x = h("button", "icon sing-close", "✕");
  x.setAttribute("aria-label", "설정 닫기");
  head.append(h("b", null, title), x);
  const body = h("div", "ss-body");
  sheet.append(head, body);
  build(body);
  document.body.append(back, sheet);
  const close = () => { back.remove(); sheet.remove(); };
  back.onclick = close;
  x.onclick = close;
  return close;
}

export function section(body, title) {
  const s = h("div", "ss-sec");
  s.append(h("p", "ss-title", title));
  body.append(s);
  return s;
}

// 여러 값을 한꺼번에 기억
export const remember = (obj) => saveUser({ ...loadUser(), ...obj });
