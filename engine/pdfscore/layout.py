"""뼈대 찾기: 오선 → 시스템(같이 연주되는 오선 묶음) → 노래/피아노 구분 → 마디선.

Audiveris 같은 프로그램의 아이디어(마디선으로 시스템 묶기, 피아노 기준으로 마디 맞추기)만 참고했고
코드는 새로 작성했다. 이미지가 아니라 PDF의 선 좌표를 그대로 쓰기 때문에 추측이 거의 없다.
"""
from collections import defaultdict
from dataclasses import dataclass, field

from .glyphs import music_map


@dataclass
class Staff:
    lines: list
    x0: float
    x1: float
    sp: float                   # 줄 간격
    idx: int = -1               # 쪽 안에서 위에서부터 번호
    role: str = "vocal"         # vocal | piano
    partial: bool = False       # 시스템 중간에서 시작하거나 끝나는 짧은 오선

    @property
    def top(self):
        return self.lines[0]

    @property
    def bottom(self):
        return self.lines[4]

    @property
    def gsize(self):            # 이 오선에 맞는 음악 글꼴 크기
        return self.sp * 4

    def pos(self, y):
        """높이 y → 오선 위치. 맨 아래 줄 = 0, 그 위 칸 = 1, 둘째 줄 = 2 ..."""
        return (self.bottom - y) / (self.sp / 2)


@dataclass
class BarGroup:
    x0: float
    x1: float
    thick: bool = False
    n: int = 1
    staves: set = field(default_factory=set)
    rep_start: bool = False     # 오른쪽에 점 → 여기서부터 반복 시작
    rep_end: bool = False       # 왼쪽에 점 → 여기서 되돌아감


@dataclass
class System:
    staves: list
    idx: int = -1
    bars: list = field(default_factory=list)
    regions: list = field(default_factory=list)   # [(x0, x1, 왼쪽 BarGroup|None, 오른쪽 BarGroup|None)]

    @property
    def x0(self):
        return min(s.x0 for s in self.staves)

    @property
    def x1(self):
        return max(s.x1 for s in self.staves)

    @property
    def top(self):
        return self.staves[0].top

    @property
    def bottom(self):
        return self.staves[-1].bottom

    @property
    def sp(self):
        return self.staves[-1].sp

    @property
    def vocal(self):
        return [s for s in self.staves if s.role == "vocal"]

    @property
    def piano(self):
        return [s for s in self.staves if s.role == "piano"]


def find_staves(pr):
    """같은 길이의 가로선 5개가 같은 간격으로 놓여 있으면 오선."""
    # 같은 높이에서 끝이 맞닿은 선 조각은 한 줄로 잇는다
    rows = defaultdict(list)
    for l in pr.hlines:
        if l.x1 - l.x0 >= 20:                 # 덧줄 같은 짧은 선은 잇지 않는다 (오선 길이가 달라져 버린다)
            rows[round(l.y, 1)].append(l)
    merged = []
    for y, ls in rows.items():
        ls.sort(key=lambda l: l.x0)
        cur = None
        for l in ls:
            if cur and l.x0 <= cur[1] + 0.8:
                cur[1] = max(cur[1], l.x1)
                cur[3] += 1
            else:
                cur = [l.x0, l.x1, l, 1]
                merged.append((y, cur))
    lines = []
    for y, (x0, x1, l, n) in merged:
        lines.append(type(l)(y=l.y, x0=x0, x1=x1, lw=l.lw) if n > 1 else l)
    groups = defaultdict(list)
    for l in lines:
        if l.x1 - l.x0 < 40:
            continue
        groups[(round(l.x0), round(l.x1))].append(l)
    staves = []
    for ls in groups.values():
        ys = sorted({round(l.y, 2) for l in ls})
        i = 0
        while i + 4 < len(ys):
            gaps = [ys[i + k + 1] - ys[i + k] for k in range(4)]
            if 2.0 < gaps[0] < 9.0 and max(gaps) - min(gaps) < 0.25:
                staves.append(Staff(lines=ys[i:i + 5], x0=min(l.x0 for l in ls), x1=max(l.x1 for l in ls),
                                    sp=(ys[i + 4] - ys[i]) / 4))
                i += 5
            else:
                i += 1
    staves.sort(key=lambda s: (s.top, s.x0))
    for i, s in enumerate(staves):
        s.idx = i
    return staves


def _brace_spans(pr, staves):
    """피아노 두 오선을 묶는 중괄호의 세로 범위. Finale는 위아래 반쪽씩 두 조각으로 그린다."""
    if not staves:
        return []
    sp = staves[0].sp
    parts = [c for c in pr.curves if c.fill and (len(c.pts) == 4 or len(c.pts) >= 12) and c.x1 - c.x0 < 2.5 * sp
             and c.bottom - c.top > 3 * sp]
    parts.sort(key=lambda c: c.top)
    spans = []
    for c in parts:
        if spans and c.top - spans[-1][1] < 1.0 and abs(c.x0 - spans[-1][2]) < 2.0:
            spans[-1][1] = c.bottom
        else:
            spans.append([c.top, c.bottom, c.x0, c.x1])
    for ch in pr.chars:                       # 중괄호 글자: 기준점이 아래 끝, 글자 크기가 높이
        mm = music_map(ch.font)
        if mm and mm["brace"] == ch.t and ch.size > 6 * sp:
            spans.append([ch.oy - ch.size, ch.oy, ch.x0, ch.x1])
    return spans


