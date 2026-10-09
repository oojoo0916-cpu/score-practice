"""사보 프로그램에서 뽑은 PDF를 이미지 인식 없이 바로 읽는다.

쪽마다: 뼈대(layout) → 음표(notes) → 나머지 표시(marks) → 마디 목록.
결과는 Score 객체. 내보내기는 export.py.
"""
import re
import time
from dataclasses import dataclass, field
from fractions import Fraction as F

from . import layout, marks, notes, prims
from .glyphs import music_map, is_music_font, learn_fonts, family


@dataclass
class StaffData:
    staff: object
    role: str
    line: int                   # 같은 역할(노래/피아노) 안에서 위에서 몇 번째 줄
    events: list
    ok: bool = True
    total: F = F(0)
    key: int = 0
    absent: bool = False
    approx: bool = False        # 박자 합이 안 맞아서 가로 위치로 박을 어림한 마디
    joint: bool = False         # 피아노 두 오선을 함께 세어서 박을 정한 마디


@dataclass
class Measure:
    n: int
    page: int
    system: int
    x0: float
    x1: float
    y0: float
    y1: float
    meter: tuple
    length: F
    bpm: object = None
    rep_start: bool = False
    rep_end: bool = False
    ending: object = None
    final: bool = False
    double: bool = False
    chords: list = field(default_factory=list)      # [{"name", "beat", "x"}]
    marks: list = field(default_factory=list)       # [{"type", "text", "beat", "x", "y"}]
    labels: list = field(default_factory=list)      # [{"name", "line"}]
    staves: list = field(default_factory=list)
    align: list = field(default_factory=list)       # 세로 정렬 검사에서 어긋난 곳
    checks: list = field(default_factory=list)      # 기호 사용 검사에서 걸린 것 [(역할, 설명)]
    printed: object = None                          # 악보에 인쇄된 마디 번호
    first_in_system: bool = False
    last_in_system: bool = False
    pickup: bool = False

    @property
    def vocal(self):
        return [s for s in self.staves if s.role == "vocal"]

    @property
    def ok(self):
        return all(s.ok for s in self.vocal) and not self.align and not any(r == "vocal" for r, _ in self.checks)


@dataclass
class Score:
    pages: list = field(default_factory=list)
    measures: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    seconds: float = 0.0
    fonts: set = field(default_factory=set)
    all_music_fonts: set = field(default_factory=set)
    image_pages: int = 0

    def program(self):
        """어떤 사보 프로그램의 악보로 읽었는지 (음악 글꼴로 판단)."""
        fams = {family(f) for f in self.all_music_fonts}
        if any(f.startswith("Maestro") for f in fams):
            return "Finale"
        if any(f.startswith("Opus") for f in fams):
            return "Sibelius"
        if "MScore" in fams or any(f.lower().startswith(("leland", "emmentaler", "musejazz", "gootville")) for f in fams):
            return "MuseScore"
        if any(f.lower().startswith("bravura") for f in fams):
            return "표준 글꼴 Bravura (Dorico·MuseScore 등)"
        if fams:
            return "그 밖의 사보 프로그램"
        return ""

    def kind(self):
        """이 PDF가 어떤 종류인지: ok | scan(그림뿐) | font(아직 못 읽는 사보 프로그램) | none"""
        if self.measures:
            return "ok"
        if self.all_music_fonts:
            return "font"
        if self.image_pages:
            return "scan"
        return "none"


MARK_PATTERNS = [
    ("rit", re.compile(r"\b(rit|rall|riten)", re.I)),
    ("accel", re.compile(r"\b(accel|string)", re.I)),
    ("a_tempo", re.compile(r"\ba\s*tempo|tempo\s*primo|tempo\s*I\b", re.I)),
    ("rubato", re.compile(r"rubato", re.I)),
    ("nav", re.compile(r"\bfine\b|D\.\s*S|D\.\s*C|coda|segno|vamp|\bx\s*\d|\d\s*x\b|N\.C", re.I)),
]


