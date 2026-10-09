// MusicXML 파일(.musicxml · .xml · .mxl)을 앱의 곡 모양(song)으로 바꾼다.
// 사보 프로그램(Finale, Sibelius, MuseScore, Dorico 등)이 "MusicXML로 내보내기"로 만든 파일에는
// 음높이·길이·가사·코드가 글자로 적혀 있어서, 인식 없이 그대로 옮기면 된다. 화면·소리와 무관한 순수 계산만 둔다.

const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const kid = (el, name) => { for (const c of el.children) if (c.nodeName === name) return c; return null; };
const kids = (el, name) => [...el.children].filter((c) => c.nodeName === name);
const txt = (el, name) => { const c = el && kid(el, name); return c ? c.textContent.trim() : ""; };
const num = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : 0; };
const accText = (alter) => (alter > 0 ? "#".repeat(alter) : alter < 0 ? "b".repeat(-alter) : "");

// ---------------------------------------------------------------- 압축된 파일(.mxl) 풀기
// .mxl 은 zip 파일이다. 브라우저에 들어 있는 압축 풀기 기능만 쓴다 (따로 받는 것 없음).
export async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("압축 파일(.mxl)을 열 수 없어요");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map();
  for (let i = 0; i < count && dv.getUint32(p, true) === 0x02014b50; i++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = u8.subarray(start, start + csize);
    if (method === 0) files.set(name, raw);
    else if (method === 8) {
      if (typeof DecompressionStream === "undefined") throw new Error("이 기기의 브라우저가 오래되어 압축된 .mxl 파일을 풀 수 없어요. 압축하지 않은 .musicxml 파일로 내보내 주세요.");
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      files.set(name, new Uint8Array(await new Response(stream).arrayBuffer()));
    }
    p += 46 + nlen + elen + clen;
  }
  return files;
}

function decode(u8) {
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder("utf-16le").decode(u8);
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder("utf-16be").decode(u8);
  return new TextDecoder("utf-8").decode(u8);
}

// 파일 내용 → MusicXML 글자. 압축 파일이면 풀어서 안에 든 악보를 꺼낸다.
export async function xmlText(buf) {
  const u8 = new Uint8Array(buf);
  if (!(u8[0] === 0x50 && u8[1] === 0x4b)) return decode(u8);
  const files = await unzip(u8);
  let name = null;
  const box = files.get("META-INF/container.xml");
  if (box) {
    const d = new DOMParser().parseFromString(decode(box), "application/xml");
    const rf = d.getElementsByTagName("rootfile")[0];
    if (rf && files.has(rf.getAttribute("full-path"))) name = rf.getAttribute("full-path");
  }
  name = name || [...files.keys()].find((n) => !n.startsWith("META-INF/") && /\.(musicxml|xml)$/i.test(n));
  if (!name) throw new Error("압축 파일 안에서 악보를 찾지 못했어요");
  return decode(files.get(name));
}

// ---------------------------------------------------------------- 코드 기호
const KIND = {
  "major": "", "minor": "m", "augmented": "aug", "diminished": "dim", "dominant": "7", "major-seventh": "maj7", "minor-seventh": "m7",
  "diminished-seventh": "dim7", "augmented-seventh": "aug7", "half-diminished": "m7b5", "major-minor": "mM7", "major-sixth": "6", "minor-sixth": "m6",
  "dominant-ninth": "9", "major-ninth": "maj9", "minor-ninth": "m9", "dominant-11th": "11", "major-11th": "maj11", "minor-11th": "m11",
  "dominant-13th": "13", "major-13th": "maj13", "minor-13th": "m13", "suspended-second": "sus2", "suspended-fourth": "sus4", "power": "5",
};

function chordName(h) {
  const root = kid(h, "root");
  const kind = kid(h, "kind");
  if (!root || !kind || !(kind.textContent.trim() in KIND)) return null;      // N.C., 로마 숫자 등은 반주를 만들지 않는다
  let name = txt(root, "root-step") + accText(Math.round(num(txt(root, "root-alter")))) + KIND[kind.textContent.trim()];
  for (const d of kids(h, "degree")) {
    const v = txt(d, "degree-value"), a = accText(Math.round(num(txt(d, "degree-alter")))), t = txt(d, "degree-type");
    if (t === "subtract") name += `(omit${v})`;
    else if (t === "add") name += a ? `(${a}${v})` : `(add${v})`;
    else if (t === "alter") name += `(${a}${v})`;
  }
  const bass = kid(h, "bass");
  if (bass) name += "/" + txt(bass, "bass-step") + accText(Math.round(num(txt(bass, "bass-alter"))));
  return /^[A-G]/.test(name) ? name : null;
}

