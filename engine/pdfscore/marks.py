"""음표 말고 나머지: 붙임줄·이음줄, 셋잇단음표, 박자표, 빠르기, 코드, 가사, 괄호, 페르마타, 글자 표시."""
import re
from dataclasses import dataclass, field
from fractions import Fraction as F

from .glyphs import music_map, is_music_font, chord_map, family, TUPLET_FONTS, SMUFL

CHORD_RE = re.compile(
    r"^[A-G][#b]?(?:maj|min|dim|aug|sus|add|M|m|\+|°|ø|o)?[0-9]*"
    r"(?:(?:sus|add|maj|dim|aug|M|b|#|\+|-)[0-9]*)*(?:\([^)]*\))*(?:/[A-G][#b]?)?$")
TUPLET_RATIO = {3: F(2, 3), 6: F(2, 3), 5: F(4, 5), 7: F(4, 7), 2: F(3, 2)}


def is_hangul(ch):
    return "가" <= ch <= "힣" or "ㄱ" <= ch <= "ㅣ"


def _pow2(v):
    n, d = v.numerator, v.denominator
    return n > 0 and n & (n - 1) == 0 and d & (d - 1) == 0


# ------------------------------------------------------------------ 붙임줄 · 이음줄
def find_ties(curves, sysm, heads, events, zone):
    """머리 오른쪽 끝에서 다음 같은 높이 머리로 이어지는 곡선 = 붙임줄. 나머지는 이음줄."""
    sp = sysm.sp
    slurs = []
    last_bar = sysm.bars[-1].x0 if sysm.bars else sysm.x1
    for c in curves:
        if not c.fill or c.used or len(c.path) < 3 or c.path[0][0] != "m" or c.path[1][0] != "c":
            continue
        if sum(1 for s in c.path if s[0] == "c") != 2:
            continue
        a, seg = c.path[0][1], c.path[1]
        b = seg[3]
        ctrl_y = (seg[1][1] + seg[2][1]) / 2
        if a[0] > b[0]:
            a, b = b, a
        (xs, ys), (xe, ye) = a, b
        if xe - xs < 0.8 * sp:
            continue
        inzone = zone[0] <= (c.top + c.bottom) / 2 < zone[1]
        starts = [h for h in heads if not h.grace and -0.75 * (h.x1 - h.x0) <= xs - h.x1 <= 2.2 * sp
                  and abs(ys - h.y) <= 1.7 * sp]
        ends = [h for h in heads if not h.grace and -1.5 * sp <= xe - h.x0 <= 0.75 * (h.x1 - h.x0)
                and abs(ye - h.y) <= 1.7 * sp]
        best = None
        for h1 in starts:
            if h1.tie_out:
                continue
            for h2 in ends:
                if h2.tie_in or h2.staff is not h1.staff or h2.pos != h1.pos or h2.x0 <= h1.x0 + 0.5 * (h1.x1 - h1.x0):
                    continue
                if any(h.staff is h1.staff and h.pos == h1.pos and h1.x0 + 0.1 < h.x0 < h2.x0 - 0.1 for h in heads):
                    continue
                score = abs(ys - h1.y) + abs(ye - h2.y)
                if best is None or score < best[0]:
                    best = (score, h1, h2)
        if best:
            _, h1, h2 = best
            h1.tie_out, h2.tie_in = True, True
            h2.tie_from = h1
            c.used = "tie"
            continue
        # 줄 끝에서 다음 줄로 넘어가는 붙임줄 (끝나는 머리가 없다)
        if xe >= last_bar - 0.5 * sp and starts:
            cand = [h for h in starts if not h.tie_out and not any(
                o.staff is h.staff and o.x0 > h.x1 for o in heads)]
            if cand:
                min(cand, key=lambda h: abs(ys - h.y)).open_out = True
                c.used = "tie"
                continue
        # 줄 처음에서 앞 줄로부터 넘어온 붙임줄 (시작하는 머리가 없다)
        if ends:
            cand = [h for h in ends if not h.tie_in and not any(
                o.staff is h.staff and o.x1 < h.x0 and o.x0 > xs - sp for o in heads)]
            first_x = {h.staff.idx: min(o.x0 for o in heads if o.staff is h.staff) for h in cand}
            cand = [h for h in cand if h.x0 <= first_x[h.staff.idx] + 0.1 and xs < h.x0 - 1.0 * sp]
            if cand:
                min(cand, key=lambda h: abs(ye - h.y)).open_in = True
                c.used = "tie"
                continue
        if inzone:
            c.used = "slur"
            slurs.append((xs, ys, xe, ye, ctrl_y))
    # 이음줄: 양 끝에서 가장 가까운 음을 찾아 그 사이를 이어서 부르는 구간으로 표시
    notes = [e for e in events if e.kind == "note"]
    for xs, ys, xe, ye, _ in slurs:
        def near(x, y):
            best = None
            for e in notes:
                dy = min(abs(y - e.ytop), abs(y - e.ybottom), *(abs(y - h.y) for h in e.heads))
                dx = abs(x - e.cx)
                if dx <= 2.5 * sp and dy <= 3.0 * sp:
                    k = dx + 0.5 * dy
                    if best is None or k < best[0]:
                        best = (k, e)
            return best[1] if best else None
        s, t = near(xs, ys), near(xe, ye)
        if not s or not t or s is t or s.staff is not t.staff or t.x <= s.x:
            continue
        span = sorted([e for e in notes if e.staff is s.staff and s.x - 0.1 <= e.x <= t.x + 0.1], key=lambda e: e.x)
        for e in span:
            e.slur = e.slur or "mid"
        s.slur, t.slur = "start", "end"


