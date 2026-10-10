"""음표 읽기: 머리 → 기둥 → 빔·꼬리 → 길이, 점, 쉼표, 음자리표·조표·임시표 → 음높이, 박 위치."""
from dataclasses import dataclass, field
from fractions import Fraction as F

from .glyphs import music_map

STEPS = ["C", "D", "E", "F", "G", "A", "B"]
STEP_SEMI = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
CLEF_BASE = {"G": ("E", 4), "F": ("G", 2), "C": ("F", 3), "G8": ("E", 3)}   # 맨 아래 줄의 음
CLEF_SHIFT = {"G": 0, "F": -2, "C": -1, "G8": 0}                             # 조표 위치 이동
SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"]
FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"]
SHARP_POS = [8, 5, 9, 6, 3, 7, 4]       # 높은음자리표에서 조표 샵이 놓이는 위치 (맨 아래 줄 = 0)
FLAT_POS = [4, 7, 3, 6, 2, 5, 1]


@dataclass
class Head:
    ch: object
    kind: str                   # black | half | whole
    staff: object
    x0: float
    x1: float
    y: float
    pos: int
    grace: bool = False
    acc: object = None          # 악보에 직접 붙은 임시표 (없으면 None)
    dots: int = 0
    step: str = ""
    octave: int = 0
    alter: int = 0
    tie_out: bool = False       # 다음 같은 음으로 붙임줄
    tie_in: bool = False
    open_out: bool = False      # 줄 끝에서 다음 줄로 넘어가는 붙임줄
    open_in: bool = False
    stemmed: bool = False

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2

    @property
    def midi(self):
        return 12 * (self.octave + 1) + STEP_SEMI[self.step] + self.alter


@dataclass
class Event:
    kind: str                   # note | rest | grace
    staff: object
    x: float
    y: float
    w: float
    heads: list = field(default_factory=list)
    stem: object = None         # {"x", "top", "bottom", "up"}
    base: F = F(1)
    dots: int = 0
    tuplet: object = None       # (몇 잇단, 곱하는 비율)
    measure_rest: bool = False
    voice: int = 1
    beat: object = None
    lyric: str = ""
    fermata: bool = False
    slur: str = ""              # start | mid | end
    region: int = -1
    ch: object = None
    flags: int = 0
    beams: int = 0
    warn: str = ""
    trem: object = None         # 트레몰로의 둘째 음이면 짝이 되는 첫째 음

    @property
    def cx(self):
        return self.x + self.w / 2

    @property
    def dur(self):
        d = self.base
        if self.dots == 1:
            d = d * F(3, 2)
        elif self.dots >= 2:
            d = d * F(7, 4)
        if self.tuplet:
            d = d * self.tuplet[1]
        return d

    @property
    def ytop(self):
        ys = [h.y for h in self.heads] or [self.y]
        return min(ys + ([self.stem["top"]] if self.stem else []))

    @property
    def ybottom(self):
        ys = [h.y for h in self.heads] or [self.y]
        return max(ys + ([self.stem["bottom"]] if self.stem else []))


@dataclass
class Beam:
    x0: float
    x1: float
    yl: float                   # 왼쪽 끝 가운데 높이
    yr: float
    thick: float
    curve: object = None

    def y_at(self, x):
        if self.x1 - self.x0 < 1e-6:
            return self.yl
        t = min(1.0, max(0.0, (x - self.x0) / (self.x1 - self.x0)))
        return self.yl + (self.yr - self.yl) * t


def staff_for(sysm, x, y, snap=True):
    """기호가 어느 오선에 속하는지. 덧줄 음표는 그 오선의 줄·칸 격자에 맞는 쪽을 고른다."""
    best = None
    for s in sysm.staves:
        if not (s.x0 - 3 * s.sp <= x <= s.x1 + 3 * s.sp):
            continue
        d = 0.0 if s.top <= y <= s.bottom else min(abs(y - s.top), abs(y - s.bottom))
        p = s.pos(y)
        off = abs(p - round(p))
        key = (0 if (not snap or off < 0.2) else 1, d)
        if best is None or key < best[0]:
            best = (key, s)
    return best[1] if best else None