// ---------------------------------------------------------------- 연주 순서 (도돌이표, 1·2번 괄호) — 엔진의 play_order 와 같은 규칙
export function playOrder(measures) {
  const order = [], done = new Set();
  let i = 0, start = 0, pass = 1, guard = 0;
  while (i < measures.length && guard++ < measures.length * 4 + 8) {
    const m = measures[i];
    if (m.rep_start && !(order.length && order[order.length - 1] >= i)) { start = i; pass = 1; }
    if (m.ending && m.ending !== pass) { i++; continue; }
    order.push(i);
    if (m.rep_end && !done.has(i)) { done.add(i); pass = 2; i = start; continue; }
    if (m.rep_end || m.ending === 2) pass = 1;
    i++;
  }
  return order;
}

const UNIT = { whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25, "32nd": 0.125 };
const PIANO_NAME = /piano|pno|keyboard|klavier|organ|harp|피아노|건반|반주/i;
export const LAYOUT_W = 800;            // 화면에 그릴 때의 가상 너비. 고친 음표의 자리가 기기마다 달라지지 않게 고정한다

// MusicXML 글자 → { song, stats }. 악보 그림의 자리(쪽·마디 상자·음표 위치)는 화면에 그린 뒤에 채운다.
// opts.check: 인식 결과(스캔)처럼 틀릴 수 있는 파일 → 어느 파트든 박자 합이 박자표와 다른 마디를 '확인 필요'로 표시한다.
export function parse(xml, title, opts = {}) {
  const t0 = typeof performance !== "undefined" ? performance.now() : 0;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  if (doc.getElementsByTagName("parsererror").length || !root) throw new Error("MusicXML 파일이 깨져 있어서 열 수 없어요");
  if (root.nodeName === "score-timewise") throw new Error("이 MusicXML은 드문 형식(timewise)이라 아직 읽지 못해요. 사보 프로그램에서 다시 내보내 주세요.");
  if (root.nodeName !== "score-partwise") throw new Error("MusicXML 악보 파일이 아니에요");

  const names = new Map();
  for (const sp of doc.getElementsByTagName("score-part")) names.set(sp.getAttribute("id"), txt(sp, "part-name"));

  const meas = [];                       // 마디 정보 (모든 파트가 같이 쓴다)
  const tempos = [];                     // {mi, beat, bpm}
  const lines = [];                      // 파트의 오선 하나 = 줄 하나
  let si = 0;

  kids(root, "part").forEach((part) => {
    let div = 1, staves = 1, transpose = 0, openEnding = 0;
    const mine = new Map();              // 오선 번호 → 음표들
    let hasLyric = false;
    kids(part, "measure").forEach((mel, mi) => {
      const M = meas[mi] || (meas[mi] = { number: mel.getAttribute("number"), implicit: mel.getAttribute("implicit") === "yes", content: 0, contents: [],
        rep_start: false, rep_end: false, ending: 0, final: false, chords: [], marks: [], labels: [] });
      if (openEnding) M.ending = openEnding;
      let t = 0, lastStart = 0, maxT = 0, closeEnding = false;
      const mark = (type, text, beat) => { if (!M.marks.some((k) => k.type === type && Math.abs(k.beat - beat) < 1e-6)) M.marks.push({ type, text, beat }); };
      for (const el of mel.children) {
        switch (el.nodeName) {
          case "attributes": {
            if (kid(el, "divisions")) div = num(txt(el, "divisions")) || 1;
            if (kid(el, "staves")) staves = Math.max(1, Math.round(num(txt(el, "staves"))));
            const key = kid(el, "key");
            if (key && M.keySet === undefined && kid(key, "fifths")) M.keySet = Math.round(num(txt(key, "fifths")));
            const time = kid(el, "time");
            if (time && !M.meterSet && kid(time, "beats")) {
              const b = txt(time, "beats").split("+").reduce((a, x) => a + num(x), 0), bt = num(txt(time, "beat-type"));
              if (b > 0 && bt > 0) M.meterSet = [b, bt];
            }
            const tr = kid(el, "transpose");
            if (tr) transpose = Math.round(num(txt(tr, "chromatic"))) + 12 * Math.round(num(txt(tr, "octave-change")));
            break;
          }
          case "note": {
            if (kid(el, "grace")) break;                                   // 꾸밈음은 박을 차지하지 않는다
            const d = num(txt(el, "duration")), chord = !!kid(el, "chord");
            const start = chord ? lastStart : t;
            if (!chord) { lastStart = t; t += d; maxT = Math.max(maxT, t); }
            const p = kid(el, "pitch");
            if (!p || kid(el, "cue") || kid(el, "rest")) break;
            const step = txt(p, "step"), alter = Math.round(num(txt(p, "alter"))), oct = Math.round(num(txt(p, "octave")));
            if (!(step in STEP)) break;
            const nt = kid(el, "notations");
            const ties = kids(el, "tie").map((x) => x.getAttribute("type")).concat(nt ? kids(nt, "tied").map((x) => x.getAttribute("type")) : []);
            let lyric = "";
            for (const ly of kids(el, "lyric").sort((a, b) => num(a.getAttribute("number") || "1") - num(b.getAttribute("number") || "1"))) {
              const s = kids(ly, "text").map((x) => x.textContent).join("").trim();
              if (s) { lyric = s; break; }                                 // 1절만 (2절 이후는 3단계에서)
            }
            if (lyric) hasLyric = true;
            const slurs = nt ? kids(nt, "slur").map((x) => x.getAttribute("type")) : [];
            const st = Math.min(staves, Math.max(1, Math.round(num(txt(el, "staff")) || 1)));
            if (!mine.has(st)) mine.set(st, []);
            mine.get(st).push({ m: mi, beat: start / div, dur: d / div, midi: 12 * (oct + 1) + STEP[step] + alter + transpose,
              name: step + accText(alter) + oct, lyric, page: 1, x: 0, y: 0,
              tie: ties.includes("start"), tied: ties.includes("stop"),
              slur: slurs.includes("start") ? "start" : slurs.includes("stop") ? "end" : "", fermata: !!(nt && kid(nt, "fermata")) });
            break;
          }
          case "backup": t -= num(txt(el, "duration")); if (t < 0) t = 0; break;
          case "forward": t += num(txt(el, "duration")); maxT = Math.max(maxT, t); break;
          case "harmony": {
            const name = chordName(el);
            const beat = Math.max(0, (t + num(txt(el, "offset"))) / div);
            if (name && !M.chords.some((c) => Math.abs(c.beat - beat) < 1e-6)) M.chords.push({ name, beat });
            break;
          }
          case "sound": if (el.getAttribute("tempo")) tempos.push({ mi, beat: t / div, bpm: num(el.getAttribute("tempo")) }); break;
          case "direction": {
            const beat = Math.max(0, (t + num(txt(el, "offset"))) / div);
            let bpm = 0;
            const snd = kid(el, "sound");
            if (snd && snd.getAttribute("tempo")) bpm = num(snd.getAttribute("tempo"));
            for (const dt of kids(el, "direction-type")) {
              const met = kid(dt, "metronome");
              if (met && !bpm) {
                const per = num((txt(met, "per-minute").match(/[\d.]+/) || ["0"])[0]);
                const unit = (UNIT[txt(met, "beat-unit")] || 1) * (kid(met, "beat-unit-dot") ? 1.5 : 1);
                if (per > 0) bpm = per * unit;
              }
              for (const w of kids(dt, "words")) {
                const s = w.textContent.trim();
                if (/\b(rit|rall|riten)/i.test(s)) mark("rit", s, beat);
                else if (/a\s*tempo|tempo\s*(i|1|primo)\b/i.test(s)) mark("a_tempo", s, beat);
              }
              const reh = kid(dt, "rehearsal");
              if (reh && reh.textContent.trim() && !M.labels.includes(reh.textContent.trim())) M.labels.push(reh.textContent.trim());
            }
            if (bpm >= 20 && bpm <= 400) tempos.push({ mi, beat, bpm });
            break;
          }
          case "barline": {
            const rep = kid(el, "repeat"), end = kid(el, "ending");
            if (rep && rep.getAttribute("direction") === "forward") M.rep_start = true;
            if (rep && rep.getAttribute("direction") === "backward") M.rep_end = true;
            if (end) {
              const type = end.getAttribute("type"), n = Math.round(num((end.getAttribute("number") || "1").split(/[,\s]+/)[0])) || 1;
              if (type === "start") { openEnding = n; M.ending = n; }
              else closeEnding = true;
            }
            if (!rep && txt(el, "bar-style") === "light-heavy" && (el.getAttribute("location") || "right") === "right") M.final = true;
            break;
          }
        }
      }
      if (closeEnding) openEnding = 0;
      M.content = Math.max(M.content, maxT / div);
      M.contents.push(maxT / div);
    });
    const piano = !hasLyric && (staves >= 2 || PIANO_NAME.test(names.get(part.getAttribute("id")) || ""));
    for (let s = 1; s <= staves; s++) {
      lines.push({ si: si++, role: piano ? "piano" : "vocal", label: (names.get(part.getAttribute("id")) || "").replace(/\s+/g, " ").trim(), sub: staves > 1 ? s : 0, notes: mine.get(s) || [] });
    }
  });
  if (!meas.length) throw new Error("이 MusicXML 파일에는 마디가 없어요");

  // ---- 마디: 박자표·조표·빠르기를 앞에서부터 이어받고, 못갖춘마디의 길이를 정한다
  tempos.sort((a, b) => a.mi - b.mi || a.beat - b.beat);
  const first = tempos.length ? tempos[0].bpm : null;
  let meter = [4, 4], key = 0, bpm = first || 72;
  const measures = meas.map((M, i) => {
    if (M.meterSet) meter = M.meterSet;
    if (M.keySet !== undefined) key = M.keySet;
    const nominal = meter[0] * 4 / meter[1], c = M.content;
    const odd = M.implicit || c > nominal + 1e-6 || ((i === 0 || i === meas.length - 1) && c < nominal - 1e-6);
    const len = odd && c > 1e-6 ? c : nominal;
    for (const tp of tempos) if (tp.mi === i && tp.beat < len / 2 + 1e-6) bpm = tp.bpm;      // 마디 앞쪽의 빠르기말은 그 마디부터
    const off = M.contents.some((x) => x > 1e-6 && Math.abs(x - nominal) > 1e-6);
    const fine = !opts.check || !off || (i === 0 && M.contents.every((x) => x <= nominal + 1e-6) && new Set(M.contents.filter((x) => x > 1e-6).map((x) => x.toFixed(4))).size <= 1);
    const n = parseInt(M.number, 10);
    const out = { n: Number.isFinite(n) && String(n) === String(M.number).trim() ? n : i + 1, page: 1, system: 1, box: [0, 0, 1, 1], meter: meter.slice(), len, bpm: Math.round(bpm * 100) / 100, key,
      rep_start: M.rep_start, rep_end: M.rep_end, ending: M.ending, final: M.final, pickup: i === 0 && len < nominal - 1e-6,
      ok: fine, piano_ok: true, chords: M.chords.sort((a, b) => a.beat - b.beat), marks: M.marks, labels: M.labels };
    for (const tp of tempos) if (tp.mi === i && tp.beat >= len / 2 + 1e-6) bpm = tp.bpm;     // 뒤쪽의 빠르기말은 다음 마디부터
    return out;
  });

  // ---- 파트: 노래(가사가 있거나 한 줄짜리) 먼저, 피아노는 뒤에
  const count = { vocal: 0, piano: 0 };
  const parts = lines.filter((l) => l.notes.length).sort((a, b) => (a.role !== "vocal") - (b.role !== "vocal") || a.si - b.si).map((l) => {
    const k = ++count[l.role];
    const seen = new Map();              // 두 성부가 같은 박에 같은 음을 내면 한 번만
    for (const x of l.notes) {
      const id = `${x.m}|${x.beat.toFixed(6)}|${x.midi}`, o = seen.get(id);
      if (!o) seen.set(id, x);
      else { o.dur = Math.max(o.dur, x.dur); o.tie = o.tie || x.tie; o.tied = o.tied || x.tied; o.lyric = o.lyric || x.lyric; }
    }
    const notes = [...seen.values()].filter((x) => x.dur > 0 && x.beat < measures[x.m].len - 1e-6).sort((a, b) => a.m - b.m || a.beat - b.beat || a.midi - b.midi);
    const name = l.role === "piano" ? `피아노 ${k}` : (l.label && !/^(musicxml part|part\s*\d*|voice|staff)$/i.test(l.label) ? l.label + (l.sub ? ` ${l.sub}` : "") : `노래 ${k}`);
    return { id: l.role + k, role: l.role, name, verified: true, staff: l.si, notes };
  });
  if (!parts.length) throw new Error("이 MusicXML 파일에는 음표가 없어요");

  const song = { format: 2, title, engine: "musicxml", pages: [{ n: 1, w: LAYOUT_W, h: LAYOUT_W }], tempo: first || 72, tempo_found: first !== null,
    measures, order: playOrder(measures), parts };
  const vn = parts.filter((p) => p.role === "vocal").flatMap((p) => p.notes), pn = parts.filter((p) => p.role === "piano").flatMap((p) => p.notes);
  const stats = { seconds: typeof performance !== "undefined" ? Math.round(performance.now() - t0) / 1000 : 0, pages: 1, measures: measures.length,
    need_check: measures.filter((m) => !m.ok).map((m) => m.n), piano_need_check: 0, piano_check_list: [], vocal_notes: vn.length, ties: vn.filter((x) => x.tie).length,
    lyrics: vn.filter((x) => x.lyric).length, chords: measures.reduce((a, m) => a + m.chords.length, 0), piano_notes: pn.length };
  return { song, stats };
}