# ------------------------------------------------------------------ 셋잇단음표
def apply_tuplets(chars, sysm, events, beams=()):
    """잇단음표 숫자 3(5, 6, 7)이 어느 음들에 걸리는지 정한다.
    1) 숫자가 빔 바로 옆에 있으면 그 빔으로 묶인 음들 (다른 성부의 음이 같은 자리에 겹쳐 있어도 끌어들이지 않는다)
    2) 아니면 숫자 근처에서, 길이를 줄였을 때 딱 떨어지는 연속된 음표 묶음"""
    sp = sysm.sp
    smufl = any(music_map(c.font) is SMUFL for c in chars)
    num = {}
    for c in chars:
        if c.used or c.size >= sysm.sp * 3.2:
            continue
        if c.t in "23567" and (family(c.font) in TUPLET_FONTS
                               or ("Italic" in c.font and not is_music_font(c.font) and ("Bold" in c.font or smufl))):
            num[id(c)] = int(c.t)
        elif len(c.t) == 1 and 0xE882 <= ord(c.t) <= 0xE887 and music_map(c.font) is SMUFL and ord(c.t) - 0xE880 in TUPLET_RATIO:
            num[id(c)] = ord(c.t) - 0xE880
    digs = [c for c in chars if id(c) in num]
    pool = [e for e in events if e.kind != "grace"]
    for d in sorted(digs, key=lambda c: c.cx):
        dcy = (d.top + d.bottom) / 2
        n = num[id(d)]
        ratio = TUPLET_RATIO[n]

        def vd(e):
            top, bot = (e.ytop, e.ybottom) if e.kind == "note" else (e.y - sp, e.y + sp)
            return 0.0 if top <= dcy <= bot else min(abs(dcy - top), abs(dcy - bot))
        cand = [e for e in pool if abs(e.cx - d.cx) < 6 * sp and vd(e) < 3.5 * sp]
        if not cand:
            continue
        # 1) 빔으로 묶인 음들
        near = [b for b in beams if b.x0 - sp <= d.cx <= b.x1 + sp and abs(b.y_at(d.cx) - dcy) <= 2.4 * sp]
        done = False
        for b in sorted(near, key=lambda b: abs(b.y_at(d.cx) - dcy)):
            grp = sorted([e for e in pool if e.kind == "note" and e.stem and b.x0 - 0.4 <= e.stem["x"] <= b.x1 + 0.4
                          and e.stem["top"] - 0.6 * sp <= b.y_at(e.stem["x"]) <= e.stem["bottom"] + 0.6 * sp], key=lambda e: e.x)
            if len(grp) < 2 or any(e.tuplet for e in grp):
                continue
            inside = [e for e in pool if e.kind == "rest" and e.staff is grp[0].staff and grp[0].x < e.x < grp[-1].x and not e.tuplet]
            members = grp + inside
            if _pow2(sum((e.dur for e in members), F(0)) * ratio):
                for e in members:
                    e.tuplet = (n, ratio)
                d.used = "tuplet"
                done = True
                break
        if done:
            continue
        # 2) 숫자 근처의 연속된 음표 묶음
        anchor = min(cand, key=lambda e: vd(e) + 0.3 * abs(e.cx - d.cx))
        row = sorted([e for e in pool if e.staff is anchor.staff and e.region == anchor.region], key=lambda e: e.x)
        best = None
        for i in range(len(row)):
            total = F(0)
            for j in range(i, len(row)):
                if row[j].tuplet:
                    break
                total += row[j].dur
                if j == i or not _pow2(total * ratio):
                    continue
                center = (row[i].cx + row[j].cx) / 2
                score = abs(center - d.cx) + (0 if (j - i + 1) == n else 0.4 * sp)
                if best is None or score < best[0]:
                    best = (score, i, j)
        if best and best[0] < 3.0 * sp:
            for e in row[best[1]:best[2] + 1]:
                e.tuplet = (n, ratio)
            d.used = "tuplet"


