// 고친 내용 다루기. 엔진이 읽은 결과(song)는 그대로 두고, 고친 것을 그 위에 덧씌우는 층으로 따로 보관한다.
//
// edits = {
//   ov: { "<파트 id>|<마디 번호>": { part, n, orig: [음표...], now: [음표...], engine, date, stale? } },
//   checked: { "<마디 번호>": 날짜 }          // 사용자가 "확인 완료"로 표시한 마디
// }
// orig = 고치던 때 엔진이 읽어 둔 그 마디의 음표들, now = 고친 뒤의 음표들.
// 마디 단위로 통째로 바꿔 끼우기 때문에, 엔진이 다시 읽어도 같은 (파트, 마디)에 그대로 덧씌울 수 있다.
// 화면·소리와 무관한 순수 계산만 둔다 (web/edits.test.js 가 시험한다).

const r4 = (x) => Math.round(x * 10000) / 10000;
const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
export const noteName = (midi) => NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
export const keyOf = (part, n) => `${part}|${n}`;
export const emptyEdits = () => ({ ov: {}, checked: {} });

// 비교용 모양: [시작 박, 길이, 음높이, 가사, 붙임줄]
export function canon(notes) {
  return notes.map((x) => [r4(x.beat), r4(x.dur), x.midi, x.lyric || "", !!x.tie])
    .sort((a, b) => a[0] - b[0] || a[2] - b[2]);
}
export const sameNotes = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

const indexOfMeasure = (song, n) => song.measures.findIndex((m) => m.n === n);

export function measureNotes(song, partId, mi) {
  const p = song.parts.find((q) => q.id === partId);
  return p ? p.notes.filter((x) => x.m === mi).sort((a, b) => a.beat - b.beat || a.midi - b.midi) : [];
}

// 엔진 결과에 고친 내용을 덧씌운 곡을 돌려준다. 원래 song은 바꾸지 않는다.
export function applyEdits(song, edits) {
  edits = edits || emptyEdits();
  const measures = song.measures.map((m) => ({ ...m }));
  const parts = song.parts.map((p) => ({ ...p, notes: p.notes }));
  for (const ov of Object.values(edits.ov)) {
    const mi = indexOfMeasure(song, ov.n);
    const p = parts.find((q) => q.id === ov.part);
    if (mi < 0 || !p) continue;                        // 그 마디·파트가 이제 없다 → 덧씌우지 못함 (기록은 남는다)
    const mine = ov.now.map((x) => ({ slur: "", fermata: false, tied: false, page: measures[mi].page, ...x,
      m: mi, name: noteName(x.midi), lyric: x.lyric || "", tie: !!x.tie, edited: true }));
    p.notes = p.notes.filter((x) => x.m !== mi).concat(mine).sort((a, b) => a.m - b.m || a.beat - b.beat || a.midi - b.midi);
    measures[mi].edited = true;
    if (ov.stale) measures[mi].stale = true;
  }
  for (const n of Object.keys(edits.checked)) {
    const mi = indexOfMeasure(song, +n);
    if (mi >= 0) { measures[mi].ok = true; measures[mi].checked = true; }
  }
  return { ...song, measures, parts };
}

// 한 마디의 고친 결과를 기록한다. 원래대로 돌아왔으면 기록을 지운다.
export function setMeasure(edits, engineSong, partId, mi, nowNotes, engineVer, today) {
  const n = engineSong.measures[mi].n, k = keyOf(partId, n);
  const orig = edits.ov[k] ? edits.ov[k].orig : measureNotes(engineSong, partId, mi).map(strip);
  if (sameNotes(orig, nowNotes)) { delete edits.ov[k]; return null; }
  edits.ov[k] = { part: partId, n, orig, now: nowNotes.map(strip), engine: edits.ov[k] ? edits.ov[k].engine : engineVer,
    date: today || new Date().toISOString().slice(0, 10) };
  return edits.ov[k];
}

function strip(x) {
  const o = { beat: r4(x.beat), dur: r4(x.dur), midi: x.midi, lyric: x.lyric || "", tie: !!x.tie };
  for (const f of ["x", "y", "page", "slur", "fermata", "added", "voice"]) if (x[f] !== undefined && x[f] !== "" && x[f] !== false) o[f] = x[f];
  return o;
}

// 엔진이 곡을 다시 읽은 뒤: 고친 내용을 새 결과에 맞춰 정리한다.
//  - 새 결과가 고치던 때와 같다            → 그대로 덧씌운다
//  - 새 결과가 고친 것과 같아졌다(엔진 개선) → 고친 기록이 필요 없어져서 지운다 (caughtUp)
//  - 새 결과가 둘 다와 다르다              → 고친 것을 유지하되 "다시 확인"(stale) 표시를 붙인다
export function reconcile(newSong, edits) {
  const out = { kept: 0, caughtUp: [], stale: [], lost: [] };
  for (const [k, ov] of Object.entries(edits.ov)) {
    const mi = indexOfMeasure(newSong, ov.n);
    if (mi < 0 || !newSong.parts.some((p) => p.id === ov.part)) { ov.stale = true; out.lost.push(k); continue; }
    const fresh = measureNotes(newSong, ov.part, mi);
    if (sameNotes(fresh, ov.now)) { delete edits.ov[k]; out.caughtUp.push(k); continue; }
    if (sameNotes(fresh, ov.orig)) { delete ov.stale; out.kept++; continue; }
    ov.stale = true;
    out.stale.push(k);
  }
  return out;
}