def find_beams(curves, sp, rects=()):
    """빔 = 속이 찬 납작한 평행사변형. 수평 빔은 사각형으로 들어 있기도 하다."""
    beams = []
    for r in rects:
        thick = r.bottom - r.top
        if r.fill and 0.25 * sp <= thick <= 0.85 * sp and r.x1 - r.x0 >= 0.4 * sp:
            mid = (r.top + r.bottom) / 2
            beams.append(Beam(x0=r.x0, x1=r.x1, yl=mid, yr=mid, thick=thick))
    for c in curves:
        if not c.fill or c.used:
            continue
        pts = list(c.pts)
        if len(pts) == 5 and abs(pts[0][0] - pts[4][0]) < 0.01 and abs(pts[0][1] - pts[4][1]) < 0.01:
            pts = pts[:4]                                  # 닫힌 사각형 (처음 점 = 끝 점)
        if len(pts) != 4 or any(s[0] == "c" for s in c.path):
            continue
        xs = sorted(p[0] for p in pts)
        if xs[3] - xs[0] < 0.4 * sp:
            continue
        left = sorted([p for p in pts if p[0] <= xs[1] + 1e-6], key=lambda p: p[1])[:2]
        right = sorted([p for p in pts if p[0] >= xs[2] - 1e-6], key=lambda p: p[1])[-2:]
        if len(left) < 2 or len(right) < 2:
            continue
        thick = abs(left[1][1] - left[0][1])
        if not (0.25 * sp <= thick <= 0.85 * sp):
            continue
        beams.append(Beam(x0=xs[0], x1=xs[3], yl=(left[0][1] + left[1][1]) / 2,
                          yr=(right[0][1] + right[1][1]) / 2, thick=thick, curve=c))
    return beams


def build_heads(pr, systems, zones):
    """쪽 전체의 음표 머리를 찾아 어느 오선 것인지 정한다.
    오선 밖의 음표는 반드시 그 오선에서 뻗어 나온 덧줄을 갖고 있으므로, 덧줄이 있는 쪽이 주인이다."""
    heads = []
    if not systems:
        return heads
    sp0 = systems[0].sp
    ledgers = [l for l in pr.hlines if l.x1 - l.x0 < 3.4 * sp0]
    for ch in pr.chars:
        mm = music_map(ch.font)
        if not mm or ch.t not in mm["heads"] or ch.used:
            continue
        cx = ch.ox + ch.w / 2
        cands = []
        for sysm in systems:
            for s in sysm.staves:
                if not (s.x0 - 3 * s.sp <= ch.ox <= s.x1 + 3 * s.sp):
                    continue
                p = s.pos(ch.oy)
                if -1.3 <= p <= 9.3:
                    cands.append((0, 0.0, s, sysm))
                    continue
                if abs(p - round(p)) > 0.25:
                    continue
                yreq = s.top - s.sp if p > 9 else s.bottom + s.sp
                if any(abs(l.y - yreq) < 0.25 * s.sp and l.x0 - 0.8 <= cx <= l.x1 + 0.8 for l in ledgers):
                    cands.append((1, min(abs(ch.oy - s.top), abs(ch.oy - s.bottom)), s, sysm))
        if cands:
            _, _, st, sysm = min(cands, key=lambda t: (t[0], t[1]))
        else:
            sysm = next((s for s, (lo, hi) in zip(systems, zones) if lo <= ch.oy < hi), None)
            st = staff_for(sysm, ch.ox, ch.oy) if sysm else None
            if st is None:
                continue
        ch.used = "head"
        kind = mm["heads"][ch.t]
        hw = ch.size * mm["head_width"] if mm["head_width"] and kind != "whole" else ch.w
        h = Head(ch=ch, kind=kind, staff=st, x0=ch.ox, x1=ch.ox + hw, y=ch.oy,
                 pos=int(round(st.pos(ch.oy))), grace=ch.size < st.gsize * 0.72)
        h.system = sysm
        heads.append(h)
    return heads


