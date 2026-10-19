"""읽은 결과(Score) 내보내기.

- summary(): 사람이 읽고 비교하기 위한 글 (tests/check_baseline.py가 이걸로 달라진 마디를 찾는다)
- to_song(): 앱용 song.json (악보 순서 마디 + 연주 순서 + 파트별 음표, 음표·마디마다 원본 악보 위치)
- to_legacy(): 예전 재생 앱(player/player_template.html)용. 도돌이표를 펼치고 붙임줄을 한 음으로 합친다.
"""
from fractions import Fraction as F

ACC = {2: "x", 1: "#", 0: "", -1: "b", -2: "bb"}


def pitch_name(h):
    return f"{h.step}{ACC[h.alter]}{h.octave}"


def uniq_heads(e):
    """같은 음이 두 번 겹쳐 적힌 것(두 성부가 같은 음)은 하나로."""
    best = {}
    for h in e.heads:
        o = best.get(h.midi)
        if o is None or (h.tie_out and not o.tie_out):
            best[h.midi] = h
    return [best[k] for k in sorted(best)]


def _ev_text(e):
    if e.kind == "rest":
        s = f"쉼:{e.dur}"
    else:
        s = "+".join(pitch_name(h) + ("~" if h.tie_out else "") for h in uniq_heads(e)) + f":{e.dur}"
        if e.lyric:
            s += f"({e.lyric})"
        if e.slur in ("start", "mid"):
            s += "⌒"
    if e.tuplet:
        s += "³" if e.tuplet[0] == 3 else f"[{e.tuplet[0]}잇단]"
    if e.fermata:
        s += "^"
    return s


def summary(score, piano=False):
    lines = []
    for m in score.measures:
        flags = []
        if m.rep_start:
            flags.append("‖:")
        if m.ending:
            flags.append(f"{m.ending}번괄호")
        if m.rep_end:
            flags.append(":‖")
        if m.final:
            flags.append("끝")
        if m.pickup:
            flags.append("못갖춘마디")
        if m.bpm:
            flags.append(f"♩={m.bpm:g}")
        for mk in m.marks:
            flags.append(f"{mk['type']}@{mk['beat']}")
        for lb in m.labels:
            flags.append(f"[{lb['name']}→노래{lb['line'] + 1}]")
        chords = " ".join(f"{c['name']}@{c['beat']}" for c in m.chords)
        if m.align:
            flags.append("세로정렬어긋남(" + "; ".join(m.align[:3]) + ")")
        if m.checks:
            flags.append("기호검사(" + "; ".join(f"{'노래' if r == 'vocal' else '피아노'}:{t}" for r, t in m.checks[:3]) + ")")
        if m.doubts:
            flags.append("검사(" + "; ".join(t for _, t in m.doubts[:3]) + ")")
        head = f"마디{m.n} p{m.page} {m.meter[0]}/{m.meter[1]} {'OK' if m.ok else '확인'} {' '.join(flags)}".rstrip()
        lines.append(f"{head} | 코드 {chords}" if chords else head)
        for sd in m.staves:
            if sd.role == "piano" and not piano:
                continue
            if sd.absent:
                continue
            name = ("노래" if sd.role == "vocal" else "피아노") + str(sd.line + 1)
            st = "" if sd.ok else f" ?합{sd.total}"
            lines.append(f"    {name} 조표{sd.key:+d}{st}: " + " ".join(_ev_text(e) for e in sd.events))
    return "\n".join(lines) + "\n"


