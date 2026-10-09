"""음악 글꼴의 글자 → 음악 기호 대응표.

사보 프로그램마다 글꼴이 다르다.
  Finale   → Maestro
  Sibelius → Opus (음표), Opus Special (점·중괄호), Opus Text (셋잇단 숫자·빠르기 음표), Opus Chords (코드)
MuseScore(MScore/Bravura) 등은 아직 없다. 새 프로그램을 지원하려면 여기에 표를 추가한다.
"""
from fractions import Fraction as F

EMPTY = {
    "heads": {}, "rests": {}, "whole_rest": None, "flags": {}, "accidentals": {}, "clefs": {},
    "dot": None, "fermata": "", "time_digits": "", "time_symbols": {}, "brace": None,
    "head_width": None,          # 머리 폭 = 글꼴 크기 × 이 값 (None이면 글자 폭 그대로)
}

MAESTRO = {
    **EMPTY,
    "heads": {"œ": "black", "˙": "half", "w": "whole"},
    # 쉼표: 4분음표를 1로 본 길이
    "rests": {"Œ": F(1), "‰": F(1, 2), "≈": F(1, 4), "®": F(1, 8), "Ó": F(2), "∑": F(4)},
    "whole_rest": "∑",
    # 꼬리(깃발): 개수. 소문자는 기둥이 위로, 대문자는 아래로
    "flags": {"j": 1, "J": 1, "r": 2, "R": 2},
    "accidentals": {"#": 1, "b": -1, "n": 0, "‹": 2, "∫": -2},
    "clefs": {"&": "G", "?": "F", "B": "C", "V": "G8"},
    "dot": ".",
    "fermata": "Uu",
    "time_digits": "0123456789",
    "time_symbols": {"c": (4, 4), "C": (2, 2)},
}

# Sibelius의 Opus는 음표·쉼표·임시표 자리가 Maestro와 같다. 다른 점:
#  - 점음표의 점은 Opus Special 글꼴의 '™' (Opus의 '.'은 스타카토)
#  - 글자 폭이 실제 머리보다 넓어서 머리 폭을 따로 정한다
OPUS = {**MAESTRO, "dot": None, "head_width": 0.34}
OPUS_SPECIAL = {**EMPTY, "dot": "™", "brace": "{"}

# Opus Chords 글꼴의 글자 → 코드 이름 글자
OPUS_CHORDS = {"¨": "b", "©": "#", "‹": "m", ";": "omit", "Œ": "m", "„": "a", "Š": "j", "ˆ": "d",
               "“": "sus", "Ø": "ø", "º": "dim", "&": "+"}


# MuseScore 2의 MScore 글꼴. 샘플(나무위의 천사)에서 확인한 것: 머리·쉼표(온·2분·4분·8분)·샵·점·꼬리(8분)·음자리표·페르마타.
# 제자리표·플랫·16분 꼬리·16분쉼표는 글꼴의 순서로 짐작한 값이라 해당 악보가 생기면 확인해야 한다.
MSCORE2 = {
    **EMPTY,
    "heads": {"\ue12d": "black", "\ue12c": "half", "\ue12b": "whole"},
    "rests": {"\ue100": F(4), "\ue101": F(2), "\ue107": F(1), "\ue109": F(1, 2), "\ue10a": F(1, 4), "\ue10b": F(1, 8)},
    "whole_rest": "\ue100",
    "flags": {"\ue190": 1, "\ue191": 2, "\ue192": 3, "\ue194": 1, "\ue195": 2, "\ue196": 3},
    "accidentals": {"\ue10e": 1, "\ue113": 0, "\ue11a": -1},
    "clefs": {"\ue19e": "G", "\ue19c": "F"},
    "dot": "\ue127",
    "fermata": "\ue158\ue159",
    "time_digits": "0123456789",
}

