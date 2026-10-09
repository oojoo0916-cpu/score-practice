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
    }


def play_order(measures):
    """악보 순서 → 실제 연주 순서 (도돌이표, 1·2번 괄호)."""
    order, i, start, pass_no, done = [], 0, 0, 1, set()
    guard = 0
    while i < len(measures) and guard < len(measures) * 4 + 8:
        guard += 1
        m = measures[i]
        if m.rep_start and not (order and order[-1] >= i):
            start, pass_no = i, 1
        if m.ending and m.ending != pass_no:
            i += 1
            continue
        order.append(i)
        if m.rep_end and i not in done:
            done.add(i)
            pass_no = 2
            i = start
            continue
        if m.rep_end or m.ending == 2:
            pass_no = 1
        i += 1
    return order


def to_song(score, title):
    ms = score.measures
    first_bpm = next((m.bpm for m in ms if m.bpm), None)
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
    parts = {}
    for mi, m in enumerate(ms):
        for sd in m.staves:
            key = (sd.role, sd.line)
            p = parts.setdefault(key, {"id": f"{sd.role}{sd.line + 1}", "role": sd.role,
                                       "name": ("노래 " if sd.role == "vocal" else "피아노 ") + str(sd.line + 1),
                                       "notes": []})
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
                o["dur"] = max(o["dur"], n["dur"])
                o["tie"] = o["tie"] or n["tie"]
                o["tied"] = o["tied"] or n["tied"]
                o["lyric"] = o["lyric"] or n["lyric"]
        p["notes"] = list(seen.values())
        p["verified"] = p["role"] == "vocal"       # 피아노 줄은 아직 검증하지 않은 참고용
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