def stats(score):
    ms = score.measures
    bad = [m.n for m in ms if not m.ok]
    printed = [(m.n, m.printed) for m in ms if m.printed is not None]
    mism = [(n, p) for n, p in printed if n != p]
    nn = sum(1 for m in ms for sd in m.vocal for e in sd.events if e.kind == "note")
    ties = sum(1 for m in ms for sd in m.vocal for e in sd.events for h in e.heads if h.tie_out)
    lyr = sum(1 for m in ms for sd in m.vocal for e in sd.events if e.lyric)
    piano_bad = [m.n for m in ms if any(sd.approx for sd in m.staves if sd.role == "piano")]
    piano_notes = sum(1 for m in ms for sd in m.staves if sd.role == "piano" for e in sd.events if e.kind == "note")
    return {
        "seconds": round(score.seconds, 2),
        "pages": len(score.pages),
        "measures": len(ms),
        "vocal_measures_checked": sum(1 for m in ms for sd in m.vocal if not sd.absent),
        "sum_ok": sum(1 for m in ms if all(s.ok for s in m.vocal)),
        "align_checked": sum(1 for m in ms if m.vocal and any(not s.absent for s in m.vocal)
                             and sum(1 for s in m.staves if s.ok and not s.absent and any(e.kind == "note" for e in s.events)) >= 2),
        "align_bad": [m.n for m in ms if m.align],
        "symbol_bad": [m.n for m in ms if any(r == "vocal" for r, _ in m.checks)],
        "symbol_bad_piano": [m.n for m in ms if any(r == "piano" for r, _ in m.checks)],
        "lyric_bad": [m.n for m in ms if any(k == "lyric" for k, _ in m.doubts)],      # 가사 밑에 음표가 없는 마디
        "need_check": bad,
        "printed_numbers": len(printed),
        "printed_mismatch": mism,
        "vocal_notes": nn,
        "ties": ties,
        "lyrics": lyr,
        "chords": sum(len(m.chords) for m in ms),
        "piano_notes": piano_notes,
        "piano_need_check": len(piano_bad),
        "piano_check_list": piano_bad,
        "warnings": len(score.warnings),
        "meter_guess": sum(1 for m in ms if getattr(m, "meter_guess", False)),      # 박자표를 읽지 못해 4/4로 친 마디 수
        "tempo_found": any(m.bpm for m in ms),                                      # 빠르기말(♩=…)을 읽었는가. 못 읽었으면 ♩=72 로 친다
        "unsupported": [m.n for m in ms if unsupported_of(m)],                      # 소리 내지 않는 표기(꾸밈음)가 있는 마디
    }


def nav_of(m):
    """마디에 걸린 진행 기호(marks 의 type "nav") → {"dc", "ds", "alfine", "alcoda", "fine", "tocoda", "coda", "segno"} 가운데 있는 것."""
    out = set()
    for k in getattr(m, "marks", None) or []:
        if k.get("type") != "nav":
            continue
        t = "".join(ch for ch in str(k.get("text", "")).lower() if ch.isalnum())      # "D.S. al Coda" → "dsalcoda"
        if t.startswith(("dc", "dacapo")):
            out.add("dc")
        elif t.startswith(("ds", "dalsegno")):
            out.add("ds")
        elif t.startswith("tocoda"):
            out.add("tocoda")
        elif t == "fine":
            out.add("fine")
        elif t.startswith("coda"):
            out.add("coda")
        elif t.startswith("segno"):
            out.add("segno")
        if out & {"dc", "ds"}:
            out |= {x for x in ("alfine", "alcoda") if x in t}
    return out


def play_order(measures):
    """악보 순서 → 실제 연주 순서 (도돌이표, 1·2번 괄호, D.C.·D.S.·Fine·Coda). 앱의 web/musicxml.js playOrder 와 같은 규칙이다 (같은 표로 시험한다).
    - 되풀이를 마치면 다음 되풀이는 그 다음 마디에서 시작한다 (시작 표시 ‖: 가 생략된 A :‖ B :‖ → A A B B)
    - 2번 괄호가 여러 마디면 끝까지 친다. 2번 괄호를 다 지나면 되풀이가 끝난 것이다
    - D.C.(처음으로)·D.S.(segno 로)는 그 마디를 친 뒤에 한 번만 돌아간다. 돌아간 뒤에는 되풀이를 하지 않고(2번 괄호로),
      Fine 이 있는 마디에서 끝나거나(al Coda 가 아니면), To Coda 마디를 친 뒤 Coda 마디로 건너뛴다(al Coda)"""
    navs = [nav_of(m) for m in measures]
    order, i, start, pass_no, done = [], 0, 0, 1, set()
    in_second = jumped = False
    to_coda = False
    guard = 0
    while i < len(measures) and guard < len(measures) * 6 + 16:
        guard += 1
        m = measures[i]
        if jumped:
            pass_no = 2
        elif in_second and not m.ending:
            in_second, pass_no, start = False, 1, i
        if not jumped and m.rep_start and not (order and order[-1] >= i):
            start, pass_no = i, 1
        if m.ending and m.ending != pass_no:
            i += 1
            continue
        order.append(i)
        if m.ending == 2:
            in_second = True
        if m.rep_end and not jumped:
            if i not in done:
                done.add(i)
                pass_no = 2
                i = start
                continue
            pass_no, start = 1, i + 1
        nav = navs[i]
        if jumped:
            if "fine" in nav and not to_coda:
                break
            if "tocoda" in nav and to_coda:
                coda = next((k for k, x in enumerate(navs) if "coda" in x), None)
                if coda is not None:
                    i = coda
                    continue
        elif nav & {"dc", "ds"}:
            jumped, to_coda = True, "alcoda" in nav
            i = 0 if "dc" in nav else next((k for k, x in enumerate(navs) if "segno" in x), 0)
            continue
        i += 1
    return order