def _zones(systems):
    z = []
    for i, s in enumerate(systems):
        lo = s.top - 14 * s.sp if i == 0 else systems[i - 1].bottom + 0.4 * (s.top - systems[i - 1].bottom)
        hi = s.bottom + 12 * s.sp if i == len(systems) - 1 else s.bottom + 0.4 * (systems[i + 1].top - s.bottom)
        z.append((lo, hi))
    return z


def _beat_at(m, cx, sp):
    """가로 위치 → 마디 안의 박. 같은 자리에 음표가 있으면 그 박, 없으면 앞뒤 음표 사이를 나눠서 반 박 단위로."""
    anchors = sorted({(round(e.cx, 1), e.beat) for sd in m.staves if sd.ok for e in sd.events if e.beat is not None})
    if not anchors:
        frac = min(1.0, max(0.0, (cx - m.x0) / max(1.0, m.x1 - m.x0)))
        return F(round(float(m.length) * frac * 2), 2)
    near = min(anchors, key=lambda a: abs(a[0] - cx))
    if abs(near[0] - cx) <= 1.4 * sp:
        return near[1]
    pts = anchors + [(m.x1, m.length)]
    if cx <= pts[0][0]:
        return pts[0][1]
    for (xa, ba), (xb, bb) in zip(pts, pts[1:]):
        if xa <= cx <= xb:
            t = (cx - xa) / max(1e-6, xb - xa)
            b = float(ba) + (float(bb) - float(ba)) * t
            b = F(round(b * 2), 2)
            return min(max(b, ba), m.length - F(1, 2)) if m.length > F(1, 2) else ba
    return pts[-2][1]


def _char_systems(pr, systems, zones, heads):
    """글자마다 어느 시스템 것인지. 임시표·점·꼬리는 가장 가까운 음표를 따라간다
    (아래로 길게 내려간 음표가 다음 시스템 구역에 걸쳐 있을 수 있어서)."""
    out = {}
    for c in pr.chars:
        mm = music_map(c.font)
        owner = None
        if mm and c.used != "head" and (c.t in mm["accidentals"] or c.t == mm["dot"] or c.t in mm["flags"]):
            best = None
            for h in heads:
                if c.size < h.staff.gsize * 0.72:
                    continue                       # 작은 글자는 코드 기호의 샵·플랫이다
                d = abs(h.cx - c.ox) + abs(h.y - c.oy)
                if d < 5 * h.staff.sp and (best is None or d < best[0]):
                    best = (d, h)
            if best:
                owner = best[1].system
        if owner is None:
            owner = next((s for s, (lo, hi) in zip(systems, zones) if lo <= c.oy < hi), None)
        if owner is not None:
            out.setdefault(owner.idx, []).append(c)
    return out


def _retime_by_x(m, sd, sp):
    """길이를 읽어 더한 값이 박자표와 안 맞는 줄(두 오선에 걸친 빔, 복잡한 잇단음표 등)은
    악보의 가로 위치로 박을 정한다. 같은 세로줄에 다른 줄의 음이 있으면 그 박을 그대로 쓰고,
    없으면 앞뒤 사이를 나눈다. 정확하지 않을 수 있어서 approx로 표시한다."""
    others = [e for o in m.staves if o is not sd and o.ok and not o.absent for e in o.events
              if e.kind == "note" and e.beat is not None]
    anchors = sorted({(round(e.x, 1), e.beat) for e in others})
    evs = [e for e in sd.events if e.kind != "grace"]
    if not evs:
        return
    x_first = min([e.x for e in evs] + [a[0] for a in anchors])
    pts = [(x_first, F(0))] + [a for a in anchors if a[0] > x_first + 0.5 * sp] + [(m.x1, m.length)]
    grid = 12
    for e in evs:
        near = min(anchors, key=lambda a: abs(a[0] - e.x)) if anchors else None
        if near and abs(near[0] - e.x) <= 0.5 * sp:
            b = near[1]
        else:
            b = F(0)
            for (xa, ba), (xb, bb) in zip(pts, pts[1:]):
                if xa <= e.x <= xb:
                    t = (e.x - xa) / max(1e-6, xb - xa)
                    b = F(round((float(ba) + (float(bb) - float(ba)) * t) * grid), grid)
                    break
        e.beat = max(F(0), min(b, m.length - F(1, grid)))
    # 길이: 적힌 길이를 쓰되 마디 끝을 넘지 않게
    for e in evs:
        e.play_dur = max(F(1, grid), min(e.dur, m.length - e.beat))
    sd.approx = True