def group_systems(pr, staves):
    """왼쪽 끝 세로선이나 관통하는 마디선으로 이어진 오선들이 한 시스템."""
    parent = list(range(len(staves)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        parent[find(a)] = find(b)

    # 왼쪽 끝 세로선을 오선마다 끊어서 그리는 프로그램(MuseScore 3·4)이 있다 → 끝이 맞닿은 조각은 한 줄로 이어서 본다
    sp = staves[0].sp if staves else 5.0
    spans = []
    for v in sorted([v for v in pr.vlines if v.bottom - v.top > 3 * sp], key=lambda v: (round(v.x, 1), v.top)):
        if spans and abs(spans[-1][0] - v.x) < 0.15 and v.top <= spans[-1][2] + 0.8:
            spans[-1][2] = max(spans[-1][2], v.bottom)
        else:
            spans.append([v.x, v.top, v.bottom])
    for x, top, bottom in spans:
        inside = [s for s in staves if s.top >= top - 0.5 and s.bottom <= bottom + 0.5
                  and s.x0 - 1.5 <= x <= s.x1 + 1.5]
        for a in inside[1:]:
            union(inside[0].idx, a.idx)
    braces = _brace_spans(pr, staves)
    for top, bottom, bx0, bx1 in braces:
        inside = [s for s in staves if s.top >= top - 1.0 and s.bottom <= bottom + 1.0 and s.x0 >= bx0 - 1]
        for a in inside:
            a.role = "piano"
        for a in inside[1:]:
            union(inside[0].idx, a.idx)
    groups = defaultdict(list)
    for s in staves:
        groups[find(s.idx)].append(s)
    glist = sorted(groups.values(), key=lambda g: g[0].top)
    # 혼자 떨어진 짧은 오선(중간부터 시작하는 노래 줄)은 바로 아래 시스템에 붙인다
    merged = []
    i = 0
    while i < len(glist):
        g = glist[i]
        if len(g) == 1 and i + 1 < len(glist):
            s, nxt = g[0], glist[i + 1]
            full = max(t.x1 - t.x0 for t in nxt)
            if (s.x1 - s.x0) < full * 0.9 and nxt[0].top - s.bottom < 14 * s.sp:
                glist[i + 1] = g + nxt
                i += 1
                continue
        merged.append(g)
        i += 1
    systems = []
    for g in merged:
        g.sort(key=lambda s: s.top)
        sysm = System(staves=g, idx=len(systems))
        if not sysm.piano and len(g) >= 2:
            for s in g[-2:]:            # 중괄호를 못 찾았으면 맨 아래 두 줄을 피아노로 본다
                s.role = "piano"
        for s in g:
            s.partial = s.x0 > sysm.x0 + 2 * s.sp or s.x1 < sysm.x1 - 2 * s.sp
        systems.append(sysm)
    return systems


def find_barlines(pr, sysm, heads, dot_chars):
    """오선의 맨 위 줄에서 맨 아래 줄까지 정확히 이어지는 세로선 = 마디선.
    기둥은 한쪽 끝이 음표 머리에 붙어 있어서 줄 위치와 정확히 맞지 않는다."""
    sp = sysm.sp
    tol = 0.35
    segs = []
    for v in pr.vlines:
        if v.x <= sysm.x0 + 0.5 * sp or v.x > sysm.x1 + 1.0:
            continue
        tops = [s for s in sysm.staves if abs(s.top - v.top) < tol]
        bots = [s for s in sysm.staves if abs(s.bottom - v.bottom) < tol]
        if not tops or not bots or bots[0].idx < tops[0].idx:
            continue
        a, b = tops[0], bots[0]
        if a.idx == b.idx:
            # 한 오선짜리: 바로 옆에 음표 머리가 붙어 있으면 기둥이므로 뺀다
            if any(abs(h.oy - v.top) < sp or abs(h.oy - v.bottom) < sp for h in heads
                   if h.x0 - 0.6 <= v.x <= h.x1 + 0.6 and a.top - sp <= h.oy <= a.bottom + sp):
                continue
        covered = {s.idx for s in sysm.staves if a.idx <= s.idx <= b.idx}
        segs.append((v.x, v.lw, covered, v))
    if not segs:
        sysm.bars = []
        return
    lws = sorted(lw for _, lw, _, _ in segs)
    base = lws[len(lws) // 2] or 1.0
    segs.sort(key=lambda t: t[0])
    bars = []
    for x, lw, covered, v in segs:
        v.used = "bar"
        if bars and x - bars[-1].x1 < 1.2 * sp:
            g = bars[-1]
            if x - g.x1 > 0.2:
                g.n += 1
            g.x1 = max(g.x1, x)
        else:
            g = BarGroup(x0=x, x1=x)
            bars.append(g)
        g.thick = g.thick or lw > base * 2.5
        g.staves |= covered
    # 도돌이표 점: 오선 둘째·셋째 칸에 세로로 나란한 점 두 개가 마디선 바로 옆에 있다
    for g in bars:
        for side in (-1, 1):
            near = []
            for d in dot_chars:
                dx = (g.x0 - d.ox) if side < 0 else (d.ox - g.x1)
                if not (0 < dx < 1.8 * sp):
                    continue
                for s in sysm.staves:
                    p = s.pos(d.oy)
                    if abs(p - 3) < 0.35 or abs(p - 5) < 0.35:
                        near.append(d)
                        break
            if len(near) >= 2:
                for d in near:
                    d.used = "repeat"
                if side < 0:
                    g.rep_end = True
                else:
                    g.rep_start = True
    sysm.bars = bars
    cuts = [(sysm.x0, sysm.x0, None)] + [(g.x0, g.x1, g) for g in bars]
    regions = []
    for i in range(len(cuts) - 1):
        regions.append((cuts[i][1], cuts[i + 1][0], cuts[i][2], cuts[i + 1][2]))
    if cuts[-1][1] < sysm.x1 - 1.5 * sp:
        regions.append((cuts[-1][1], sysm.x1 + 2 * sp, cuts[-1][2], None))
    sysm.regions = regions