def voice_hints(sd):
    """한 오선에 두 성부가 적힌 마디에서 각 음이 위 성부인지 아래 성부인지 기둥 방향으로 알아낸다.
    → {id(음): "top" | "bottom"}
    기둥 방향을 믿는 것은 두 성부로 적힌 것이 분명할 때뿐이다:
    - 다른 성부가 쉼표로 쉬는 동안 혼자 나오는 음
    - 같이 소리 나는 다른 음이 모두 기둥이 반대쪽인 음 (아래 성부가 위 성부보다 높이 올라가 엇갈려도 맞게 갈린다)
    아무것과도 겹치지 않는 음은 한 성부로 적힌 곳이라 기둥 방향이 음높이를 따를 뿐이다 → 적지 않는다.
    기둥 하나에 달린 화음, 기둥이 같은 쪽인 음끼리 겹치는 곳, 기둥 없는 온음표도 적지 않는다 → 앱이 음높이로 가른다(splitLines).
    기둥이 위아래로 둘 달린 음(둘이 같은 음)은 음 둘로 읽혀 각각 위·아래가 되고, to_song 이 하나로 합치면서 "both"로 적는다
    (두 성부의 길이·붙임줄이 다르면 "vd"에 성부별로 남긴다)."""
    if not sd.ok or sd.approx:
        return {}
    evs = [e for e in sd.events if e.beat is not None and e.kind in ("note", "rest")]
    out = {}
    for e in evs:
        if e.kind != "note" or not e.stem:
            continue
        a, b = e.beat, e.beat + e.dur
        over = [o for o in evs if o is not e and o.beat < b and a < o.beat + o.dur]
        if over and all(o.kind == "rest" or (o.stem and o.stem["up"] != e.stem["up"]) for o in over):
            out[id(e)] = "top" if e.stem["up"] else "bottom"
    return out


def _rest_height(e):
    """쉼표가 오선 가운뎃줄에서 몇 칸 떨어져 있는지 (−는 위, +는 아래). 오선을 모르면 None."""
    lines, sp = getattr(e.staff, "lines", None), getattr(e.staff, "sp", 0)
    if not lines or len(lines) < 3 or not sp:
        return None
    return (e.y - lines[2]) / sp


def rest_voices(staves):
    """쉼표가 위 성부의 것인지 아래 성부의 것인지를 오선 안의 높이로 알아낸다. → {id(쉼표): "top" | "bottom"}
    한 오선에 두 성부를 적을 때는 위 성부의 쉼표를 제자리보다 위로, 아래 성부의 쉼표를 아래로 옮겨 적는다.
    제자리는 쉼표 종류(글자)와 글꼴에 따라 다르므로, 이 악보에서 그 종류의 쉼표가 가장 많이 놓인 높이를 제자리로 본다
    (가운뎃줄에서 1.5칸 안쪽에 있는 것들 중에서. 그런 것이 하나도 없으면 가운뎃줄).
    제자리에서 0.75칸 이상 벗어난 쉼표만 적는다 — 제자리의 쉼표는 누구의 것인지 알 수 없다(한 성부로 적힌 곳이 대부분이다)."""
    seen = {}
    for sd in staves:
        for e in sd.events:
            if e.kind != "rest":
                continue
            h = _rest_height(e)
            if h is not None:
                seen.setdefault(getattr(e.ch, "t", None) or str(e.base), []).append((e, h))
    out = {}
    for items in seen.values():
        near = {}
        for _, h in items:
            if abs(h) <= 1.5:
                k = round(h * 2) / 2
                near[k] = near.get(k, 0) + 1
        normal = max(near, key=lambda k: (near[k], -abs(k))) if near else 0.0
        for e, h in items:
            if h - normal <= -0.75:
                out[id(e)] = "top"
            elif h - normal >= 0.75:
                out[id(e)] = "bottom"
    return out


