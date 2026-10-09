// 악보 분석 엔진. 파이썬으로 쓴 pdfscore를 브라우저 안(Pyodide)에서 그대로 돌린다.
// 악보 파일은 기기 밖으로 나가지 않는다. 처음 한 번만 엔진을 내려받고, 그 뒤로는 저장해 둔 것을 쓴다.
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const FILES = ["__init__.py", "prims.py", "glyphs.py", "layout.py", "notes.py", "marks.py", "reader.py", "export.py"];
let ready = null;

const say = (id, text) => postMessage({ id, progress: text });

async function init(id) {
  say(id, "분석 엔진을 준비하고 있어요 (처음 한 번만 조금 걸려요)");
  importScripts(PYODIDE + "pyodide.js");
  const py = await loadPyodide({ indexURL: PYODIDE });
  say(id, "PDF 읽는 도구를 준비하고 있어요");
  await py.loadPackage("micropip");
  await py.runPythonAsync('import micropip\nawait micropip.install("pdfminer.six")');
  py.FS.mkdirTree("/app/pdfscore");
  for (const f of FILES) {
    const res = await fetch("engine/pdfscore/" + f);
    if (!res.ok) throw new Error("엔진 파일을 찾지 못했어요: " + f);
    py.FS.writeFile("/app/pdfscore/" + f, await res.text());
  }
  py.runPython('import sys, json\nsys.path.insert(0, "/app")\nfrom pdfscore import reader, export');
  return py;
}

onmessage = async (e) => {
  const { id, bytes, title } = e.data;
  try {
    ready = ready || init(id);
    const py = await ready;
    say(id, "악보를 읽고 있어요");
    py.globals.set("pdf_bytes", bytes);
    py.globals.set("title", title);
    const out = py.runPython(
      "import hashlib\nraw = bytes(pdf_bytes.to_py())\nscore = reader.read_pdf(raw)\n" +
      'json.dumps({"sha256": hashlib.sha256(raw).hexdigest(), "song": export.to_song(score, title), "stats": export.stats(score), "kind": score.kind(), "program": score.program(), "fonts": sorted(score.all_music_fonts)}, ensure_ascii=False)'
    );
    postMessage({ id, result: JSON.parse(out) });
  } catch (err) {
    if (!ready || String(err).includes("엔진")) ready = null;
    postMessage({ id, error: String(err && err.message || err) });
  }
};
