"""PDF 한 쪽에서 글자·선·곡선을 꺼내 다루기 쉬운 모양으로 바꾼다.

좌표는 모두 PDF 포인트(1/72인치), 원점은 쪽의 왼쪽 위.
음악 글꼴 글자의 기준점(ox, oy)이 곧 그 기호의 악보상 위치다 (음표 머리면 머리 중심 높이).
"""
from dataclasses import dataclass, field

from .glyphs import normalize


@dataclass
class Ch:
    t: str
    font: str
    size: float
    x0: float
    x1: float
    top: float
    bottom: float
    ox: float
    oy: float
    used: str = ""          # 어떤 용도로 쓰였는지 (중복 사용 방지·디버그)

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2

    @property
    def w(self):
        return self.x1 - self.x0


@dataclass
class HLine:
    y: float
    x0: float
    x1: float
    lw: float


@dataclass
class VLine:
    x: float
    top: float
    bottom: float
    lw: float
    used: str = ""

    @property
    def len(self):
        return self.bottom - self.top


@dataclass
class Curve:
    x0: float
    x1: float
    top: float
    bottom: float
    fill: bool
    stroke: bool
    path: list            # [('m', (x, y)), ('c', p1, p2, p3), ('l', p), ...]
    pts: list
    used: str = ""


@dataclass
class Rect:
    x0: float
    x1: float
    top: float
    bottom: float
    fill: bool
    stroke: bool


@dataclass
class Prims:
    page: int
    width: float
    height: float
    chars: list = field(default_factory=list)
    hlines: list = field(default_factory=list)
    vlines: list = field(default_factory=list)
    curves: list = field(default_factory=list)
    rects: list = field(default_factory=list)
    images: int = 0             # 쪽을 거의 덮는 큰 그림 수 (스캔 악보 판별용)


def _walk(objs):
    for o in objs:
        if hasattr(o, "_objs"):               # 묶음(그림 틀 등) 안으로 들어간다
            yield from _walk(o._objs)
        else:
            yield o


def pages(source):
    """PDF(파일 경로 또는 bytes)의 쪽마다 Prims를 하나씩 돌려준다.
    pdfminer.six만 쓴다 (순수 파이썬이라 브라우저 안에서도 돈다)."""
    import io
    from pdfminer.converter import PDFPageAggregator
    from pdfminer.layout import LTChar, LTCurve, LTImage, LTLine, LTRect
    from pdfminer.pdfdocument import PDFDocument
    from pdfminer.pdfinterp import PDFPageInterpreter, PDFResourceManager
    from pdfminer.pdfpage import PDFPage
    from pdfminer.pdfparser import PDFParser

    fp = io.BytesIO(source) if isinstance(source, (bytes, bytearray, memoryview)) else open(source, "rb")
    try:
        doc = PDFDocument(PDFParser(fp))
        rm = PDFResourceManager()
        dev = PDFPageAggregator(rm, laparams=None)
        interp = PDFPageInterpreter(rm, dev)
        for page_no, page in enumerate(PDFPage.create_pages(doc), 1):
            interp.process_page(page)
            lt = dev.get_result()
            x_off, y_off = lt.bbox[0], lt.bbox[1]
            W, H = float(lt.width), float(lt.height)
            pr = Prims(page=page_no, width=W, height=H)

            def fx(x):
                return x - x_off

            def fy(yy):
                return H - (yy - y_off)

            for o in _walk(lt):
                if isinstance(o, LTChar):
                    t = normalize(o.get_text() or "")
                    if not t or not t.strip() or t.startswith("(cid:"):
                        continue
                    m = o.matrix
                    font = o.fontname.decode("latin1") if isinstance(o.fontname, bytes) else o.fontname
                    pr.chars.append(Ch(t=t, font=font.split("+")[-1], size=float(o.size),
                                       x0=fx(o.x0), x1=fx(o.x1), top=fy(o.y1), bottom=fy(o.y0),
                                       ox=fx(float(m[4])), oy=fy(float(m[5]))))
                elif isinstance(o, LTImage):
                    if (o.x1 - o.x0) * (o.y1 - o.y0) > 0.3 * W * H:
                        pr.images += 1
                elif isinstance(o, LTLine):
                    x0, x1, top, bottom = fx(o.x0), fx(o.x1), fy(o.y1), fy(o.y0)
                    lw = float(o.linewidth or 0)
                    if abs(top - bottom) < 0.4 and x1 - x0 > 0.4:
                        pr.hlines.append(HLine(y=(top + bottom) / 2, x0=x0, x1=x1, lw=lw))
                    elif abs(x0 - x1) < 0.4:
                        pr.vlines.append(VLine(x=(x0 + x1) / 2, top=top, bottom=bottom, lw=lw))
                elif isinstance(o, LTRect):
                    pr.rects.append(Rect(x0=fx(o.x0), x1=fx(o.x1), top=fy(o.y1), bottom=fy(o.y0),
                                         fill=bool(o.fill), stroke=bool(o.stroke)))
                elif isinstance(o, LTCurve):
                    path = [(seg[0], *[(fx(q[0]), fy(q[1])) for q in seg[1:]]) for seg in (o.original_path or [])]
                    pr.curves.append(Curve(x0=fx(o.x0), x1=fx(o.x1), top=fy(o.y1), bottom=fy(o.y0),
                                           fill=bool(o.fill), stroke=bool(o.stroke), path=path,
                                           pts=[(fx(a), fy(b)) for a, b in o.pts]))
            yield pr
    finally:
        fp.close()