def why_of(m):
    """자동 검사에 걸린 마디가 어느 검사에 걸렸는지: 박자 합 "sum" · 세로 정렬 "align" · 기호 검사 "symbol" (노래 줄 기준)
    · 가사 밑에 붙을 음표가 없음 "lyric"."""
    out = []
    if not all(s.ok for s in m.vocal):
        out.append("sum")
    if m.align:
        out.append("align")
    if any(r == "vocal" for r, _ in m.checks):
        out.append("symbol")
    for k in dict.fromkeys(k for k, _ in m.doubts):
        out.append(k)
    return out


def unsupported_of(m):
    """악보에 있지만 소리 내지 않는 표기. 자동 검사 통과 여부와는 별개다.
    "grace" = 노래 줄의 작은 음표(꾸밈음), "grace_piano" = 피아노 줄의 작은 음표."""
    names = {("vocal", "grace"): "grace", ("piano", "grace"): "grace_piano"}
    return sorted({names[k] for k in getattr(m, "skipped", []) if k in names})


def to_song(score, title):
    ms = score.measures
    first_bpm = next((m.bpm for m in ms if m.bpm), None)
    rest_of = rest_voices([sd for m in ms for sd in m.staves if sd.role == "vocal" and not sd.absent])
    out_m = []
    for m in ms:
        out_m.append({
            "n": m.n, "page": m.page, "system": m.system + 1,
            "box": [round(m.x0, 1), round(m.y0, 1), round(m.x1, 1), round(m.y1, 1)],
            "meter": list(m.meter), "len": float(m.length), "bpm": getattr(m, "bpm_eff", None) or first_bpm or 72,
            "key": m.vocal[0].key if m.vocal else (m.staves[0].key if m.staves else 0),
            "rep_start": m.rep_start, "rep_end": m.rep_end, "ending": m.ending, "final": m.final,
            "pickup": m.pickup, "ok": m.ok,
            "piano_ok": not any(sd.approx for sd in m.staves),
            "chords": [{"name": c["name"], "beat": float(c["beat"])} for c in m.chords],
            "marks": [{"type": k["type"], "text": k["text"], "beat": float(k["beat"])} for k in m.marks],
            "labels": m.labels,
        })
        if getattr(m, "meter_guess", False):
            out_m[-1]["meter_guess"] = True       # 박자표를 읽지 못해 4/4로 쳤다 (앱이 "추정"으로 보여 준다)
        if not m.ok:
            out_m[-1]["why"] = why_of(m)          # 자동 검사의 어느 것에 걸렸는지
        if unsupported_of(m):
            out_m[-1]["unsupported"] = unsupported_of(m)
    parts = {}
    for mi, m in enumerate(ms):
        for sd in m.staves:
            key = (sd.role, sd.line)
            p = parts.setdefault(key, {"id": f"{sd.role}{sd.line + 1}", "role": sd.role,
                                       "name": ("노래 " if sd.role == "vocal" else "피아노 ") + str(sd.line + 1),
                                       "notes": []})
            hints = voice_hints(sd) if sd.role == "vocal" else {}
            if sd.role == "vocal" and not sd.absent:
                # 쉼표도 남긴다: 누가 쉬는지 알아야 "혼자 나오는 음"이 한 성부의 것인지 같이 부르는 음인지 가를 수 있다.
                # 박자 합이 안 맞는 마디는 박 위치를 믿을 수 없으니 남기지 않고, 그런 마디라고 따로 적는다
                rests, unsure = p.setdefault("rests", []), p.setdefault("rest_unsure", [])
                if sd.ok and not sd.approx:
                    for e in sd.events:
                        if e.kind == "rest" and e.beat is not None:
                            r = {"m": mi, "beat": float(e.beat), "dur": float(e.dur)}
                            if id(e) in rest_of:
                                r["voice"] = rest_of[id(e)]            # 위 성부의 쉼표 / 아래 성부의 쉼표
                            rests.append(r)
                else:
                    unsure.append(mi)
            for e in sd.events:
                if e.kind != "note" or e.beat is None:
                    continue
                hs = uniq_heads(e)
                for h in hs:
                    p["notes"].append({
                        "m": mi, "beat": float(e.beat), "dur": float(getattr(e, "play_dur", e.dur)), "midi": h.midi, "name": pitch_name(h),
                        "lyric": e.lyric if h is hs[-1] else "",
                        "page": m.page, "x": round(h.cx, 1), "y": round(h.y, 1),
                        "tie": h.tie_out, "tied": h.tie_in, "slur": e.slur, "fermata": e.fermata,
                    })
                    if id(e) in hints:
                        p["notes"][-1]["voice"] = hints[id(e)]      # 두 성부로 적힌 곳: 위/아래 성부
    plist = [parts[k] for k in sorted(parts, key=lambda k: (k[0] != "vocal", k[1]))]
    for p in plist:
        # 두 성부가 같은 박에 같은 음을 내면 한 번만 (긴 쪽, 붙임줄·가사가 있는 쪽을 남긴다)
        seen = {}
        for n in p["notes"]:
            k = (n["m"], round(n["beat"], 6), n["midi"])
            o = seen.get(k)
            if o is None:
                seen[k] = n
            else:
                vo, vn = o.get("voice"), n.get("voice")
                if vo != vn:
                    # 두 성부의 길이나 붙임줄이 다르면 성부별로 따로 적어 둔다 (한 성부만 골라 들을 때는 그 성부의 길이로 낸다)
                    if {vo, vn} == {"top", "bottom"} and (o["dur"] != n["dur"] or o["tie"] != n["tie"]):
                        o["vd"] = {vo: {"dur": o["dur"], "tie": o["tie"]}, vn: {"dur": n["dur"], "tie": n["tie"]}}
                    o["voice"] = "both"            # 두 성부가 같은 음: 어느 쪽을 골라 들어도 낸다
                o["dur"] = max(o["dur"], n["dur"])
                o["tie"] = o["tie"] or n["tie"]
                o["tied"] = o["tied"] or n["tied"]
                o["lyric"] = o["lyric"] or n["lyric"]
        p["notes"] = list(seen.values())
        # 이 줄이 어떤 확인을 거쳤는지: 노래 줄은 자동 검사(박자 합·세로 정렬·기호 검사), 피아노 줄은 검사하지 않은 참고용.
        # 자동 검사를 통과했다는 것은 사람이 확인했다는 뜻이 아니다 — 사람이 확인한 마디는 앱의 고친 기록(edits.checked)에 따로 남는다
        p["check"] = "auto" if p["role"] == "vocal" else "none"
    return {
        "format": 2, "title": title, "engine": "pdfscore",
        "pages": score.pages, "tempo": first_bpm or 72, "tempo_found": first_bpm is not None,
        "measures": out_m, "order": play_order(ms), "parts": plist,
    }


