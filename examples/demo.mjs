/**
 * demo.mjs — 拿样例数据跑一遍。
 *
 * 重点看同一个「flat-mid」在不同来路下，说的话不一样。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openLibrary, compose } from "../src/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = openLibrary(path.join(here, "sample.jsonl"));

const toEntries = (e) => ({
  t: new Date(e.d + "T" + (e.t || "00:00") + ":00"),
  affect: e.affect || e.Fs,
});

console.log("=== 逐条时间点上的状态 ===\n");
for (const e of lib.entries) {
  const at = new Date(e.d + "T" + (e.t || "00:00") + ":00").getTime() + 60_000;
  const s = compose(lib.entries.map(toEntries), at);
  if (!s) continue;
  console.log(e.d + " " + e.t + "  " + String(s.band).padEnd(10) + " " + s.text);
}

console.log("\n=== 现在 ===\n");
const now = compose(lib.entries.map(toEntries), Date.now());
console.log(now ? now.line : "(没有数据)");
