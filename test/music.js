// 읽은 악보(song.json)를 재생할 수 있는 모양으로 바꾸는 계산들. 화면·소리와 무관한 순수 계산만 둔다.

// 연주 순서로 펼친 각 마디가 곡 처음부터 몇 번째 박에서 시작하는지
export function unfold(song) {
  const starts = [];
  let acc = 0;
  for (const oi of song.order) { starts.push(acc); acc += song.measures[oi].len; }
  return { starts, total: acc };
}

// 한 파트의 음표를 연주 순서로 펼친다 (붙임줄을 합치지 않은 그대로). 시작 박 순서, 같은 박이면 낮은 음부터.
function unfoldNotes(song, part, starts) {
  const byM = new Map();
  for (const n of part.notes) { if (!byM.has(n.m)) byM.set(n.m, []); byM.get(n.m).push(n); }
  const seq = [];
  song.order.forEach((oi, k) => {
    for (const n of byM.get(oi) || []) seq.push({ ...n, k, start: starts[k] + n.beat, heads: [{ page: n.page, x: n.x, y: n.y, at: starts[k] + n.beat }] });
  });
  return seq.sort((a, b) => a.start - b.start || a.midi - b.midi);
}

// 붙임줄로 이어진 음을 첫 음 하나로 합쳐 길게 만든다. seq: 시작 박 순서로 놓인 음들 (그 음들을 바꾼다).
// order: 연주 순서(song.order). 도돌이표로 되돌아가거나 건너뛴 자리에서는 악보에서 이어진 음이 아닐 수 있다:
// 그런 자리의 음은 "붙임줄을 받는 음"(tied)이라고 적혀 있을 때만 합친다 (2번 괄호로 가는 붙임줄이 되돌아간 자리의 첫 음을 삼키지 않게)
function mergeTies(seq, order) {
  const out = [], open = new Map();
  const follows = (a, b) => a === b || !order || order[b] === order[a] + 1;      // 연주 순서 a 다음에 b 가 악보에서도 바로 다음 마디인가
  for (const n of seq) {
    const prev = open.get(n.midi);
    if (prev && Math.abs(prev.start + prev.dur - n.start) < 1e-6 && (n.tied || follows(prev.kEnd === undefined ? prev.k : prev.kEnd, n.k))) {
      prev.dur += n.dur;
      prev.kEnd = n.k;
      prev.heads.push(n.heads[0]);
      if (!n.tie) open.delete(n.midi);
      continue;
    }
    open.delete(n.midi);
    out.push(n);
    if (n.tie) open.set(n.midi, n);
  }
  return out;
}

// 한 파트의 음표를 연주 순서로 펼치고, 붙임줄로 이어진 음은 첫 음 하나로 합쳐 길게 만든다.
export function mergedNotes(song, part, starts) {
  return mergeTies(unfoldNotes(song, part, starts), song.order);
}