def merged_notes(song, part):
    """연주 순서로 펼친 음표. 붙임줄로 이어진 음은 첫 음 하나로 합쳐 길게 만든다.
    → [{"k": 연주 순서 마디 번호, "beat", "dur", "midi", "lyric", "start": 곡 처음부터의 박}]"""
    order = song["order"]
    starts, acc = [], 0.0
    for oi in order:
        starts.append(acc)
        acc += song["measures"][oi]["len"]
    by_m = {}
    for n in part["notes"]:
        by_m.setdefault(n["m"], []).append(n)
    seq = []
    for k, oi in enumerate(order):
        for n in by_m.get(oi, []):
            seq.append({**n, "k": k, "start": starts[k] + n["beat"]})
    seq.sort(key=lambda n: (n["start"], n["midi"]))
    out, open_ = [], {}                    # open_: 음높이 → 붙임줄이 열려 있는 음
    for n in seq:
        prev = open_.get(n["midi"])
        if prev is not None and abs(prev["start"] + prev["dur"] - n["start"]) < 1e-6:
            prev["dur"] += n["dur"]
            if not n["tie"]:
                del open_[n["midi"]]
            continue
        open_.pop(n["midi"], None)
        cur = dict(n)
        out.append(cur)
        if n["tie"]:
            open_[n["midi"]] = cur
    return out


def to_legacy(song):
    """예전 막대 화면 재생 앱이 읽는 모양."""
    order = song["order"]
    seen, measures = {}, []
    for oi in order:
        seen[oi] = seen.get(oi, 0) + 1
        m = song["measures"][oi]
        measures.append({"n": m["n"], "meter": m["meter"], "len": m["len"], "bpm": m["bpm"], "chords": m["chords"],
                         "key": m["key"], "page": m["page"], "system": m["system"], "rep_start": m["rep_start"],
                         "rep_end": m["rep_end"], "ending": m["ending"], "ok": m["ok"], "orig": oi, "pass": seen[oi]})
    parts = []
    for p in song["parts"]:
        if p["role"] != "vocal":
            continue
        ns = [{"m": n["k"], "beat": n["beat"], "dur": n["dur"], "midi": n["midi"], "lyric": n["lyric"] or None}
              for n in merged_notes(song, p)]
        parts.append({"name": p["name"], "notes": ns})
    return {"title": song["title"], "tempo": song["tempo"], "measures": measures, "parts": parts}