def build_events(pr, sysm, heads, chars, beams):
    """기둥에 붙은 머리들을 하나의 음(화음)으로 묶고, 빔·꼬리 개수로 길이를 정한다."""
    sp = sysm.sp
    tol = 0.3 * sp
    events = []
    flags = [c for c in chars if (music_map(c.font) or {}).get("flags", {}).get(c.t) and not c.used]
    for v in pr.vlines:
        if v.used or v.len < 0.9 * sp:
            continue
        hs = [h for h in heads if v.top - 0.45 * sp <= h.y <= v.bottom + 0.45 * sp
              and (abs(v.x - h.x0) <= tol or abs(v.x - h.x1) <= tol)]
        if not hs:
            continue
        v.used = "stem"
        hs.sort(key=lambda h: h.y)
        mid = (v.top + v.bottom) / 2
        up = sum(h.y for h in hs) / len(hs) > mid          # 머리가 아래쪽에 몰려 있으면 기둥은 위로
        w = hs[0].x1 - hs[0].x0
        ex = v.x - w if up else v.x
        for h in hs:
            h.stemmed = True
        nf = 0
        for f in flags:
            if abs(f.ox - v.x) < 0.3 * sp and v.top - sp <= f.oy <= v.bottom + sp:
                nf = max(nf, music_map(f.font)["flags"][f.t])
                f.used = "flag"
        nb = 0
        for b in beams:
            if b.x0 - 0.4 <= v.x <= b.x1 + 0.4 and v.top - 0.6 * sp <= b.y_at(v.x) <= v.bottom + 0.6 * sp:
                nb += 1
        n = max(nf, nb)
        if any(h.kind == "half" for h in hs):
            base = F(2)
        else:
            base = F(1, 2 ** n)
        staff = hs[-1 if up else 0].staff
        kind = "grace" if all(h.grace for h in hs) else "note"
        events.append(Event(kind=kind, staff=staff, x=ex, y=hs[0].y, w=w, heads=hs,
                            stem={"x": v.x, "top": v.top, "bottom": v.bottom, "up": up},
                            base=base, flags=nf, beams=nb))
    # 기둥 없는 머리: 온음표 (같은 자리에 쌓인 것은 화음)
    loose = sorted([h for h in heads if not h.stemmed], key=lambda h: (h.staff.idx, h.x0, h.y))
    for h in loose:
        w = h.x1 - h.x0
        prev = events[-1] if events else None
        if prev and prev.stem is None and prev.kind != "rest" and prev.staff is h.staff \
                and abs(prev.x - h.x0) < 1.2 * w and prev.heads and prev.heads[0].kind == h.kind:
            prev.heads.append(h)
            continue
        base = {"whole": F(4), "half": F(2), "black": F(1)}[h.kind]
        events.append(Event(kind="grace" if h.grace else "note", staff=h.staff, x=h.x0, y=h.y, w=w, heads=[h],
                            base=base, warn="" if h.kind == "whole" else "기둥 없는 음표"))
    # 쉼표
    for ch in chars:
        mm = music_map(ch.font)
        if not mm or ch.t not in mm["rests"] or ch.used:
            continue
        st = staff_for(sysm, ch.ox, ch.oy, snap=False)
        if st is None or ch.size < st.gsize * 0.6:
            continue
        ch.used = "rest"
        events.append(Event(kind="rest", staff=st, x=ch.ox, y=ch.oy, w=ch.w, base=mm["rests"][ch.t], ch=ch,
                            measure_rest=ch.t == mm["whole_rest"]))
    return events


def assign_dots(chars, sysm, heads, events):
    """머리나 쉼표 바로 오른쪽의 점 = 점음표. (도돌이표 점은 이미 빠져 있다)"""
    sp = sysm.sp
    rests = [e for e in events if e.kind == "rest"]
    dots = sorted([c for c in chars if (music_map(c.font) or {}).get("dot") == c.t and not c.used],
                  key=lambda c: c.ox)
    for d in dots:
        best = None
        for t in list(heads) + rests:
            ty = t.y
            tx1 = t.x1 if isinstance(t, Head) else t.x + t.w
            dx = d.ox - tx1
            if abs(d.oy - ty) > 0.75 * sp:
                continue
            last = getattr(t, "dot_x", None)
            if last is not None and d.ox < last + 0.5 * sp:
                continue                               # 이미 이 자리의 점을 가진 머리 (겹친 두 성부)
            limit = (1.7 if t.dots == 0 else 2.8) * sp
            if -0.35 <= dx <= limit:
                key = (round(dx, 1), round(abs(d.oy - ty), 1), t.dots)
                if best is None or key < best[0]:
                    best = (key, t)
        if best:
            best[1].dots += 1
            best[1].dot_x = d.ox
            d.used = "dot"
    for e in events:
        if e.kind != "rest" and e.heads:
            e.dots = max(h.dots for h in e.heads)