// ---- 한 노래 줄을 성부(위·가운데·아래)로 나누기
// "그 순간의 가장 높은 음·낮은 음"이 아니라 악보의 같은 성부를 계속 따라간다. 음이 시작할 때 한 번 정하고, 그 음이 끝날 때까지 바꾸지 않는다
// (뒤에 들어오는 음 때문에 이미 정한 것이 바뀌지 않는다). 무엇으로 정하는가, 믿을 만한 것부터:
//   ① 적혀 있는 성부 (n.voice): 고치기에서 정해 준 것, MusicXML 의 성부 번호, 엔진이 기둥 방향으로 알아낸 것(두 성부로 적힌 마디에서만). "both" = 같이 부르는 음
//   ② 붙임줄로 이어 받은 음은 앞 음의 성부
//   ③ 같이 울리는 음들: 이미 음을 내고 있는 성부를 빼고, 남은 성부에 높은 음부터 (쉼표가 있으면 쉬는 성부도 뺀다)
//   ④ 혼자 나오는 음 + 쉼표 정보(part.rests): 다른 성부의 쉼표와 겹치면 쉬지 않는 성부만의 음, 겹치는 쉼표가 없으면 같이 부르는 음(한 성부로 적힌 곳)
//   ⑤ 어림 — 쉼표 정보가 없는 곡(예전에 읽은 곡, 스캔 곡, 손으로 넣은 음)이나 쉬는 성부를 모를 때: 갈라 부르는 대목 한가운데의 음을
//      바로 앞 음과 가장 가깝게 이어지는 성부에 붙인다. 어느 쪽인지 가릴 수 없으면 같이 부르는 음으로 두고 "모름"으로 표시한다
// 돌려주는 값:
//   all    전체로 들을 때의 음 (mergedNotes 와 같다)
//   lines  { top, mid, bottom }: 그 성부만 들을 때의 음 = 그 성부의 음 + 같이 부르는 음. 붙임줄은 성부를 정한 다음 성부별로 합친다(성부별 길이를 지킨다)
//   has    { top, mid, bottom }: 그 성부만의 음이 몇 개 있는지 (0 이면 이 줄에는 그 성부가 없다)
//   guess  성부를 어림했거나 가리지 못한 음이 있는 마디들 (song.measures 의 번호가 아니라 순서)
//   info   "마디|박|음높이" → { line, by }: 음마다 어떻게 정했는지. by = given(적혀 있음) | rest(쉼표) | pitch(같이 울리는 음) | plain(한 성부로 적힌 곳)
//          | guess(어림) | unknown(모름)
const SPEC = ["top", "mid", "bottom"];
const isSpec = (v) => v === "top" || v === "mid" || v === "bottom";
export const voiceKey = (m, beat, midi) => `${m}|${Math.round(beat * 1000) / 1000}|${midi}`;