# ------------------------------------------------------------------ 박자표
def find_timesigs(chars, sysm):
    """오선 위에 큰 숫자 두 개가 위아래로 쌓인 것. → [(x, 분자, 분모)]"""
    out = []
    for st in sysm.staves:
        rows = {6: [], 2: []}
        for c in chars:
            mm = music_map(c.font)
            if not mm or c.used or c.size < st.gsize * 0.8:
                continue
            if c.t in mm["time_digits"]:
                p = st.pos(c.oy)
                for k in rows:
                    if abs(p - k) < 0.35 and st.x0 - 1 <= c.ox <= st.x1 + 3 * st.sp:
                        rows[k].append(c)
            elif c.t in mm["time_symbols"] and abs(st.pos(c.oy) - 4) < 0.6 and st.x0 <= c.ox <= st.x1:
                c.used = "time"
                out.append((c.ox, *mm["time_symbols"][c.t]))

        def groups(cs):
            cs = sorted(cs, key=lambda c: c.ox)
            g = []
            for c in cs:
                if g and c.ox - g[-1][-1].ox < 1.9 * st.sp:
                    g[-1].append(c)
                else:
                    g.append([c])
            return g
        for ng in groups(rows[6]):
            for dg in groups(rows[2]):
                if abs(ng[0].ox - dg[0].ox) < 2.2 * st.sp:
                    for c in ng + dg:
                        c.used = "time"
                    dm = (music_map(ng[0].font) or {}).get("digit_map", {})
                    out.append((ng[0].ox, int("".join(dm.get(c.t, c.t) for c in ng)), int("".join(dm.get(c.t, c.t) for c in dg))))
    out.sort()
    uniq = []
    for t in out:
        if not uniq or t[0] - uniq[-1][0] > 2.5 * sysm.sp:
            uniq.append(t)
    return uniq


# ------------------------------------------------------------------ 글자 묶음
@dataclass
class Phrase:
    text: str
    x0: float
    x1: float
    top: float
    bottom: float
    font: str
    size: float
    chars: list = field(default_factory=list)

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2

    @property
    def cy(self):
        return (self.top + self.bottom) / 2


def phrases(chars):
    """같은 글꼴·같은 줄에서 가까이 붙은 글자를 낱말·구절로 묶는다."""
    cs = sorted([c for c in chars if not is_music_font(c.font)], key=lambda c: (c.font, round(c.size, 1), round(c.oy, 0), c.x0))
    out = []
    for c in cs:
        p = out[-1] if out else None
        if p and p.font == c.font and abs(p.size - c.size) < 0.2 and abs(p.chars[-1].oy - c.oy) < 0.6 \
                and -0.3 * c.size < c.x0 - p.x1 < 0.45 * c.size:
            if c.x0 - p.x1 > 0.18 * c.size:
                p.text += " "
            p.text += c.t
            p.x1 = c.x1
            p.top, p.bottom = min(p.top, c.top), max(p.bottom, c.bottom)
            p.chars.append(c)
        else:
            out.append(Phrase(text=c.t, x0=c.x0, x1=c.x1, top=c.top, bottom=c.bottom, font=c.font, size=c.size, chars=[c]))
    return out