def _align_check(m, sp):
    """세로 정렬 검사: 악보에서 같은 세로줄에 놓인 음은 같은 박에 시작해야 한다.
    노래 줄과 다른 줄(피아노·다른 노래 줄)을 따로 읽은 결과가 서로 맞는지 확인한다.
    박자 합만 맞고 길이가 서로 바뀐 경우를 잡아낸다."""
    piano_ok = all(sd.ok for sd in m.staves if sd.role == "piano")     # 피아노를 잘못 읽은 마디는 기준으로 쓰지 않는다
    pts = [(e.x, e.beat, sd) for sd in m.staves if sd.ok and not sd.absent and (sd.role == "vocal" or piano_ok)
           for e in sd.events if e.kind == "note" and e.beat is not None]
    bad = []
    for i, (xa, ba, sa) in enumerate(pts):
        if sa.role != "vocal":
            continue
        for xb, bb, sb in pts:
            if sb is sa:
                continue
            if abs(xa - xb) <= 0.5 * sp and abs(ba - bb) >= F(1, 5):     # 1/5박 미만 차이는 엇박(셋잇단 대 16분 등)이다
                bad.append(f"노래{sa.line + 1} {ba}박 ↔ {'노래' if sb.role == 'vocal' else '피아노'}{sb.line + 1} {bb}박")
            elif xb - xa > 1.6 * sp and bb < ba or xa - xb > 1.6 * sp and bb > ba:
                bad.append(f"노래{sa.line + 1} {ba}박 순서 ↔ {'노래' if sb.role == 'vocal' else '피아노'}{sb.line + 1} {bb}박")
    return sorted(set(bad))


