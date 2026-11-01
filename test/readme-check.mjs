import { openLibrary, compose, byDate, recall, shape, DEFAULT_CONFIG } from "../src/index.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = openLibrary(path.join(here, "..", "examples", "sample.jsonl"));

const entries = lib.entries.map(e => ({
  t: new Date(e.d + "T" + e.t + ":00"),
  affect: e.affect,
}));

const now = compose(entries, Date.now());
console.log("band:", now.band);
console.log("text:", now.text);
console.log("line:", JSON.stringify(now.line.split("\n")[0]));

const d = byDate(lib, "2026-10-30");
console.log("byDate ok:", d.label, d.total);

const r = recall(lib, { about: "工作", want: "接口挂了" });
console.log("recall ok:", r.length, r[0] && r[0].e.id);

const s = shape(lib, { about: "工作" });
console.log("shape ok:", JSON.stringify(s));

// calibrate 要用得上
const cal = compose(entries, Date.now(), DEFAULT_CONFIG, { calibrate: { 闷: 0.5 } });
console.log("calibrate ok:", cal.v !== now.v);