def in_rect(p, rects):
    return any(r.stroke and r.x0 - 1 <= p.x0 and p.x1 <= r.x1 + 1 and r.top - 1 <= p.top and p.bottom <= r.bottom + 1
               for r in rects)


# ------------------------------------------------------------------ 빠르기
def find_tempos(chars):
    """'음표 = 숫자' → [(x, y, 4분음표 기준 빠르기)]"""
    out = []
    unit = {"q": F(1), "h": F(2), "e": F(1, 2), "w": F(4), "x": F(1, 4)}
    for e in chars:
        if e.t != "=":
            continue
        row = sorted([c for c in chars if abs(c.oy - e.oy) < 0.35 * e.size and abs(c.x0 - e.x0) < 6 * e.size],
                     key=lambda c: c.x0)
        left = [c for c in row if c.x1 <= e.x0 + 0.5 and e.x0 - c.x1 < 2.2 * e.size]
        right = [c for c in row if c.x0 >= e.x1 - 0.5]
        note = next((c for c in reversed(left) if c.t in unit and is_music_font(c.font)), None)
        digits = ""
        prev = e.x1
        for c in right:
            if c.t.isdigit() and c.x0 - prev < 1.2 * e.size:
                digits += c.t
                prev = c.x1
            elif digits:
                break
        if note is None or not digits or not (20 <= int(digits) <= 400):
            continue
        u = unit[note.t]
        if any(c.t == "." and note.x1 - 0.5 <= c.x0 < e.x0 for c in left):
            u = u * F(3, 2)
        out.append((note.x0, e.oy, float(int(digits) * u)))
    return out


# ------------------------------------------------------------------ 코드 기호
SLASH_ONLY = re.compile(r"^/[A-G][#b]?$")      # 베이스만 적힌 표기: 앞 코드는 그대로, 베이스만 바뀐다
RESOLVE_3 = ("-3", "7")                         # 앞 코드에 기대는 짧은 표기: '-3' = sus가 3음으로 풀림, '7' = 앞 코드에 7음 추가


def _split_token(pieces):
    """붙어 찍힌 글자 묶음 → 코드 이름들. pieces: [(글자열, 원래 글자)]
    'F#m7(b5)Am' → 'F#m7(b5)', 'Am'.  묶음 전체가 코드로만 이루어져 있어야 한다
    (일부만 코드처럼 보이는 글 — 예: 사람 이름 — 은 통째로 버린다)."""
    text = "".join(p for p, _ in pieces)
    if SLASH_ONLY.match(text) or text in RESOLVE_3:
        return [(text, [c for _, c in pieces])]
    groups, prev = [], ""
    for p_, c in pieces:
        if p_ in tuple("ABCDEFG") and not prev.endswith("/"):
            groups.append(["", []])
        if not groups:
            return []                                  # 음이름으로 시작하지 않는다
        groups[-1][0] += p_
        groups[-1][1].append(c)
        prev += p_
    if not all(CHORD_RE.match(name) for name, _ in groups):
        return []
    return [(name, cs) for name, cs in groups]