def _read_system(pr, sysm, zone, st, score, zch, page_heads, beams):
    sp = sysm.sp
    lo, hi = zone
    zcv = [c for c in pr.curves if lo <= (c.top + c.bottom) / 2 < hi]
    for c in zch:
        if is_music_font(c.font):
            score.fonts.add(c.font)

    heads = [h for h in page_heads if h.system is sysm]
    dotch = [c for c in zch if (music_map(c.font) or {}).get("dot") == c.t]
    layout.find_barlines(pr, sysm, [h.ch for h in heads], dotch)
    timesigs = marks.find_timesigs(zch, sysm)
    events = notes.build_events(pr, sysm, heads, zch, beams)
    notes.assign_dots(zch, sysm, heads, events)
    marks.find_ties(pr.curves, sysm, heads, events, zone)

    regions = sysm.regions
    for e in events:
        e.region = next((i for i, r in enumerate(regions) if r[0] < e.cx <= r[1]), -1)
        if e.region < 0 and regions:
            e.region = min(range(len(regions)), key=lambda i: min(abs(e.cx - regions[i][0]), abs(e.cx - regions[i][1])))

    notes.find_tremolos(events, beams, sp)

    counts = {"vocal": 0, "piano": 0}
    keyfn = {}
    lines = {}
    for s in sysm.staves:
        line = counts[s.role]
        counts[s.role] += 1
        lines[s.idx] = line
        stt = st["staff"].setdefault((s.role, line), {})
        if not stt and st["staff"]:                       # 처음 나온 줄은 가까운 줄의 조표를 이어받는다
            stt.update(next(iter(st["staff"].values())))
        keyfn[s.idx], _ = notes.staff_context(sysm, s, zch, heads, events, stt)

    marks.apply_tuplets(zch, sysm, events, beams)
    marks.assign_lyrics(zch, sysm, events, pr.rects)
    marks.assign_fermatas(zch, sysm, events)
    tempos = marks.find_tempos(zch)
    chords = marks.find_chords(zch, sysm)
    phr = marks.phrases([c for c in zch if not c.used])

    # ---- 마디 만들기
    made = []
    for ri, (rx0, rx1, left, right) in enumerate(regions):
        for tx, num, den in timesigs:
            if rx0 - 0.5 * sp <= tx < rx1 - 0.5 * sp:
                st["meter"] = (num, den)
        evs = [e for e in events if e.region == ri and e.kind != "grace"]
        if not evs or right is None:
            continue
        num, den = st["meter"]
        length = F(num * 4, den)
        st["n"] += 1
        m = Measure(n=st["n"], page=pr.page, system=sysm.idx, x0=rx0, x1=rx1, y0=sysm.top, y1=sysm.bottom,
                    meter=(num, den), length=length,
                    rep_start=bool(left and left.rep_start), rep_end=bool(right.rep_end),
                    final=bool(right.thick and not right.rep_end and not right.rep_start),
                    double=bool(right.n >= 2 and not right.thick))
        for s in sysm.staves:
            sev = sorted([e for e in evs if e.staff is s], key=lambda e: e.x)
            ok, total = notes.time_events(sev, length)
            absent = s.x0 > rx1 - sp or s.x1 < rx0 + sp
            m.staves.append(StaffData(staff=s, role=s.role, line=lines[s.idx], events=sev, ok=ok or absent or not sev,
                                      total=total, key=keyfn[s.idx]((rx0 + rx1) / 2), absent=absent or not sev))
        # 피아노 두 오선을 한 악기로 보고 다시 맞춰 보기: 아르페지오처럼 한 성부가 오른손·왼손 오선을 오가면
        # 오선을 따로 세서는 박자 합이 안 맞지만, 두 오선의 음을 가로 순서로 함께 세면 맞는다.
        piano_sd = [sd for sd in m.staves if sd.role == "piano" and not sd.absent]
        if len(piano_sd) >= 2 and any(not sd.ok for sd in piano_sd):
            joint = sorted([e for sd in piano_sd for e in sd.events], key=lambda e: e.x)
            ok, _ = notes.time_events(joint, length)
            if ok:
                for sd in piano_sd:
                    sd.ok, sd.total, sd.joint = True, length, True
            else:                                          # 안 맞으면 오선별로 센 결과로 되돌린다
                for sd in piano_sd:
                    sd.ok, sd.total = notes.time_events(sd.events, length)
        for sd in m.staves:
            if sd.role == "piano" and not sd.ok and not sd.absent:
                _retime_by_x(m, sd, sp)
        m.align = _align_check(m, sp)
        made.append((ri, m))
    if not made:
        return
    made[0][1].first_in_system = True
    made[-1][1].last_in_system = True

    def measure_at(x, slack=0.0):
        for ri, m in made:
            if x <= m.x1 - slack:
                return m
        return made[-1][1]

    for tx, ty, bpm in tempos:
        measure_at(tx, 2 * sp).bpm = bpm
    for cx, name in chords:
        if name.startswith("/") or name in marks.RESOLVE_3:
            base = st.get("last_chord")
            if not base:
                continue                                  # 기댈 앞 코드가 없다
            head, _, bass = base.partition("/")
            if name.startswith("/"):
                name = head + name                        # 'Gm7' 다음의 '/F' → 'Gm7/F'
            elif name == "7":
                name = head + "7" + ("/" + bass if bass else "")                          # 'G' 다음의 '7' → 'G7'
            else:
                name = re.sub(r"\(?sus[24]?\)?", "", head) + ("/" + bass if bass else "")   # 'Fsus4' 다음의 '-3' → 'F'
        st["last_chord"] = name
        m = measure_at(cx)
        m.chords.append({"name": name, "beat": _beat_at(m, cx, sp), "x": cx})
    for m in (m for _, m in made):
        m.chords.sort(key=lambda c: (c["beat"], c["x"]))
        for a, b in zip(m.chords, m.chords[1:]):          # 같은 박에 두 코드가 겹치면 뒤 코드를 반 박 뒤로
            if b["beat"] <= a["beat"]:
                b["beat"] = min(a["beat"] + F(1, 2), m.length - F(1, 4))

    # ---- 글자 표시: 괄호(1. 2.), 마디 번호, 배역 이름, rit. 등
    brackets = [c for c in zcv if c.stroke and not c.fill and c.x1 - c.x0 > 3 * sp and c.bottom - c.top < 6 * sp
                and c.top < sysm.top]
    for p in phr:
        txt = p.text.strip()
        if not txt:
            continue
        boxed = marks.in_rect(p, pr.rects)
        if re.fullmatch(r"[1-9]\.(\s*[1-9]\.)*", txt) and p.cy < sysm.top and not boxed:
            num = int(txt[0])
            br = [c for c in brackets if c.x0 - 3 * sp <= p.x0 <= c.x0 + 3 * sp and abs(c.top - p.top) < 4 * sp]
            xa, xb = (br[0].x0, max(c.x1 for c in br)) if br else (p.x0, p.x1)
            hit = False
            for _, m in made:
                ov = min(xb, m.x1) - max(xa, m.x0)
                if ov > 0.5 * (m.x1 - m.x0):
                    m.ending = num
                    hit = True
            if not hit:
                measure_at(p.cx).ending = num
            continue
        if txt.isdigit() and "Italic" in p.font and "Bold" not in p.font and p.x0 < sysm.x0 + 4 * sp and not boxed:
            if made[0][1].printed is None:
                made[0][1].printed = int(txt)
            continue
        if boxed:
            if any(marks.is_hangul(ch) for ch in txt) or len(txt) >= 2:
                voc = sysm.vocal
                if voc:
                    s = min(voc, key=lambda s: min(abs(p.cy - s.top), abs(p.cy - s.bottom)))
                    measure_at(p.cx).labels.append({"name": txt, "line": lines[s.idx], "x": p.cx})
            continue
        for kind, pat in MARK_PATTERNS:
            if pat.search(txt):
                m = measure_at(p.x0, 1.0 * sp)
                m.marks.append({"type": kind, "text": txt, "beat": _beat_at(m, p.x0 + 1.5 * sp, sp), "x": p.x0, "y": p.cy})
                break
    # ---- 기호 사용 검사: 악보에 있는 기호가 빠짐없이, 앞뒤가 맞게 쓰였는지 (박자 합과 무관한 검사)
    by_region = {ri: m for ri, m in made}

    def note(x, role, text):
        ri = next((i for i, r in enumerate(regions) if r[0] < x <= r[1]), None)
        if ri in by_region:
            by_region[ri].checks.append((role, text))
    in_event = {id(h) for e in events for h in e.heads}
    for h in heads:                                   # 1) 읽지 않은 음표 머리
        if id(h) not in in_event and not h.grace:
            note(h.cx, h.staff.role, f"읽지 않은 머리 {h.pos}")
    for c in zch:                                     # 2) 어느 기둥에도 붙지 않은 꼬리
        mm = music_map(c.font)
        if mm and c.t in mm["flags"] and c.used != "flag":
            st_ = notes.staff_for(sysm, c.ox, c.oy, snap=False)
            if st_ is not None and c.size >= st_.gsize * 0.72:
                note(c.ox, st_.role, "기둥에 안 붙은 꼬리")
    # 아래 6)·7)은 "읽을 때와 다른(더 넉넉한) 기준으로 다시 세어도 같은 답이 나오는가"를 본다.
    # 박자 합이 우연히 맞아도, 머리 하나를 놓쳤거나 꼬리·빔을 잘못 짝지었으면 여기서 어긋난다.
    flag_chars = [c for c in zch if (music_map(c.font) or {}).get("flags", {}).get(c.t)]
    for e in events:
        if e.kind != "note":
            continue
        role = e.staff.role
        if e.warn:                                    # 3) 기둥 없는 4분·2분음표 머리
            note(e.cx, role, e.warn)
        if not e.stem:
            continue
        sx, top, bot = e.stem["x"], e.stem["top"], e.stem["bottom"]
        if e.flags and e.beams:                       # 4) 한 기둥에 꼬리와 빔이 같이 있음
            note(e.cx, role, "꼬리와 빔이 같이 있음")
        strict = max(e.flags, e.beams)                # 5) 꼬리·빔 개수와 읽은 길이가 맞는지
        if not any(h.kind == "half" for h in e.heads) and e.base != F(1, 2 ** strict):
            note(e.cx, role, f"꼬리·빔 {strict}개인데 길이 {e.base}")
        # 6) 기둥에 붙은 머리 수 = 읽은 화음의 음 수.
        #    기둥 바로 옆에 있는데 어느 기둥에도 붙지 못한 머리가 있으면 화음의 음 하나를 놓친 것이다.
        #    (다른 성부의 기둥에 붙은 머리, 기둥이 원래 없는 온음표는 정상이라 세지 않는다)
        missed = [h for h in heads if not h.grace and not h.stemmed and h.kind != "whole"
                  and top - 0.6 * sp <= h.y <= bot + 0.6 * sp and min(abs(sx - h.x0), abs(sx - h.x1)) <= 0.6 * sp]
        if missed:
            note(e.cx, role, f"기둥 옆에 붙지 못한 머리 {len(missed)}개 (읽은 음 {len(e.heads)}개)")
        nf = max([music_map(c.font)["flags"][c.t] for c in flag_chars
                  if abs(c.ox - sx) < 0.6 * sp and top - 1.5 * sp <= c.oy <= bot + 1.5 * sp] + [0])
        nb = sum(1 for bm in beams if bm.x0 - 1.2 <= sx <= bm.x1 + 1.2 and top - 1.0 * sp <= bm.y_at(sx) <= bot + 1.0 * sp)
        if max(nf, nb) != strict:                     # 7) 꼬리·빔을 넉넉한 기준으로 다시 센 수 = 읽은 수
            note(e.cx, role, f"꼬리·빔을 넉넉히 세면 {max(nf, nb)}개, 읽은 것은 {strict}개")
    for ri, m in made:                                # 8) 꼬리 글자 수 = 꼬리 달린 음 수 (한 꼬리를 두 음이 같이 쓰면 어긋난다)
        rx0, rx1 = regions[ri][0], regions[ri][1]
        for role in ("vocal", "piano"):
            n_glyph = sum(1 for c in flag_chars if rx0 < c.ox <= rx1 and c.used == "flag"
                          and c.size >= sysm.sp * 4 * 0.72                       # 꾸밈음의 작은 꼬리는 세지 않는다
                          and (notes.staff_for(sysm, c.ox, c.oy, snap=False) or sysm.staves[0]).role == role)
            n_ev = sum(1 for e in events if e.kind == "note" and e.region == ri and e.flags and e.staff.role == role)
            if n_glyph != n_ev:
                m.checks.append((role, f"꼬리 글자 {n_glyph}개인데 꼬리 달린 음 {n_ev}개"))
    for e in events:
        if e.warn:
            score.warnings.append(f"p{pr.page} 시스템{sysm.idx + 1} x{e.x:.0f}: {e.warn}")
    score.measures.extend(m for _, m in made)


