// "인터넷 없이 쓸 준비가 됐는지" 확인한다: 서비스 워커(sw.js)가 기기에 저장해 둔 파일 목록에 필요한 것이 다 있는지 본다.
// 필요한 것: 분석 엔진(새 악보를 읽을 때), 악보 화면 도구(pdf.js), 피아노 소리 30개. 이미 읽어 둔 곡을 여는 데는 엔진이 필요 없다.
import { SAMPLE_BASE, SAMPLE_FILES } from "./audio.js";

// 있어야 하는 파일: 주소의 끝부분(파일 이름), "-"로 끝나는 것은 이름의 앞부분(뒤에 판 번호가 붙는다).
// 엔진 = Pyodide 본체 + PDF 읽는 도구(pdfminer)와 그것이 끌어오는 꾸러미들 + 우리 엔진 파일.
// (engine-worker.js 의 Pyodide 판을 올리면 끌려오는 꾸러미가 달라질 수 있으니 이 목록을 다시 확인한다.)
const ENGINE = ["pyodide.js", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json",
  "micropip-", "packaging-", "pdfminer_six-", "charset_normalizer-", "cryptography-", "cffi-", "pycparser-",
  ...["__init__", "prims", "glyphs", "layout", "notes", "marks", "reader", "export"].map((f) => "engine/pdfscore/" + f + ".py")];
// 악보 화면 도구(pdf.js). 4판은 iOS 16.4(2023년 3월)보다 오래된 아이폰·아이패드의 Safari가 모르는 문법(class 안의 "static { … }")을 써서
// 그런 기기에서는 불러오다 멈춘다(악보가 열리지 않는다) → 그 문법을 모르는 브라우저에서는 그 문법을 쓰지 않는 3판을 쓴다.
// 시험용 손잡이: 주소에 ?pdfjs3 을 붙이면 새 브라우저에서도 3판을 쓴다.
export const MODERN_SYNTAX = (() => { try { new Function("class A { static { } }"); return true; } catch (err) { return false; } })();
const OLD_PDFJS = !MODERN_SYNTAX || (() => { try { return new URLSearchParams(location.search).has("pdfjs3"); } catch (err) { return false; } })();
export const PDFJS_LIB = OLD_PDFJS
  ? { base: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/", main: "pdf.min.js", worker: "pdf.worker.min.js", module: false }
  : { base: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/", main: "pdf.min.mjs", worker: "pdf.worker.min.mjs", module: true };
const PDFJS = [PDFJS_LIB.main, PDFJS_LIB.worker];

export const needed = () => ({ engine: ENGINE.slice(), pdfjs: PDFJS.slice(), piano: SAMPLE_FILES.slice() });

// urls: 저장되어 있는 주소들 → { engine, pdfjs, piano: {have, need, ok, missing}, ready }
export function check(urls) {
  const paths = urls.map((u) => { try { return new URL(u).pathname; } catch (err) { return String(u); } });
  const has = (frag) => paths.some((p) => (frag.endsWith("-") ? p.includes("/" + frag) : p.endsWith("/" + frag)));
  const part = (list) => { const missing = list.filter((f) => !has(f)); return { have: list.length - missing.length, need: list.length, ok: !missing.length, missing }; };
  const out = { engine: part(ENGINE), pdfjs: part(PDFJS), piano: part(SAMPLE_FILES) };
  out.ready = out.engine.ok && out.pdfjs.ok && out.piano.ok;
  return out;
}

// 지금 이 기기의 상태. supported: false 면 이 브라우저·주소에서는 저장해 두는 기능 자체를 쓸 수 없다 (예: 집 와이파이의 http 주소)
export async function status() {
  if (typeof caches === "undefined" || !("serviceWorker" in navigator)) return { supported: false };
  const urls = [];
  for (const name of await caches.keys()) {
    if (!name.startsWith("score-app-")) continue;
    for (const r of await (await caches.open(name)).keys()) urls.push(r.url);
  }
  return { supported: true, active: !!navigator.serviceWorker.controller, ...check(urls) };
}

// 빠진 것을 받아 둔다. warmEngine(): 분석 엔진을 한 번 켜 보는 함수(켜지는 동안 받는 파일이 저장된다). pdfjsBase: pdf.js 주소
export async function prepare({ pdfjsBase = PDFJS_LIB.base, warmEngine, onProgress = () => {} }) {
  const st = await status();
  if (!st.supported) throw new Error("이 주소에서는 인터넷 없이 쓰기를 준비할 수 없어요");
  const jobs = [...st.pdfjs.missing.map((f) => pdfjsBase + f), ...st.piano.missing.map((f) => SAMPLE_BASE + f)];
  let done = 0;
  for (const url of jobs) {
    onProgress(`받아 두는 중… ${done}/${jobs.length}`);
    const r = await fetch(url);                                      // 받기만 하면 서비스 워커가 저장한다
    if (!r.ok) throw new Error("받지 못한 파일이 있어요: " + url.split("/").pop());
    await r.arrayBuffer();
    done++;
  }
  if (!st.engine.ok) { onProgress("분석 엔진을 받아 두는 중…"); await warmEngine(); }
  return status();
}
