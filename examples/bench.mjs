/**
 * bench.mjs — 把 README 里那张对比表跑出来。
 *
 * 用合成数据（30 天 × 每天 8 条，带随机起伏），对比：
 *   旧法：30 天算术平均 + 4h 单指数余温 + 固定阈值
 *   本法：48h 半衰基线 + 双指数余温 + 分位阈值
 *
 * 输出：切换次数、最常一格占比、状态种类。
 * 数字会随随机种子小幅浮动，量级稳定。
 */

import { normalize, stateAt, bands, bandOf } from "../src/affect.mjs";

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function synthesize(days = 30, perDay = 8) {
  const R = rng(20261101);
  const out = [];
  const start = new Date("2026-10-01T00:00:00+08:00").getTime();
  let level = 0.05;
  for (let d = 0; d < days; d++) {
    for (let k = 0; k < perDay; k++) {
      const t = start + d * 864e5 + (9 * 60 + k * 90) * 60000;
      if (R() < 0.35) continue;                       // 有几天干脆没记录
      level = level * 0.7 + (R() - 0.5) * 0.9;        // 有惯性的游走
      const spike = R() < 0.08 ? (R() < 0.5 ? -0.9 : 0.8) : 0;
      const v = Math.max(-0.9, Math.min(0.8, level + spike));
      const a = 0.5 + (R() - 0.5) * 0.16;             // 大多数人就填这附近
      out.push({ t, affect: [{ name: "x", v, a }] });
    }
  }
  return normalize(out);
}

// ── 旧法
function oldAt(E, T) {
  const win = E.filter(e => e.t <= T && T - e.t <= 30 * 864e5);
  if (!win.length) return null;
  const V = win.reduce((s, e) => s + e.v, 0) / win.length;
  const A = win.reduce((s, e) => s + e.a, 0) / win.length;
  const L = win[win.length - 1];
  const h = (T - L.t) / 3.6e6, r = Math.exp(-h / 4);
  const v = V + (L.v - V) * r, a = A + (L.a - A) * r;
  return (a > 0.70 ? "short" : a > 0.45 ? "mid" : "long") + "|" +
         (v > 0.25 ? "cling" : v < -0.30 ? "hold" : "norm");
}

// ── 本法
const VN = ["rock", "low", "flat", "warm", "high"];
const AN = ["down", "mid", "up"];
function newAt(E, T) {
  const s = stateAt(E, T);
  if (!s) return null;
  const th = bands(E.filter(e => e.t <= T));
  return bandOf(s.v, th.v, VN) + "|" + bandOf(s.aEff, th.a, AN);
}

function stats(E, fn, from, to, stepH = 1) {
  const seq = [];
  for (let T = from; T <= to; T += stepH * 3.6e6) {
    const k = fn(E, T);
    if (k) seq.push(k);
  }
  let switches = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) switches++;
  const cnt = {};
  for (const k of seq) cnt[k] = (cnt[k] || 0) + 1;
  const top = Math.max(...Object.values(cnt));
  return { samples: seq.length, switches, kinds: Object.keys(cnt).length, topShare: (top / seq.length * 100).toFixed(0) + "%" };
}

const E = synthesize();
const from = E[0].t, to = E[E.length - 1].t + 864e5;
console.log("样本：" + E.length + " 条，跨 " + ((to - from) / 864e5).toFixed(0) + " 天\n");

const a = stats(E, oldAt, from, to);
const b = stats(E, newAt, from, to);
const pad = (s, n) => String(s).padEnd(n);
console.log(pad("", 10) + pad("采样", 8) + pad("切换", 8) + pad("状态种类", 10) + "最常一格");
console.log(pad("旧法", 10) + pad(a.samples, 8) + pad(a.switches, 8) + pad(a.kinds, 10) + a.topShare);
console.log(pad("本法", 10) + pad(b.samples, 8) + pad(b.switches, 8) + pad(b.kinds, 10) + b.topShare);
