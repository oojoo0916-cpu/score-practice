// MusicXML로 불러온 곡은 원본 악보 그림(PDF)이 없다. 그래서 악보를 직접 그린다.
// 그리기는 OpenSheetMusicDisplay(BSD-3-Clause)가 하고, 여기서는 그려진 마디·음표의 자리를 곡 자료에 적어 넣는다.
// 그 뒤로는 PDF 악보와 똑같이 동작한다 (마디 누르기, 세로줄, 고치기).
import { LAYOUT_W } from "./musicxml.js";

const OSMD = "https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@1.9.9/build/opensheetmusicdisplay.min.js";
export const DRAWV = "osmd-1.9.9/1";      // 그리는 도구나 자리 계산이 바뀌면 올린다 → 저장해 둔 그림을 버리고 다시 그린다
const U = 10;                             // OSMD의 길이 단위 1 = 화면 10점 (확대 1배일 때)
let libP = null;

function lib() {
  libP = libP || new Promise((ok, no) => {
    if (window.opensheetmusicdisplay) return ok(window.opensheetmusicdisplay);
    const s = document.createElement("script");
    s.src = OSMD;
    s.onload = () => ok(window.opensheetmusicdisplay);
    s.onerror = () => { libP = null; no(new Error("악보를 그리는 도구를 받지 못했어요")); };
    document.head.append(s);
  });
  return libP;
}

// 저장해 둔 그림(글자) → svg
export function fromHtml(html) {
  const t = document.createElement("div");
  t.innerHTML = html;
  const svg = t.firstElementChild;
  return svg && svg.nodeName.toLowerCase() === "svg" ? svg : null;
}

// 그리는 도구가 멈추는 악보 고치기: 같은 성부·같은 박에 쉼표와 음표가 겹쳐 있으면(인식 결과에 흔하다) 쉼표를 "건너뛰기"로 바꾼다.
// 소리와 박은 그대로다 (쉼표는 소리가 없고, 건너뛰기가 같은 길이만큼 자리를 지킨다).
export function sanitize(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const kid = (el, name) => { for (const c of el.children) if (c.nodeName === name) return c; return null; };
  const num = (el, name) => { const c = kid(el, name); const v = c ? parseFloat(c.textContent) : 0; return Number.isFinite(v) ? v : 0; };
  let fixed = 0;
  for (const m of doc.getElementsByTagName("measure")) {
    let t = 0, last = 0;
    const at = new Map();                 // "성부|박" → { rests: [], pitched: 있음 }
    for (const el of [...m.children]) {
      if (el.nodeName === "backup") t = Math.max(0, t - num(el, "duration"));
      else if (el.nodeName === "forward") t += num(el, "duration");
      else if (el.nodeName === "note" && !kid(el, "grace")) {
        const chord = !!kid(el, "chord"), start = chord ? last : t;
        if (!chord) { last = t; t += num(el, "duration"); }
        const v = kid(el, "voice"), key = (v ? v.textContent.trim() : "1") + "|" + start;
        if (!at.has(key)) at.set(key, { rests: [], pitched: false });
        if (kid(el, "rest")) at.get(key).rests.push(el); else at.get(key).pitched = true;
      }
    }
    for (const g of at.values()) {
      if (!g.pitched && g.rests.length < 2) continue;
      for (const r of (g.pitched ? g.rests : g.rests.slice(1))) {
        if (kid(r, "chord")) { r.remove(); fixed++; continue; }
        const f = doc.createElement("forward"), d = doc.createElement("duration");
        d.textContent = String(num(r, "duration"));
        f.append(d);
        r.replaceWith(f);
        fixed++;
      }
    }
  }
  return fixed ? new XMLSerializer().serializeToString(doc) : xml;
}