def staff_context(sysm, staff, chars, heads, events, state):
    """한 오선의 음자리표·조표·임시표를 읽어 음높이를 정한다.
    state: 이전 시스템에서 이어받는 값 {"key": 조표, "clef": 음자리표}"""
    sp = staff.sp
    mine = lambda c, snap: staff_for(sysm, c.ox, c.oy, snap=snap) is staff
    clefs = []
    for c in chars:
        mm = music_map(c.font)
        if mm and c.t in mm["clefs"] and not c.used and staff.top - 2 * sp <= c.oy <= staff.bottom + 2 * sp \
                and c.size >= staff.gsize * 0.6 and mine(c, False):
            clefs.append((c.ox, mm["clefs"][c.t], c))
            c.used = "clef"
    clefs.sort(key=lambda t: t[0])
    accs = sorted([c for c in chars if (music_map(c.font) or {}).get("accidentals", {}).get(c.t) is not None
                   and not c.used and c.size >= staff.gsize * 0.72
                   and staff.top - 6 * sp <= c.oy <= staff.bottom + 6 * sp and mine(c, True)],
                  key=lambda c: c.ox)
    val = lambda c: music_map(c.font)["accidentals"][c.t]
    my_heads = sorted([h for h in heads if h.staff is staff], key=lambda h: h.x0)
    my_events = sorted([e for e in events if e.staff is staff], key=lambda e: e.x)

    def clef_at(x):
        cur = state.get("clef", "G")
        for cx, ct, _ in clefs:
            if cx <= x + 0.5:
                cur = ct
        return cur

    def ladder_run(start_x, first_gap, clef, until=None):
        """start_x 뒤에 조표처럼 차례대로 놓인 임시표 묶음 → (조표 값, 쓰인 글자들) 또는 None"""
        shift = CLEF_SHIFT[clef]
        run, last = [], start_x
        for a in accs:
            if a.used or a.ox <= start_x:
                continue
            if until is not None and a.ox >= until:
                break
            if a.ox - last > (first_gap if not run else 1.7 * sp):
                break
            run.append(a)
            last = a.ox
        if not run:
            return None
        naturals = [a for a in run if val(a) == 0]
        rest = [a for a in run if val(a) != 0]
        if any(val(a) == 0 for a in run[len(naturals):]):
            return None                                   # 제자리표는 맨 앞에만 온다
        if rest:
            sign = val(rest[0])
            if abs(sign) != 1 or any(val(a) != sign for a in rest) or len(rest) > 7:
                return None
            table = SHARP_POS if sign > 0 else FLAT_POS
            for i, a in enumerate(rest):
                if abs(staff.pos(a.oy) - (table[i] + shift)) > 0.3:
                    return None
            return sign * len(rest), run
        return 0, run

    def attached(a):
        return any(abs(h.y - a.oy) < 0.3 * sp and 0.3 * sp < h.x0 - a.ox < 2.4 * sp for h in my_heads)

    keys = []                                             # [(x, 조표)] 이 오선 안에서 조표가 바뀌는 지점
    if clefs and clefs[0][0] < staff.x0 + 6 * sp:
        cx, ct, cch = clefs[0]
        got = ladder_run(cx, 5.5 * sp, ct)
        k = got[0] if got else 0
        if got:
            for a in got[1]:
                a.used = "key"
        keys.append((staff.x0 - 1, k))
    else:
        keys.append((staff.x0 - 1, state.get("key", 0)))
    for (rx0, rx1, left, right) in sysm.regions:
        if left is None:
            continue
        first = min([e.x for e in my_events if rx0 < e.x < rx1] + [rx1])
        got = ladder_run(rx0, 3.0 * sp, clef_at(rx0 + sp), until=first - 0.3 * sp if right is not None else None)
        if right is not None:
            # 마디 끝(마지막 음 뒤, 마디선 앞)에 찍힌 조표: 도돌이표 시작 마디선 앞에 조표를 두는 프로그램이 있다(MuseScore).
            # 다음 마디부터 적용한다. 줄 끝의 예고 조표도 여기에 걸리지만 다음 줄에서 다시 읽으므로 결과는 같다.
            lastx = max([e.x + e.w for e in my_events if rx0 < e.x < rx1] + [rx0 + 3.0 * sp])
            tail = ladder_run(lastx, rx1 - lastx, clef_at(rx1 - sp), until=rx1 + 0.2 * sp)
            if tail and not any(attached(a) for a in tail[1]) and not (got and any(a in got[1] for a in tail[1])):
                for a in tail[1]:
                    a.used = "key"
                if got and not (len(got[1]) == 1 and attached(got[1][0])):
                    for a in got[1]:
                        a.used = "key"
                    keys.append((rx0, got[0]))
                keys.append((rx1 - 0.01, tail[0]))
                continue
        if not got:
            continue
        k, run = got
        if right is not None and len(run) == 1 and attached(run[0]):
            continue                                      # 첫 음에 붙은 임시표 하나
        for a in run:
            a.used = "key"
        if right is not None:                             # 줄 끝의 예고 조표는 다음 줄에서 다시 읽는다
            keys.append((rx0, k))

    def key_at(x):
        cur = keys[0][1]
        for kx, k in keys:
            if kx <= x:
                cur = k
        return cur

    # 임시표 → 가장 가까운 오른쪽 머리
    for a in accs:
        if a.used:
            continue
        cand = [h for h in my_heads if abs(h.y - a.oy) < 0.3 * sp and 0 < h.x0 - a.ox < 4.5 * sp]
        if cand:
            h = min(cand, key=lambda h: h.x0 - a.ox)
            if h.acc is None:
                h.acc = val(a)
                a.used = "acc"
    # 음높이
    for (rx0, rx1, left, right) in sysm.regions:
        bar_alter = {}
        for e in my_events:
            if not (rx0 < e.cx <= rx1) or e.kind == "rest":
                continue
            clef = clef_at(e.x)
            k = key_at(e.x)
            key_alter = {s: 1 for s in SHARP_ORDER[:max(0, k)]}
            key_alter.update({s: -1 for s in FLAT_ORDER[:max(0, -k)]})
            b_step, b_oct = CLEF_BASE[clef]
            for h in sorted(e.heads, key=lambda h: h.x0):
                idx = STEPS.index(b_step) + b_oct * 7 + h.pos
                h.step, h.octave = STEPS[idx % 7], idx // 7
                if h.acc is not None and not h.grace:
                    bar_alter[(h.step, h.octave)] = h.acc
                tf = getattr(h, "tie_from", None)
                if h.acc is None and tf is not None and tf.step == h.step and tf.octave == h.octave:
                    h.alter = tf.alter          # 붙임줄로 이어진 음은 앞 음의 임시표를 그대로 따른다
                    continue
                h.alter = h.acc if h.acc is not None else bar_alter.get((h.step, h.octave), key_alter.get(h.step, 0))
    state["key"] = keys[-1][1]
    state["clef"] = clef_at(staff.x1)
    return key_at, clef_at