export function voiceLines(song, part, starts) {
  const eps = 1e-6;
  const raw = unfoldNotes(song, part, starts);
  const all = mergeTies(raw.map((n) => ({ ...n, heads: n.heads.slice() })), song.order);

  const restInfo = Array.isArray(part.rests);                      // 쉼표 정보가 있는 곡인가
  const unsure = new Set(part.rest_unsure || []);                  // 쉼표를 믿을 수 없는 마디 (박자 합이 안 맞는 마디)
  const restsIn = new Map();
  if (restInfo) for (const r of part.rests) { if (!restsIn.has(r.m)) restsIn.set(r.m, []); restsIn.get(r.m).push(r); }
  const knowRests = (n) => restInfo && !unsure.has(n.m);
  const restsOver = (n, from, to) => (restsIn.get(n.m) || []).filter((r) => r.beat < to - eps && from < r.beat + r.dur - eps);

  // 미리 보기: 울리는 동안 다른 음이 하나도 없으면 "혼자 나오는 음". _next = 그 뒤에 처음으로 음이 겹쳐 나오는 때
  raw.forEach((n, i) => {
    const end = n.start + n.dur;
    let alone = true;
    for (let j = i - 1; j >= 0 && i - j < 64 && alone; j--) if (raw[j].start + raw[j].dur > n.start + eps) alone = false;
    if (i + 1 < raw.length && raw[i + 1].start < end - eps) alone = false;
    n._alone = alone;
  });
  for (let i = raw.length - 1, next = Infinity; i >= 0; i--) { raw[i]._next = next; if (!raw[i]._alone) next = raw[i].start; }

  const last = { top: null, mid: null, bottom: null };             // 그 성부가 마지막으로 낸 음 { midi, end, shared: 같이 부른 음 }
  let specEnd = -Infinity;                                         // 한 성부만의 음이 마지막으로 끝난 때
  const openTies = new Map();                                      // 음높이 → 붙임줄이 열려 있는 음들
  const place = (n, line, by) => {
    n.line = line; n.by = by;
    const end = n.start + n.dur;
    if (isSpec(line)) { last[line] = { midi: n.midi, end }; specEnd = Math.max(specEnd, end); }
    else { last.top = { midi: n.midi, end, shared: true }; last.bottom = { midi: n.midi, end, shared: true }; last.mid = null; }      // 모든 성부가 이 음에 모인다
    if (n.tie) { if (!openTies.has(n.midi)) openTies.set(n.midi, []); openTies.get(n.midi).push(n); }
  };

  // 혼자 나오는 음을 어림한다. oneVoice: 쉬는 성부가 있다는 것은 안다(누구인지만 모른다)
  const guessLone = (n, oneVoice) => {
    const len = song.measures[n.m].len;
    // 쉼표 정보가 없는 곡: 앞뒤 한 마디 안에 갈라 부르는 곳이 있을 때만 어림한다. 화음 한 번 뒤에 길게 이어지는 선율은 같이 부르는 음으로 둔다
    const inside = oneVoice || (n.start - specEnd <= len + eps && n._next - (n.start + n.dur) <= len + eps);
    if (!inside) return place(n, "one", "plain");
    const c = SPEC.filter((v) => last[v] && !last[v].shared).map((v) => [v, Math.abs(n.midi - last[v].midi)]).sort((x, y) => x[1] - y[1]);
    if (c.length >= 2 && c[0][1] < c[1][1]) return place(n, c[0][0], "guess");
    return place(n, "one", "unknown");
  };
  const lone = (n) => {
    if (!knowRests(n)) return guessLone(n, false);
    const rs = restsOver(n, n.beat, n.beat + n.dur);
    if (!rs.length) return place(n, "one", "plain");                 // 쉬는 성부가 없다 = 한 성부로 적힌 곳 → 같이 부르는 음
    const who = new Set(rs.map((r) => r.voice).filter((v) => v === "top" || v === "bottom"));
    if (who.size === 1) return place(n, who.has("top") ? "bottom" : "top", "rest");
    return guessLone(n, true);
  };

  for (let i = 0; i < raw.length;) {
    let j = i + 1;
    while (j < raw.length && raw[j].start < raw[i].start + eps) j++;
    const t = raw[i].start, group = raw.slice(i, j).sort((x, y) => y.midi - x.midi);      // 같이 시작하는 음들, 높은 음부터
    i = j;
    let todo = [];
    for (const n of group) {
      if (n.voice === "both") place(n, "one", "given");
      else if (isSpec(n.voice)) place(n, n.voice, "given");
      else todo.push(n);
    }
    todo = todo.filter((n) => {                                      // 붙임줄로 이어 받은 음: 앞 음이 한 성부의 것이면 그 성부 그대로
      const src = (openTies.get(n.midi) || []).filter((o) => Math.abs(o.start + o.dur - n.start) < eps && isSpec(o.line)).pop();
      if (src) place(n, src.line, src.by);
      return !src;
    });
    if (!todo.length) continue;
    if (todo.length === 1 && todo[0]._alone) { lone(todo[0]); continue; }

    // 여러 음이 같이 울린다: 이미 음을 내고 있는 성부를 빼고 남은 성부에 나눠 준다
    const busy = (v) => !!last[v] && !last[v].shared && last[v].end > t + eps;
    const nBusy = SPEC.filter(busy).length, g = todo.length;
    // 세 성부로 갈라 부르는 대목인가: 지금 세 음이 같이 울리거나, 가운데 성부가 방금(한 박 안쪽)까지 음을 냈다.
    // 가운데 성부가 한참 쉬었으면 두 성부로 본다 — 두 음 화음을 위·가운데로 잘못 가르지 않게 (그러면 "아래만"이 조용해진다)
    const three = g + nBusy >= 3 || (!!last.mid && last.mid.end > t - 1 - eps);
    let free = (three ? SPEC : ["top", "bottom"]).filter((v) => !busy(v));
    const give = (labs, by) => todo.forEach((n, k) => {
      const odd = labs[k] === "mid" && nBusy === 2 && (n.midi > last.top.midi || n.midi < last.bottom.midi);      // 가운데라고 했지만 가장 높거나 낮다 → 어림
      place(n, labs[k], odd ? "guess" : by);
    });
    if (g === free.length) { give(free, "pitch"); continue; }
    if (g > free.length) {                                           // 음이 성부보다 많다 (네 음 화음 등): 맨 위·맨 아래를 먼저 주고 나머지는 가운데
      if (!free.length) give(todo.map(() => "mid"), "guess");
      else give(todo.map((_, k) => free[Math.round(k * (free.length - 1) / Math.max(1, g - 1))]), nBusy ? "guess" : "pitch");
      continue;
    }
    // 음이 성부보다 적다 = 어느 성부는 쉰다. 누가 쉬는가
    let by = "pitch";
    if (knowRests(todo[0])) {                                        // (가) 지금 쉼표로 쉬고 있는 성부
      const rs = restsOver(todo[0], todo[0].beat, todo[0].beat + 1e-3);
      const resting = new Set(rs.map((r) => r.voice).filter(isSpec));
      const cut = free.filter((v) => !resting.has(v));
      if (cut.length >= g && cut.length < free.length) { free = cut; by = "rest"; }
      else if (!rs.length && free.includes("mid") && free.length - 1 >= g) {
        // 쉬는 성부가 없는데 음이 모자란다 = 셋으로 갈랐던 것이 끝났다 (쉼표 정보가 있는 곡에서만 알 수 있다) → 가운데 성부는 없는 것으로 본다
        free = free.filter((v) => v !== "mid");
        last.mid = null;
      }
    }
    if (g === free.length) { give(free, by); continue; }
    const end = Math.min(...todo.map((n) => n.start + n.dur));       // (나) 이 음들이 울리는 동안 곧 들어올 음들
    const soon = [];
    for (let k = j; k < raw.length && raw[k].start < end - eps; k++) if (!soon.length || raw[k].start < soon[0].start + eps) soon.push(raw[k]);
    if (soon.length) {
      const named = new Set(soon.map((o) => o.voice).filter(isSpec));
      const cut = free.filter((v) => !named.has(v));
      if (cut.length >= g) free = cut;
      if (g === free.length) { give(free, by); continue; }
      const hi = todo[0].midi, lo = todo[g - 1].midi;
      const above = soon.some((o) => o.midi > hi), below = soon.some((o) => o.midi < lo);
      if (above && below && g === 1) { give(["mid"], by); continue; }                    // 위아래로 다른 성부가 들어온다 → 가운데
      if (above && !below) { give(free.slice(free.length - g), by); continue; }          // 더 높은 음이 들어온다 → 이 음들은 아래쪽 성부
      if (below && !above) { give(free.slice(0, g), by); continue; }
    }
    // (다) 어림: 앞 음과 가장 가깝게 이어지는 성부들에 (성부의 위아래 순서는 지킨다)
    const combos = [];
    const pick = (from, acc) => { if (acc.length === g) { combos.push(acc); return; } for (let k = from; k < free.length; k++) pick(k + 1, acc.concat(free[k])); };
    pick(0, []);
    const known = free.every((v) => last[v] && !last[v].shared);
    const scored = combos.map((c) => [c, c.reduce((sum, v, k) => sum + Math.abs(todo[k].midi - last[v].midi), 0)]);
    if (known) scored.sort((x, y) => x[1] - y[1]);
    if (known && scored.length >= 2 && scored[0][1] < scored[1][1]) { give(scored[0][0], "guess"); continue; }
    if (g === 1) { place(todo[0], "one", "unknown"); continue; }     // 가릴 수 없다 → 같이 부르는 음으로 두고 "모름"
    give(todo.map((_, k) => free[Math.round(k * (free.length - 1) / (g - 1))]), "guess");
  }

  const lines = {}, has = { top: 0, mid: 0, bottom: 0 }, guess = new Set(), info = new Map();
  for (const n of raw) {
    if (isSpec(n.line)) has[n.line]++;
    if (n.by === "guess" || n.by === "unknown") guess.add(n.m);
    const key = voiceKey(n.m, n.beat, n.midi);
    if (!info.has(key)) info.set(key, { line: n.line, by: n.by });
  }
  for (const v of SPEC) {
    const seq = [];
    for (const n of raw) {
      if (n.line !== v && n.line !== "one") continue;
      const mine = n.line === "one" && n.vd && n.vd[v];              // 두 성부가 같은 음을 길이만 다르게 낼 때: 이 성부의 길이·붙임줄
      seq.push({ ...n, dur: mine ? mine.dur : n.dur, tie: mine ? mine.tie : n.tie, heads: n.heads.slice() });
    }
    lines[v] = mergeTies(seq, song.order);
  }
  return { all, lines, has, guess: [...guess].sort((x, y) => x - y), info };
}

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const acc = (s) => (s === "#" ? 1 : s === "b" ? -1 : 0);

