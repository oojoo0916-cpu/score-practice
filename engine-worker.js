// 악보 분석 엔진. 파이썬으로 쓴 pdfscore를 브라우저 안(Pyodide)에서 그대로 돌린다.
// 악보 파일은 기기 밖으로 나가지 않는다. 처음 한 번만 엔진을 내려받고, 그 뒤로는 저장해 둔 것을 쓴다.
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
// PDF 읽는 도구의 판. PC에서 엔진 시험을 돌리는 판과 같게 둔다 (tests/test_versions.py 가 확인한다).
// 이 값이나 PYODIDE 를 바꾸면 sw.js 의 저장소 이름(CACHE) 숫자도 같이 올리고, sw.js 의 PINS 도 같은 판으로 맞춘다.
const PDFMINER = "20260107";
const FILES = ["__init__.py", "prims.py", "glyphs.py", "layout.py", "notes.py", "marks.py", "reader.py", "export.py"];
let ready = null;

// 진행 안내. phase: "init" = 엔진을 준비하는 중, "read" = 악보를 읽는 중 (앱이 단계마다 기다리는 시간을 따로 잰다).
// pages: 읽기 시작을 알릴 때 악보의 쪽 수 (앱이 기다리는 시간을 쪽 수에 맞춘다. 0 = 모름)
const say = (id, text, phase = "init", pages) => postMessage({ id, progress: text, phase, ...(pages === undefined ? {} : { pages }) });

async function init(id) {
  say(id, "분석 엔진을 준비하고 있어요 (처음 한 번만 조금 걸려요)");
  importScripts(PYODIDE + "pyodide.js");
  const py = await loadPyodide({ indexURL: PYODIDE });
  say(id, "PDF 읽는 도구를 준비하고 있어요");
  await py.loadPackage("micropip");
  await py.runPythonAsync(`import micropip\nawait micropip.install("pdfminer.six==${PDFMINER}")`);
  py.FS.mkdirTree("/app/pdfscore");
  for (const f of FILES) {
    const res = await fetch("engine/pdfscore/" + f);
    if (!res.ok) throw new Error("엔진 파일을 찾지 못했어요: " + f);
    py.FS.writeFile("/app/pdfscore/" + f, await res.text());
  }
  py.runPython('import sys, json\nsys.path.insert(0, "/app")\nfrom pdfscore import reader, export, prims');
  return py;
}

onmessage = async (e) => {
  const { id, bytes, title, warm } = e.data;      // warm: 악보 없이 엔진만 켜 본다 ("인터넷 없이 쓰기" 준비용)
  let py;
  const mine = ready = ready || init(id);
  try {
    py = await mine;
  } catch (err) {
    // 준비가 실패했으면(인터넷이 잠깐 끊겼다 등) 실패한 채로 남겨 두지 않는다 → 다음 업로드에서 처음부터 다시 준비한다
    if (ready === mine) ready = null;
    postMessage({ id, error: String(err && err.message || err) });
    return;
  }
  if (warm) { postMessage({ id, result: { warm: true } }); return; }
  try {
    py.globals.set("pdf_bytes", bytes);
    py.globals.set("title", title);
    let pages = 0;                                // 쪽 수를 못 세도 읽기는 계속한다
    try { pages = Number(py.runPython("raw = bytes(pdf_bytes.to_py())\nprims.page_count(raw)")) || 0; } catch (err) { pages = 0; }
    say(id, pages ? `악보를 읽고 있어요 (${pages}쪽)` : "악보를 읽고 있어요", "read", pages);
    const out = py.runPython(
      "import hashlib\nraw = bytes(pdf_bytes.to_py())\nscore = reader.read_pdf(raw)\n" +
      'json.dumps({"sha256": hashlib.sha256(raw).hexdigest(), "song": export.to_song(score, title), "stats": export.stats(score), "kind": score.kind(), "program": score.program(), "fonts": sorted(score.all_music_fonts)}, ensure_ascii=False)'
    );
    postMessage({ id, result: JSON.parse(out) });
  } catch (err) {
    postMessage({ id, error: String(err && err.message || err) });      // 악보 하나를 읽다 난 오류: 엔진은 그대로 쓴다
  }
};