def find_chords(chars, sysm):
    """코드 기호 → [(가운데 x, 코드 이름)].
    이름이 '/F'나 '-3'인 것은 앞 코드에 기대는 표기라서 reader가 앞 코드와 합쳐 완성한다."""
    sp = sysm.sp
    top = sysm.top
    out = []

    def emit(pieces):
        for name, cs in _split_token(pieces):
            for c in cs:
                c.used = "chord"
            out.append(((cs[0].x0 + cs[-1].x1) / 2, name))

    # 코드 전용 글꼴(Sibelius)이 있으면 그 글자들만 이어 붙인다
    special = sorted([c for c in chars if chord_map(c.font) is not None and not c.used
                      and top - 12 * sp < c.oy < sysm.bottom and c.x0 >= sysm.x0 - 1], key=lambda c: (round(c.oy), c.x0))
    if special:
        cur = []
        for c in special:
            if cur and (abs(c.oy - cur[-1][1].oy) >= 3.0 or c.x0 - cur[-1][1].x1 >= 2.6):
                emit(cur)
                cur = []
            cur.append((chord_map(c.font).get(c.t, c.t), c))
        if cur:
            emit(cur)
        return sorted(out)
    cand = []
    for c in chars:
        if c.used or not (top - 10 * sp < c.oy < top - 0.5 * sp) or c.x0 < sysm.x0 - 1:
            continue
        if is_music_font(c.font):
            if c.t in "#b" and c.size < sysm.sp * 4 * 0.75:
                cand.append(c)
        elif "Bold" not in c.font and "Italic" not in c.font and c.t.isascii() and (c.t.isalnum() or c.t in "()/+-#"):
            cand.append(c)
    # 코드 글꼴 = 이 줄에서 음이름 대문자(A~G)에 가장 많이 쓰인 글꼴. 쪽 머리글 같은 다른 글자를 걸러낸다.
    fonts = {}
    for c in cand:
        if not is_music_font(c.font) and c.t in "ABCDEFG":
            fonts[c.font] = fonts.get(c.font, 0) + 1
    if not fonts:
        return []
    chord_font = max(fonts, key=fonts.get)
    cand = [c for c in cand if is_music_font(c.font) or c.font == chord_font]
    cand.sort(key=lambda c: c.oy)
    rows = []
    for c in cand:
        cy = c.oy                      # 글자 밑선 기준 (샵·플랫은 조금 올려 찍혀 있다)
        if rows and abs(cy - rows[-1][0]) < 3.0:
            rows[-1][1].append(c)
            rows[-1][0] = cy
        else:
            rows.append([cy, [c]])
    for _, cs in rows:
        cs.sort(key=lambda c: c.x0)
        cur, x1 = [], None
        for c in cs:
            if cur and c.x0 - x1 >= 2.6:
                emit(cur)
                cur = []
            cur.append((c.t, c))
            x1 = c.x1 if not cur[:-1] else max(x1, c.x1)
        if cur:
            emit(cur)
    out.sort()
    return out


# ------------------------------------------------------------------ 가사
def _match_words(words, notes, sp):
    """로마자 가사 한 줄: 단어와 음표를 왼쪽부터 순서대로, 한 음에 한 단어씩 짝짓는다.
    단어는 음표 가운데에 맞춰 찍히거나(보통), 음표 왼쪽 끝에 맞춰 찍힌다(여러 음에 걸친 음절).
    words: [(가운데 x, 왼쪽 x, 글자, 글자들)] → [(단어 번호, 음표 번호)]"""
    k, m = len(words), len(notes)
    skip, limit, inf = 4.0 * sp, 2.6 * sp, float("inf")

    def cost(i, j):
        return min(abs(notes[j].cx - words[i][0]), abs(notes[j].x - words[i][1]) + 0.4 * sp)
    dp = [[i * skip] + [inf] * m for i in range(k + 1)]
    for j in range(m + 1):
        dp[0][j] = 0.0
    for i in range(1, k + 1):
        for j in range(1, m + 1):
            c = cost(i - 1, j - 1)
            dp[i][j] = min(dp[i][j - 1], dp[i - 1][j] + skip, dp[i - 1][j - 1] + c if c <= limit else inf)
    pairs, i, j = [], k, m
    while i > 0 and j > 0:
        c = cost(i - 1, j - 1)
        if c <= limit and dp[i][j] == dp[i - 1][j - 1] + c:
            pairs.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif dp[i][j] == dp[i][j - 1]:
            j -= 1
        else:
            i -= 1
    return pairs[::-1]