// 코드 이름 → 구성음. 예: Am7 → 라·도·미·솔, D/F# → 베이스 파#
export function parseChord(name) {
  const m = /^([A-G])([#b]?)(.*?)(?:\/([A-G])([#b]?))?$/.exec(name);
  if (!m) return null;
  const root = (PC[m[1]] + acc(m[2]) + 12) % 12;
  const bass = m[4] ? (PC[m[4]] + acc(m[5]) + 12) % 12 : root;
  const q = m[3];
  // 아는 낱말로만 이루어진 이름이어야 한다. 읽다가 깨진 글자("Cgarbage", "C/X")를 그럴듯한 화음으로 바꿔 치지 않는다 → 그 자리는 반주를 내지 않는다
  if (!/^(?:maj|Maj|min|dim|aug|alt|sus[24]?|add\d+|omit\d+|no\d+|M|m|°|ø|\+|-|△|[#b]?\d+|[(),\/]|\s)*$/.test(q) || /\/$/.test(q)) return null;
  const six9 = /6\/?9/.test(q);                  // C69 · C6/9: 6음과 9음을 더한 화음 (7음은 없다)
  let third = 4, fifth = 7, seventh = null;
  const ext = [];
  if (/^(m|min)(?!aj)/.test(q)) third = 3;
  if (/dim|°/.test(q)) { third = 3; fifth = 6; if (/7/.test(q)) seventh = 9; }
  if (/ø/.test(q)) { third = 3; fifth = 6; seventh = 10; }
  if (/aug|\+/.test(q)) fifth = 8;
  if (/sus2/.test(q)) third = 2; else if (/sus/.test(q)) third = 5;
  if (/b5/.test(q)) fifth = 6;
  if (/#5/.test(q)) fifth = 8;
  if (/(M|maj|Maj|△)(7|9|11|13)/.test(q)) seventh = 11;      // 장7도: CM7 Cmaj9 Cmaj11 CM13 …
  // 7음은 괄호 밖에 7·9·11·13이 있을 때만 넣는다 (예: Dm(b13)에는 7음이 없다, A7(b9)에는 있다)
  else if (seventh === null && !six9 && /7|9|11|13/.test(q.replace(/\([^)]*\)/g, "").replace(/add\d+/g, ""))) seventh = 10;
  if (/6/.test(q)) ext.push(9);
  if (/#9/.test(q)) ext.push(3); else if (/b9/.test(q)) ext.push(1); else if (/9/.test(q)) ext.push(2);
  if (/add2|^2|\(2\)/.test(q) && third !== 2) ext.push(2);
  if (/#11/.test(q)) ext.push(6); else if (/11/.test(q)) ext.push(5);
  if (/b13/.test(q)) ext.push(8); else if (/13/.test(q)) ext.push(9);
  let tones = [0, third, fifth];
  if (/omit3|no3|^5$/.test(q) || (/11/.test(q) && !/#11/.test(q) && third === 4)) tones = tones.filter((t) => t !== third);
  if (/omit5|no5/.test(q)) tones = tones.filter((t) => t !== fifth);
  if (seventh !== null) tones.push(seventh);
  for (const x of ext) if (!tones.includes(x)) tones.push(x);
  return { root, bass, tones };
}

// 코드 반주: 베이스는 낮게, 나머지 음은 가운데 음역에 모아서
// ---- 확인 상태 (P3-1). 마디마다 서로 다른 네 가지를 섞지 않고 따로 적는다:
//   state "auto"   자동 검사를 통과했다 (사람이 확인했다는 뜻이 아니다)
//         "user"   사용자가 "확인 완료"로 표시했다
//         "unsure" 인식이 불확실하다 — why 에 까닭: 박자 합 "sum" · 세로 정렬 "align" · 기호 검사 "symbol" · 가사 밑에 음표가 없음 "lyric" · 까닭이 안 적힌 옛 자료 "check"
//                  · 고친 뒤 다시 읽었더니 달라짐 "stale" · 스캔에서 이음줄을 붙임줄로 본 곳 "tie"
//   unsupported    악보에 있지만 소리 내지 않는 표기 (꾸밈음 "grace"·"grace_piano", 음높이 없는 음표 "unpitched", 해석 못 한 코드 "chord").
//                  확인했다고 사라지지 않으므로 state 와 따로 둔다
// song 은 고친 내용을 덧씌운 곡(edits.js 의 applyEdits 결과)이다.
export function checkState(song) {
  const tie = new Set();
  for (const p of song.parts) for (const n of p.notes) if (n.tieGuess) tie.add(n.m);
  const count = { auto: 0, user: 0, unsure: 0, unsupported: 0 };
  const measures = song.measures.map((m, mi) => {
    const why = [];
    if (m.stale) why.push("stale");                   // 예전에 확인했더라도 다시 봐야 한다
    else if (!m.checked) {
      if (!m.ok) why.push(...(m.why && m.why.length ? m.why : ["check"]));
      if (tie.has(mi)) why.push("tie");
    }
    const unsupported = [...(m.unsupported || [])];
    if ((m.chords || []).some((c) => !parseChord(c.name))) unsupported.push("chord");
    const state = why.length ? "unsure" : m.checked ? "user" : "auto";
    count[state]++;
    if (unsupported.length) count.unsupported++;
    return { state, why, unsupported };
  });
  return { measures, count };
}

export function chordVoicing(name) {
  const c = parseChord(name);
  if (!c) return null;
  const bass = 36 + c.bass + (c.bass > 7 ? -12 : 0);
  const tones = c.tones.map((t) => {
    const pc = (c.root + t) % 12;
    return 53 + ((pc - 53 % 12 + 12) % 12);          // 파3 ~ 미4 사이
  });
  return { bass: bass < 33 ? bass + 12 : bass, tones: [...new Set(tones)].sort((a, b) => a - b) };
}

// 코드 반주 음표. style: "long"(코드가 바뀔 때만 길게) | "beat"(박마다)
// ---- 박 계산: 메트로놈 · 카운트인 · 코드 반주("박마다")가 같이 쓴다
// 박자표의 종류: "compound" 겹박자(6/8 9/8 12/8: 큰 박 = 점4분음표) | "odd" 5/8·7/8(8분음표마다, 묶음이 있다) | "simple" 그 밖(큰 박 = 분모의 음표)
// | "unknown" 읽지 못한 박자(분모가 5인 박자 등 — 다른 박자로 바꾸지 않는다)
export function meterKind(meter) {
  const [n, d] = meter || [];
  if (!(n > 0) || ![1, 2, 4, 8, 16].includes(d)) return "unknown";
  if (d === 8 && n > 3 && n % 3 === 0) return "compound";
  if (d === 8 && (n === 5 || n === 7)) return "odd";
  return "simple";
}
// 5/8·7/8 의 묶음. 맨 앞이 고르지 않았을 때 쓰는 값이다 (악보의 빔 묶음은 아직 읽지 않는다 → 추정)
export const GROUPS = { "5/8": ["2+3", "3+2"], "7/8": ["2+2+3", "2+3+2", "3+2+2"] };

// 한 마디에서 칠 박들. → [{ b: 마디 처음부터의 박(4분음표 = 1), level: 2 강 | 1 중 | 0 약, main: 큰 박(또는 묶음의 첫 박)인가 }]
// 강 = 마디 첫 박, 중 = 겹박자의 큰 박·묶음의 첫 박(세분박을 같이 칠 때의 큰 박), 약 = 세분박과 홑박자의 나머지 박.
// opt.sub: 세분박 듣기. true | false | 정하지 않음(겹박자면 켬, 홑박자면 끔). 5/8·7/8 은 언제나 8분음표마다 친다.
// opt.groups: { "5/8": "3+2", "7/8": "2+3+2" } 처럼 고른 묶음
export function beatPlan(m, opt = {}) {
  const kind = meterKind(m.meter), len = m.len, out = [], eps = 1e-6;
  if (kind === "unknown") { for (let b = 0; b < len - eps; b += 1) out.push({ b, level: b ? 0 : 2, main: true }); return out; }
  const [n, d] = m.meter, unit = 4 / d;
  if (kind === "odd") {
    const firsts = new Set();
    let acc = 0;
    for (const x of ((opt.groups && opt.groups[`${n}/${d}`]) || GROUPS[`${n}/${d}`][0]).split("+")) { firsts.add(acc); acc += +x; }
    for (let i = 0; i * unit < len - eps; i++) out.push({ b: i * unit, level: i === 0 ? 2 : firsts.has(i) ? 1 : 0, main: firsts.has(i) });
    return out;
  }
  if (kind === "compound") {
    const sub = opt.sub !== false;
    for (let i = 0; i * unit < len - eps; i++) { const big = i % 3 === 0; if (big || sub) out.push({ b: i * unit, level: i === 0 ? 2 : big ? 1 : 0, main: big }); }
    return out;
  }
  const sub = opt.sub === true;                  // 홑박자: 켜면 큰 박 사이(반 박)도 친다. 그때 큰 박은 강·중, 사이는 약
  for (let i = 0; i * unit < len - eps; i++) {
    out.push({ b: i * unit, level: i === 0 ? 2 : sub ? 1 : 0, main: true });
    if (sub && i * unit + unit / 2 < len - eps) out.push({ b: i * unit + unit / 2, level: 0, main: false });
  }
  return out;
}

export function chordEvents(song, starts, style, opt) {
  const ev = [];
  let last = null;
  song.order.forEach((oi, k) => {
    const m = song.measures[oi];
    const pts = m.chords.map((c) => ({ beat: c.beat, name: c.name }));
    if (last && (!pts.length || pts[0].beat > 0.01)) pts.unshift({ beat: 0, name: last });
    pts.forEach((p, i) => {
      const end = i + 1 < pts.length ? pts[i + 1].beat : m.len;
      const v = chordVoicing(p.name);
      if (!v || end <= p.beat) return;
      const strikes = [];
      // "박마다": 코드가 바뀌는 자리와, 그 뒤의 큰 박마다 (메트로놈의 큰 박과 같은 자리 — 겹박자는 점4분, 5/8·7/8 은 묶음의 첫 박)
      strikes.push(p.beat);
      if (style === "beat") for (const x of beatPlan(m, opt)) if (x.main && x.b > p.beat + 0.01 && x.b < end - 0.01) strikes.push(x.b);
      strikes.forEach((b, j) => {
        const nxt = j + 1 < strikes.length ? strikes[j + 1] : end;
        const d = nxt - b;
        if (j === 0) ev.push({ b: starts[k] + b, d: end - b, midi: v.bass, tr: "chord", v: 0.75, fixed: true });
        for (const t of v.tones) ev.push({ b: starts[k] + b, d, midi: t, tr: "chord", v: j === 0 ? 0.55 : 0.4 });
      });
    });
    if (pts.length) last = pts[pts.length - 1].name;
  });
  return ev;
}

// 메트로놈: 마디마다 그 마디의 박자표를 따른다 (beatPlan). level 2 강 · 1 중 · 0 약
export function clickEvents(song, starts, opt) {
  const ev = [];
  song.order.forEach((oi, k) => {
    for (const x of beatPlan(song.measures[oi], opt)) ev.push({ b: starts[k] + x.b, d: 0, tr: "metro", click: true, accent: x.level === 2, level: x.level, main: x.main });
  });
  return ev;
}

// 빠르기 지도: 곡 처음부터의 박 ↔ 초. rit.은 점점 느리게, 페르마타는 그 음을 두 배로 늘인다.
export function buildTimeline(song, starts, ratio, parts) {
  const ferm = new Map();                              // 악보 마디 번호 → [[시작 박, 끝 박]]
  for (const p of parts) for (const n of p.notes) if (n.fermata) {
    if (!ferm.has(n.m)) ferm.set(n.m, []);
    ferm.get(n.m).push([n.beat, n.beat + Math.min(n.dur, 2)]);
  }
  const segs = [];
  let t = 0, rit = null, prevBpm = null;
  song.order.forEach((oi, k) => {
    const m = song.measures[oi];
    const spb = 60 / (m.bpm * ratio);
    if (prevBpm !== null && m.bpm !== prevBpm) rit = null;
    prevBpm = m.bpm;
    const ritMark = m.marks.find((x) => x.type === "rit");
    const aTempo = m.marks.find((x) => x.type === "a_tempo");
    if (rit && k > rit.k + 1) rit = null;
    const fs = ferm.get(oi) || [];
    const fine = rit || ritMark || aTempo || fs.length;
    const step = fine ? 0.25 : m.len;
    for (let x = 0; x < m.len - 1e-9; x += step) {
      const x1 = Math.min(m.len, x + step);
      if (aTempo && x >= aTempo.beat - 1e-6) rit = null;
      if (ritMark && !rit && x >= ritMark.beat - 1e-6 && !(aTempo && aTempo.beat > ritMark.beat && x >= aTempo.beat)) {
        rit = { k, from: starts[k] + ritMark.beat, span: Math.max(1, m.len - ritMark.beat) };
      }
      let f = 1;
      if (rit) f *= 1 - 0.3 * Math.min(1, Math.max(0, (starts[k] + x - rit.from) / rit.span));
      if (fs.some(([a, b]) => x >= a - 1e-6 && x < b - 1e-6)) f *= 0.5;
      segs.push({ b0: starts[k] + x, b1: starts[k] + x1, t0: t, spb: spb / f });
      t += (x1 - x) * spb / f;
    }
  });
  const find = (pred) => { let lo = 0, hi = segs.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pred(segs[mid])) lo = mid; else hi = mid - 1; } return segs[lo]; };
  return {
    total: t,
    secOf(b) { const s = find((g) => g.b0 <= b + 1e-9); return s.t0 + (Math.min(b, s.b1) - s.b0) * s.spb + Math.max(0, b - s.b1) * s.spb; },
    beatOf(sec) { const s = find((g) => g.t0 <= sec + 1e-9); return Math.min(s.b1, s.b0 + (sec - s.t0) / s.spb); },
  };
}