def find_tremolos(events, beams, sp):
    """트레몰로 = 길이가 같은 두 음(2분음표 이상) 사이에, 어느 기둥에도 닿지 않고 떠 있는 굵은 막대.
    두 음은 각각 전체 길이로 적혀 있어서 그대로 더하면 박자 합이 두 배가 된다. 둘째 음에 짝을 적어 둔다."""
    by_staff = {}
    for e in events:
        if e.kind == "note":
            by_staff.setdefault(id(e.staff), []).append(e)
    found = 0
    for evs in by_staff.values():
        evs.sort(key=lambda e: e.x)
        for a, b in zip(evs, evs[1:]):
            if a.trem is not None or a.base != b.base or a.dots != b.dots or a.base < 2 or a.region != b.region:
                continue
            if not (2 * sp < b.x - a.x < 14 * sp):
                continue
            ys = [h.y for h in a.heads + b.heads]
            mid = (a.x + a.w + b.x) / 2
            bars = [bm for bm in beams if a.x + a.w - 0.3 * sp <= bm.x0 and bm.x1 <= b.x + 0.3 * sp
                    and min(ys) - 2 * sp <= bm.y_at(mid) <= max(ys) + 2 * sp]
            if bars:
                b.trem = a
                found += 1
    return found


def time_events(evs, length):
    """한 마디 안에서 각 음이 몇 번째 박에 시작하는지 정한다.
    같은 자리에 겹쳐 적힌 음(두 성부)은 같이 시작하고, 다음 음은 먼저 끝나는 쪽 뒤에 이어진다.
    그대로 세어서 박자 합이 안 맞으면, 두 성부로 적힌 마디에서 생기는 두 가지 경우를 차례로 다시 세어 본다
    (다시 세어서 합이 맞을 때만 받아들인다):
    ① 한 성부가 마디 전체를 쉬는 온쉼표가 다른 성부의 음표와 같이 있다 → 쉼표는 마디 처음부터 따로 센다
    ② 두 성부가 머리 하나를 같이 쓰는데 점이 하나뿐이다 → 점은 한쪽 성부의 것이다"""
    evs = sorted([e for e in evs if e.kind != "grace"], key=lambda e: e.x)
    if not evs:
        return True, F(0)
    ok, total = _time_run(evs, length)
    if ok:
        return ok, total
    whole = [e for e in evs if e.measure_rest]
    others = [e for e in evs if not e.measure_rest]
    if whole and others:
        ok2, total2 = _time_run(others, length)
        if ok2:
            for e in whole:
                e.base, e.dots, e.beat, e.voice = length, 0, F(0), 2
            return True, total2
    sp = evs[0].staff.sp
    for i, a in enumerate(evs):
        if a.kind != "note" or not a.stem or not a.dots:
            continue
        for b in evs[i + 1:]:
            if b.x - a.x > 1.5 * sp:
                break
            if b.kind != "note" or not b.stem or not b.dots or a.stem["up"] == b.stem["up"]:
                continue
            if not any(abs(ha.y - hb.y) < 0.1 * sp and abs(ha.x0 - hb.x0) < 0.6 * sp for ha in a.heads for hb in b.heads):
                continue
            for e in sorted((a, b), key=lambda e: e.stem["up"]):          # 아래 성부(기둥 아래) 쪽의 점부터 빼 본다
                keep, e.dots = e.dots, 0
                ok2, total2 = _time_run(evs, length)
                if ok2:
                    return True, total2
                e.dots = keep
    return _time_run(evs, length)


def _time_run(evs, length):
    for e in evs:
        if e.measure_rest:
            e.base = length
            e.dots = 0
    sp = evs[0].staff.sp
    cols = []
    for e in evs:
        if cols and e.trem is not None and any(p is e.trem for p in cols[-1]):
            cols[-1].append(e)                              # 트레몰로의 둘째 음은 첫째 음과 함께 시작한다
            continue
        if cols:
            p = cols[-1][0]
            opp = bool(e.stem and p.stem and e.stem["up"] != p.stem["up"])
            if abs(e.x - p.x) < (1.45 if opp else 0.6) * sp:
                cols[-1].append(e)
                continue
        cols.append([e])

    def run(pick):
        t, ends = F(0), []
        for col in cols:
            if ends:
                t = pick(ends)
            ends = [x for x in ends if x > t]
            for i, e in enumerate(sorted(col, key=lambda e: (e.stem is not None and not e.stem["up"], e.y))):
                e.beat = t
                e.voice = i + 1
                ends.append(t + e.dur)
        return max(ends)

    total = run(min)
    if total != length and any(len(c) > 1 for c in cols):
        alt = run(max)
        if alt == length:
            return True, alt
        total = run(min)
    return total == length, total