def _join_open_ties(score):
    """줄이나 쪽이 바뀌는 곳을 넘어가는 붙임줄을 잇는다."""
    ms = score.measures
    for i in range(len(ms) - 1):
        a, b = ms[i], ms[i + 1]
        if not (a.last_in_system and b.first_in_system):
            continue
        for sa in a.staves:
            outs = [h for e in sa.events for h in e.heads if h.open_out]
            if not outs:
                continue
            same = [sb for sb in b.staves if sb.role == sa.role and sb.line == sa.line]
            others = [sb for sb in b.staves if sb.role == sa.role and sb.line != sa.line]
            for h in outs:
                for sb in same + others:
                    notes_ = [e for e in sb.events if e.kind == "note"]
                    if not notes_:
                        continue
                    first = min(notes_, key=lambda e: e.x)
                    tgt = [g for g in first.heads if g.pos == h.pos and not g.tie_in]
                    if tgt and (tgt[0].open_in or sb in same):
                        g = tgt[0]
                        h.tie_out, g.tie_in = True, True
                        if g.acc is None and g.step == h.step:
                            g.alter = h.alter
                        break


def read_pdf(path, first=None, last=None):
    """path: PDF 파일 경로 또는 PDF 내용(bytes)."""
    t0 = time.perf_counter()
    score = Score()
    st = {"meter": (4, 4), "n": 0, "staff": {}}
    all_pages = list(prims.pages(path))
    counts = {}
    for pr in all_pages:
        for c in pr.chars:
            d = counts.setdefault(c.font, {})
            d[c.t] = d.get(c.t, 0) + 1
    learn_fonts(counts)
    for pr in all_pages:
        pno = pr.page
        score.image_pages += 1 if pr.images else 0
        for c in pr.chars:
            if is_music_font(c.font):
                score.all_music_fonts.add(c.font)
        if (first and pno < first) or (last and pno > last):
            continue
        staves = layout.find_staves(pr)
        score.pages.append({"n": pno, "w": pr.width, "h": pr.height, "music": bool(staves)})
        if not staves:
            continue
        systems = layout.group_systems(pr, staves)
        zones = _zones(systems)
        heads = notes.build_heads(pr, systems, zones)
        by_sys = _char_systems(pr, systems, zones, heads)
        beams = notes.find_beams(pr.curves, systems[0].sp, pr.rects)
        for sysm, zone in zip(systems, zones):
            _read_system(pr, sysm, zone, st, score, by_sys.get(sysm.idx, []), heads, beams)
    _join_open_ties(score)
    # 빠르기는 한 번 나오면 다음 표시까지 이어진다
    cur = None
    for m in score.measures:
        if m.bpm:
            cur = m.bpm
        m.bpm_eff = cur
    # 못갖춘마디: 곡 맨 처음 마디가 짧으면 정상으로 본다
    if score.measures:
        m0 = score.measures[0]
        if all(sd.total <= m0.length for sd in m0.staves) and any(not sd.ok for sd in m0.staves):
            m0.pickup = True
            m0.length = max(sd.total for sd in m0.staves)
            for sd in m0.staves:
                sd.ok = True
                if sd.approx:
                    notes.time_events(sd.events, m0.length)
                    sd.approx = False
                    for e in sd.events:
                        if hasattr(e, "play_dur"):
                            del e.play_dur
    # 나뉜 마디: 도돌이표가 마디 중간에 있으면 한 마디가 두 조각으로 나뉘어 적힌다 (앞 조각 + 뒤 조각 = 한 마디).
    # 모든 줄이 똑같이 짧고 두 조각을 더해 딱 한 마디가 될 때만 그렇게 본다. 곡의 마지막 마디가 모든 줄에서 똑같이 짧은 것도 정상이다.
    def shorten(m, t):
        m.length = t
        for sd in m.staves:
            if sd.absent:
                continue
            sd.ok, sd.total = notes.time_events(sd.events, t)
            sd.approx = False
            for e in sd.events:
                if hasattr(e, "play_dur"):
                    del e.play_dur

    def same_total(m):
        ts = {sd.total for sd in m.staves if not sd.absent}
        return ts.pop() if len(ts) == 1 else None

    ms = score.measures
    for a, b in zip(ms, ms[1:]):
        if a.pickup or a.length != b.length or all(sd.ok for sd in a.staves) or all(sd.ok for sd in b.staves):
            continue
        ta, tb = same_total(a), same_total(b)
        if ta and tb and ta + tb == a.length:
            shorten(a, ta)
            shorten(b, tb)
    if len(ms) > 1 and any(not sd.ok for sd in ms[-1].staves):
        t = same_total(ms[-1])
        if t and t < ms[-1].length:
            shorten(ms[-1], t)
    score.seconds = time.perf_counter() - t0
    return score