def assign_lyrics(chars, sysm, events, rects):
    """노래 오선 아래 글자를 가로 위치가 맞는 음표에 붙인다."""
    for i, st in enumerate(sysm.staves):
        if st.role != "vocal":
            continue
        sp = st.sp
        nxt = sysm.staves[i + 1] if i + 1 < len(sysm.staves) else None
        lo = st.bottom + 0.8 * sp
        hi = (nxt.top - 0.3 * sp) if nxt else st.bottom + 9 * sp
        notes = sorted([e for e in events if e.staff is st and e.kind == "note"], key=lambda e: e.x)
        if not notes:
            continue
        boxed = [r for r in rects if r.stroke]
        cs = [c for c in chars if not c.used and not is_music_font(c.font) and lo < c.oy < hi
              and st.x0 - sp <= c.cx <= st.x1 + sp and "Italic" not in c.font and "Bold" not in c.font
              and not any(r.x0 - 1 <= c.x0 and c.x1 <= r.x1 + 1 and r.top - 1 <= c.top and c.bottom <= r.bottom + 1
                          for r in boxed)]
        rows, seen = {}, set()
        for c in cs:
            k = (round(c.x0), round(c.oy), c.t)
            if k in seen:
                c.used = "lyric-dup"
                continue
            seen.add(k)
            rows.setdefault(round(c.oy), []).append(c)
        for y in sorted(rows):
            row = sorted(rows[y], key=lambda c: c.x0)
            # 한글은 한 글자씩, 로마자는 붙은 글자끼리 한 덩어리
            toks = []
            for c in row:
                if toks and not is_hangul(c.t) and not is_hangul(toks[-1][-1].t) and c.x0 - toks[-1][-1].x1 < 0.2 * c.size:
                    toks[-1].append(c)
                else:
                    toks.append([c])
            toks = [tk for tk in toks if any(ch.isalnum() for c in tk for ch in c.t)]
            if len(toks) >= 3:
                # 2절 이하: 이 줄 글자의 절반 이상이, 윗줄에서 이미 가사를 받은 음 아래에 있다.
                # 그런 줄은 통째로 쓰지 않는다 (1절에 음절이 없는 음에 2절 글자가 섞여 들어가면 안 된다)
                taken = 0
                for tk in toks:
                    cx = (tk[0].x0 + tk[-1].x1) / 2
                    e = min(notes, key=lambda e: abs(e.cx - cx))
                    if abs(e.cx - cx) <= 1.7 * sp and getattr(e, "lyric_row", y) != y:
                        taken += 1
                if taken * 2 >= len(toks):
                    for tk in toks:
                        for c in tk:
                            c.used = "lyric2"
                    continue
            if toks and not any(is_hangul(c.t) for tk in toks for c in tk):
                # 로마자 줄: 순서대로 한 음에 한 단어씩. (가까운 음에 무조건 붙이면 긴 단어가 옆 음과 뭉치거나 빠진다)
                free = [e for e in notes if getattr(e, "lyric_row", y) == y]
                words = [((tk[0].x0 + tk[-1].x1) / 2, tk[0].x0, "".join(c.t for c in tk), tk) for tk in toks]
                done = set()
                for wi, ni in _match_words(words, free, sp):
                    e = free[ni]
                    e.lyric_row = y
                    e.lyric += words[wi][2]
                    done.add(wi)
                    for c in words[wi][3]:
                        c.used = "lyric"
                toks = [w[3] for wi, w in enumerate(words) if wi not in done]      # 짝을 못 찾은 단어는 아래의 예전 규칙으로
            for tk in toks:
                text = "".join(c.t for c in tk)
                cx = (tk[0].x0 + tk[-1].x1) / 2
                e = min(notes, key=lambda e: abs(e.cx - cx))
                if abs(e.cx - cx) > 1.7 * sp:
                    continue
                if getattr(e, "lyric_row", y) != y:
                    continue                      # 2절 이하는 지금은 쓰지 않는다
                e.lyric_row = y
                e.lyric += text
                for c in tk:
                    c.used = "lyric"


# ------------------------------------------------------------------ 페르마타
def assign_fermatas(chars, sysm, events):
    """페르마타는 그것이 그려진 오선의 음(또는 쉼표)에만 붙는다.
    (피아노 줄의 페르마타가 같은 세로줄의 노래 음까지 늘이면 안 된다)"""
    sp = sysm.sp
    for c in chars:
        mm = music_map(c.font)
        if not mm or c.t not in mm["fermata"] or c.used:
            continue
        cx = c.cx
        staff = min(sysm.staves, key=lambda s: 0 if s.top <= c.oy <= s.bottom else min(abs(c.oy - s.top), abs(c.oy - s.bottom)))
        cand = [e for e in events if e.kind != "grace" and e.staff is staff and abs(e.cx - cx) < 2.0 * sp]
        if not cand:
            continue
        min(cand, key=lambda e: abs(e.cx - cx)).fermata = True
        c.used = "fermata"