# SMuFL: 요즘 음악 글꼴의 공통 표준 (MuseScore 3·4, Dorico, 새 Finale·Sibelius의 Bravura·Leland 등).
# 표준 문서의 번호를 그대로 옮긴 것. MuseScore 4로 뽑은 PDF(Leland, Bravura, Emmentaler, Petaluma)로 정답 대조를 했다 (tools/truth_check.py).
# Bravura·Petaluma는 MuseScore에서 '큰 머리' 변형 글자(U+F4BC~F4BE)로 찍힌다.
SMUFL = {
    **EMPTY,
    "heads": {"\ue0a4": "black", "\ue0a3": "half", "\ue0a2": "whole", "\uf4be": "black", "\uf4bd": "half", "\uf4bc": "whole"},
    "rests": {"\ue4e3": F(4), "\ue4e4": F(2), "\ue4e5": F(1), "\ue4e6": F(1, 2), "\ue4e7": F(1, 4), "\ue4e8": F(1, 8)},
    "whole_rest": "\ue4e3",
    "flags": {"\ue240": 1, "\ue241": 1, "\ue242": 2, "\ue243": 2, "\ue244": 3, "\ue245": 3},
    "accidentals": {"\ue262": 1, "\ue260": -1, "\ue261": 0, "\ue263": 2, "\ue264": -2},
    "clefs": {"\ue050": "G", "\ue052": "G8", "\ue062": "F", "\ue05c": "C"},
    "dot": "\ue1e7",
    "fermata": "\ue4c0\ue4c1",
    "time_digits": "".join(chr(0xE080 + i) for i in range(10)),
    "digit_map": {chr(0xE080 + i): str(i) for i in range(10)},
    "time_symbols": {"\ue08a": (4, 4), "\ue08b": (2, 2)},
    "brace": "\ue000",
}


def family(font):
    f = font.replace("-", "").replace(" ", "")
    for suffix in ("Std", "Regular", "Roman"):
        if f.endswith(suffix):
            f = f[:-len(suffix)]
    return f


FONT_MAPS = {"Maestro": MAESTRO, "MaestroWide": MAESTRO, "Opus": OPUS, "OpusSpecial": OPUS_SPECIAL,
             "MScore": MSCORE2}
_LEARNED = {}                     # 이름을 모르는 글꼴: 들어 있는 글자를 보고 정한 대응표
CHORD_FONTS = {"OpusChords": OPUS_CHORDS}
TUPLET_FONTS = ("OpusText",)


def music_map(font):
    f = family(font)
    return _LEARNED.get(f) or FONT_MAPS.get(f)


def learn_fonts(counts):
    """counts: {글꼴 이름: {글자: 개수}}. 이름으로는 모르는 글꼴이라도
    음표 머리 글자가 많이 들어 있으면 그 배열(SMuFL 표준 / Finale식 옛 배열)의 음악 글꼴로 본다."""
    _LEARNED.clear()
    for font, cnt in counts.items():
        f = family(font)
        if f in CHORD_FONTS:
            continue
        smufl_heads = cnt.get("\ue0a4", 0) + cnt.get("\uf4be", 0)
        if f in FONT_MAPS:
            # 이름은 같아도 배열이 다른 경우: MuseScore 3·4의 Emmentaler는 글꼴 이름이 'MScore'지만 표준(SMuFL) 번호를 쓴다
            if smufl_heads >= 8:
                _LEARNED[f] = SMUFL
            continue
        total = sum(cnt.values())
        if smufl_heads >= 8:
            _LEARNED[f] = SMUFL
        elif cnt.get("œ", 0) >= 8 and cnt.get("œ", 0) > 0.2 * total:
            _LEARNED[f] = MAESTRO


def chord_map(font):
    return CHORD_FONTS.get(family(font))


def is_music_font(font):
    if family(font) in _LEARNED:
        return True
    f = font.lower()
    return any(k in f for k in ("maestro", "engraver", "opus", "bravura", "mscore", "emmentaler", "petrucci", "sonata"))


def normalize(t):
    """일부 PDF는 음악 글꼴 글자를 사용자 영역(U+F000대)에 넣는다 → 원래 글자로."""
    if len(t) == 1 and 0xF000 <= ord(t) <= 0xF0FF:
        return bytes([ord(t) - 0xF000]).decode("mac_roman", "replace")
    return t