// 엔진 개선에 쓸 기록: 어떤 악보, 어느 마디, 원래 읽은 것 → 고친 것
export function exportLog(recs) {
  const items = [];
  for (const rec of recs) {
    const e = rec.edits || emptyEdits();
    for (const ov of Object.values(e.ov)) {
      items.push({ title: rec.title, pdf_sha256: rec.sha256 || null, method: rec.method || null, engine: ov.engine,
        part: ov.part, measure: ov.n, date: ov.date, stale: !!ov.stale, original: canon(ov.orig), corrected: canon(ov.now) });
    }
    for (const [n, date] of Object.entries(e.checked)) {
      items.push({ title: rec.title, pdf_sha256: rec.sha256 || null, method: rec.method || null, measure: +n, date, confirmed_ok: true });
    }
  }
  return { what: "악보 연습실에서 사용자가 고친 기록", fields: "original/corrected = [시작 박, 길이(4분=1), 음높이(MIDI), 가사, 붙임줄]", exported: new Date().toISOString(), items };
}

// ------------------------------------------------------------------ 한 마디 안에서 고치기 (notes = 그 파트·마디의 음표 배열)
const BASES = [4, 2, 1, 0.5, 0.25];

export function durParts(dur) {
  for (const base of BASES) for (const dot of [false, true]) for (const trip of [false, true]) {
    if (Math.abs(base * (dot ? 1.5 : 1) * (trip ? 2 / 3 : 1) - dur) < 0.002) return { base, dot, trip };
  }
  return { base: null, dot: false, trip: false };
}
export const durFrom = (base, dot, trip) => r4(base * (dot ? 1.5 : 1) * (trip ? 2 / 3 : 1));

const sorted = (notes) => notes.slice().sort((a, b) => a.beat - b.beat || a.midi - b.midi);
const sameBeat = (a, b) => Math.abs(a.beat - b.beat) < 0.002;

export function changePitch(notes, i, delta) {
  const out = notes.map((x) => ({ ...x }));
  out[i].midi = Math.max(21, Math.min(108, out[i].midi + delta));
  return sorted(out);
}

// 길이 바꾸기. shift가 켜져 있으면 그 음이 끝난 뒤에 시작하는 음들을 같은 만큼 당기거나 민다.
// 같은 박에 같은 길이로 쌓인 음(화음)은 함께 바뀐다.
export function changeDur(notes, i, newDur, shift) {
  const out = notes.map((x) => ({ ...x }));
  const t = out[i], oldEnd = t.beat + t.dur, delta = newDur - t.dur;
  for (const x of out) {
    if (x !== t && sameBeat(x, t) && Math.abs(x.dur - t.dur) < 0.002) x.dur = r4(newDur);
    else if (shift && x.beat >= oldEnd - 0.002) x.beat = r4(Math.max(0, x.beat + delta));
  }
  t.dur = r4(newDur);
  return sorted(out);
}

export function shiftOnset(notes, i, delta) {
  const out = notes.map((x) => ({ ...x }));
  out[i].beat = r4(Math.max(0, out[i].beat + delta));
  return sorted(out);
}

export function setField(notes, i, field, value) {
  const out = notes.map((x) => ({ ...x }));
  out[i][field] = value;
  return out;
}

export function deleteNote(notes, i, shift) {
  const t = notes[i], end = t.beat + t.dur;
  const alone = !notes.some((x, j) => j !== i && sameBeat(x, t));     // 화음의 한 음을 지울 때는 뒤를 당기지 않는다
  const out = notes.filter((_, j) => j !== i).map((x) => ({ ...x }));
  if (shift && alone) for (const x of out) if (x.beat >= end - 0.002) x.beat = r4(Math.max(0, x.beat - t.dur));
  return sorted(out);
}

// where: "before" | "after" | "chord"(같은 박에 한 음 더) | "empty"(빈 마디의 첫 음)
export function insertNote(notes, i, where, shift, fallbackMidi = 60) {
  const out = notes.map((x) => ({ ...x }));
  const t = i >= 0 ? out[i] : null;
  const nn = { beat: 0, dur: t ? t.dur : 1, midi: t ? t.midi : fallbackMidi, lyric: "", tie: false, added: true, _new: true };
  if (t && where === "after") nn.beat = r4(t.beat + t.dur);
  if (t && (where === "before" || where === "chord")) nn.beat = t.beat;
  if (t && where === "chord") nn.midi = Math.min(108, t.midi + 3);
  if (shift && t && where !== "chord") {
    for (const x of out) if (x.beat >= nn.beat - 0.002 && !(where === "after" && x === t)) x.beat = r4(x.beat + nn.dur);
  }
  out.push(nn);
  return sorted(out);
}

export const totalEnd = (notes) => notes.reduce((mx, x) => Math.max(mx, x.beat + x.dur), 0);