// xml 을 그려서 svg 를 돌려주고, song 의 쪽 크기·마디 상자·음표 자리를 채운다.
export async function render(song, xml) {
  const L = await lib();
  const host = document.createElement("div");
  host.style.cssText = `position:absolute;left:-99999px;top:0;width:${LAYOUT_W}px;background:#fff`;
  document.body.append(host);
  try {
    const osmd = new L.OpenSheetMusicDisplay(host, { autoResize: false, backend: "svg", drawTitle: false, drawSubtitle: false, drawComposer: false, drawLyricist: false,
      drawPartNames: false, drawMeasureNumbers: true, pageFormat: "Endless", autoGenerateMultipleRestMeasuresFromRestMeasures: false });
    const asDoc = (text) => new DOMParser().parseFromString(text, "application/xml");
    try {
      await osmd.load(asDoc(xml));
      osmd.render();
    } catch (err) {                                          // 그리다 멈추면 겹친 쉼표를 정리해서 한 번 더
      const clean = sanitize(xml);
      if (clean === xml) throw err;
      host.textContent = "";
      await osmd.load(asDoc(clean));
      osmd.render();
    }
    const svg = host.querySelector("svg");
    if (!svg) throw new Error("악보를 그리지 못했어요");
    const w = parseFloat(svg.getAttribute("width")) || LAYOUT_W, h = parseFloat(svg.getAttribute("height")) || LAYOUT_W;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.removeAttribute("width"); svg.removeAttribute("height");
    svg.style.cssText = "display:block;width:100%;height:auto";
    fill(song, osmd.GraphicSheet, w, h);
    svg.remove();
    return svg;
  } finally { host.remove(); }
}

function fill(song, gs, w, h) {
  song.pages = [{ n: 1, w, h }];
  const rows = gs.MeasureList;
  const pos = new Map();                  // "마디|오선|박|음높이" → [x, y]
  const colX = song.measures.map(() => new Map());      // 마디별: 박 → 가장 왼쪽 가로 자리 (파트에 그 음이 없을 때 쓴다)
  let prev = [w * 0.05, 0, w * 0.95, 80], sysNo = 0, lastSys = null;
  song.measures.forEach((m, mi) => {
    const gms = (rows[mi] || []).filter(Boolean);
    if (!gms.length) { m.box = prev.slice(); m.page = 1; m.system = Math.max(1, sysNo); return; }
    const xs = gms.map((g) => g.PositionAndShape.AbsolutePosition.x), ys = gms.map((g) => g.PositionAndShape.AbsolutePosition.y);
    const x0 = Math.min(...xs) * U, x1 = Math.max(...gms.map((g) => g.PositionAndShape.AbsolutePosition.x + g.PositionAndShape.Size.width)) * U;
    const y0 = Math.min(...ys) * U, y1 = (Math.max(...ys) + 4) * U;             // 오선 높이 = 4칸
    const sys = gms[0].ParentMusicSystem || gms[0].parentMusicSystem || y0;
    if (sys !== lastSys) { lastSys = sys; sysNo++; }
    m.box = prev = [x0, y0, x1, y1].map((v) => Math.round(v * 10) / 10);
    m.page = 1; m.system = sysNo;
    (rows[mi] || []).forEach((g, si) => {
      if (!g) return;
      for (const se of g.staffEntries || []) {
        const beat = se.relInMeasureTimestamp.RealValue * 4, bk = beat.toFixed(3);
        for (const ve of se.graphicalVoiceEntries || []) for (const gn of ve.notes || []) {
          const src = gn.sourceNote;
          if (!src || (src.isRest && src.isRest())) continue;
          const p = gn.PositionAndShape.AbsolutePosition, x = p.x * U, y = p.y * U;              // 음표 머리 가운데
          pos.set(`${mi}|${si}|${bk}|${src.halfTone + 12}`, [x, y]);
          if (!colX[mi].has(bk) || x < colX[mi].get(bk)) colX[mi].set(bk, x);
        }
      }
    });
  });
  let total = 0, matched = 0;
  for (const part of song.parts) for (const n of part.notes) {
    const m = song.measures[n.m], bk = n.beat.toFixed(3);
    const hit = pos.get(`${n.m}|${part.staff}|${bk}|${n.midi}`);
    n.page = 1;
    total++;
    if (hit) { matched++; n.x = Math.round(hit[0] * 10) / 10; n.y = Math.round(hit[1] * 10) / 10; continue; }
    // 그림에서 짝을 찾지 못한 음(조옮김 악기 등): 같은 박의 가로 자리, 없으면 마디 안에서 박에 비례한 자리
    n.x = Math.round((colX[n.m].get(bk) ?? m.box[0] + (m.box[2] - m.box[0]) * (0.1 + 0.85 * n.beat / m.len)) * 10) / 10;
    n.y = Math.round((m.box[1] + m.box[3]) / 2 * 10) / 10;
  }
  song.drawCheck = { notes: total, matched };            // 읽은 음 가운데 그림에서 같은 자리·같은 음으로 찾은 수
}
