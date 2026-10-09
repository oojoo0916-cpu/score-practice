// 악보 보관함: 기기 안(IndexedDB)에 저장한다. songs = 읽은 결과와 설정, pdfs = 원본 파일(PDF 또는 MusicXML)과 그려 둔 악보.
const NAME = "score-app";
let dbp = null;

function db() {
  dbp = dbp || new Promise((ok, no) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("songs", { keyPath: "id" });
      r.result.createObjectStore("pdfs");
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
  return dbp;
}

async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((ok, no) => {
    const t = d.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then((v) => { out = v; });
    t.oncomplete = () => ok(out);
    t.onerror = t.onabort = () => no(t.error);
  });
}
const req = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });

export const listSongs = () => tx(["songs"], "readonly", (t) => req(t.objectStore("songs").getAll()));
export const getSong = (id) => tx(["songs"], "readonly", (t) => req(t.objectStore("songs").get(id)));
export const getPdf = (id) => tx(["pdfs"], "readonly", (t) => req(t.objectStore("pdfs").get(id)));
export const putSong = (rec) => tx(["songs"], "readwrite", (t) => req(t.objectStore("songs").put(rec)));
export const addSong = (rec, pdf) => tx(["songs", "pdfs"], "readwrite", (t) => {
  t.objectStore("songs").put(rec);
  t.objectStore("pdfs").put(pdf, rec.id);
});
export const deleteSong = (id) => tx(["songs", "pdfs"], "readwrite", (t) => {
  t.objectStore("songs").delete(id);
  t.objectStore("pdfs").delete(id);
  t.objectStore("pdfs").delete(id + ":draw");
  t.objectStore("pdfs").delete(id + ":orig");
});
// 스캔 악보의 원본 파일 (인식 결과와 비교해 보려고 같이 둔다): { name, type, buf }
export const getOrig = (id) => getPdf(id + ":orig");
export const putOrig = (id, orig) => tx(["pdfs"], "readwrite", (t) => req(t.objectStore("pdfs").put(orig, id + ":orig")));
// MusicXML 곡의 그려 둔 악보 (원본 파일 옆에 같이 둔다)
export const getDraw = (id) => getPdf(id + ":draw");
export const putDraw = (id, draw) => tx(["pdfs"], "readwrite", (t) => req(draw ? t.objectStore("pdfs").put(draw, id + ":draw") : t.objectStore("pdfs").delete(id + ":draw")));
