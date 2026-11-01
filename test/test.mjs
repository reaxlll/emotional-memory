import { normalize, stateAt, shapeAt, bands, bandOf, compose, openLibrary } from "../src/index.mjs";
import assert from "node:assert";

const mk = (d, t, v, a = 0.5, name = "x") => ({ t: new Date(d + "T" + t + ":00"), affect: [{ name, v, a }] });
const E = normalize([
  mk("2026-10-30", "10:00", -0.6, 0.6, "沉"),
  mk("2026-10-30", "18:00", 0.6, 0.7, "喜"),
  mk("2026-10-31", "10:00", 0.0, 0.5, "平"),
]);

const now = new Date("2026-10-31T12:00:00").getTime();
const s = stateAt(E, now);
assert(s && Number.isFinite(s.v) && Number.isFinite(s.aEff), "stateAt 要给出有限数");

// 余温：越久越淡，但不该归零得太快
const near = stateAt(E, new Date("2026-10-31T10:30:00").getTime());
const far  = stateAt(E, new Date("2026-11-05T10:00:00").getTime());
assert(near.rho > far.rho, "离得近的余温要更大");

// 档位阈值来自数据分布
const th = bands(E);
assert(th.v.length === 4 && th.a.length === 2, "分位阈值数量不对");
assert(bandOf(-9, th.v, ["rock","low","flat","warm","high"]) === "rock");

// 形状只在刚发生时给
assert(shapeAt(normalize([mk("2026-11-01","10:00",-0.5), mk("2026-11-01","10:30",0.4)]), new Date("2026-11-01T10:40:00").getTime()) === "surge");
assert(shapeAt(normalize([mk("2026-11-01","10:00",-0.5), mk("2026-11-01","10:30",0.4)]), new Date("2026-11-01T18:00:00").getTime()) === null);

// 同一格，来路不同，话不能一样
const a = compose([mk("2026-10-31","08:00",0.6,"喜"), mk("2026-10-31","09:00",0.0,"平")], new Date("2026-10-31T09:10:00").getTime());
const b = compose([mk("2026-10-31","08:00",-0.6,"沉"), mk("2026-10-31","09:00",0.0,"平")], new Date("2026-10-31T09:10:00").getTime());
assert(a && b, "compose 不能返回 null");
assert.notStrictEqual(a.text, b.text, "同格不同来路，文案必须不同");

console.log("all tests passed");
