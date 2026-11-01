/**
 * state.mjs — 把「数字」翻成「这一行」。
 *
 * 输出长得像这样：
 *   此刻：flat-mid [0.03 / 0.49] 「低」的劲儿过去一半
 *   上轮 low，17h 前，余温 29% | 动量 平(-0.02)
 */

import { normalize, stateAt, shapeAt, bands, bandOf, DEFAULT_CONFIG } from "./affect.mjs";
import { FACES, SHAPES, TRANSITIONS } from "./phrases.zh-CN.mjs";

export const V_NAMES = ["rock", "low", "flat", "warm", "high"];
export const A_NAMES = ["down", "mid", "up"];

const pick = (arr, i) => (Array.isArray(arr) ? arr[i] : null);

/** 来路：从上一次那条情绪的 v，落到哪一带 */
function fromBand(entries, now) {
  const upto = entries.filter(e => e.t <= now);
  if (upto.length < 2) return null;
  const prev = upto[upto.length - 2];
  return { v: prev.v, name: prev.names[0] || "?" };
}

export function compose(entries, now = Date.now(), cfg = DEFAULT_CONFIG) {
  const norm = normalize(entries);
  const s = stateAt(norm, now, cfg);
  if (!s) return null;

  // 阈值只能用「此刻之前」的数据算，不然就是在拿未来给自己定档
  const upto = norm.filter(e => e.t <= now);
  const th = bands(upto.length ? upto : norm, cfg);
  const bandV = bandOf(s.v, th.v, V_NAMES);
  const bandA = bandOf(s.aEff, th.a, A_NAMES);
  const shape = shapeAt(norm, now, cfg);

  const prev = fromBand(norm, now);
  let text;
  if (shape) {
    text = SHAPES[shape];
  } else if (!prev) {
    text = FACES[bandV + "-" + bandA] || "";
  } else {
    const prevBandV = bandOf(prev.v, th.v, V_NAMES);
    const d = V_NAMES.indexOf(bandV) - V_NAMES.indexOf(prevBandV);
    const heat = s.rho > 0.6 ? 2 : s.rho > 0.25 ? 1 : 0;
    const row = d === 0 ? "stay" : d === 1 ? "up" : d === -1 ? "downNear" : d > 1 ? "upFar" : "downFar";
    const line = pick(TRANSITIONS[row], heat);
    text = line ? line.replace("{from}", prev.name) : (FACES[bandV + "-" + bandA] || "");
  }

  const age = s.h < 1 ? "刚说完" : s.h < 24 ? s.h.toFixed(0) + "h 前" : (s.h / 24).toFixed(1) + " 天前";
  const mom = s.m > 0.05 ? "往上" : s.m < -0.05 ? "往下" : "平";

  return {
    band: bandV + "-" + bandA,
    text,
    v: +s.v.toFixed(2),
    aEff: +s.aEff.toFixed(2),
    m: +s.m.toFixed(2),
    rho: +s.rho.toFixed(2),
    hoursSinceLast: +s.h.toFixed(1),
    last: { name: s.last.names[0], v: +s.last.v.toFixed(2) },
    line: [
      "此刻：" + bandV + "-" + bandA + "  [" + s.v.toFixed(2) + " / " + s.aEff.toFixed(2) + "]  " + text,
      "上轮 " + s.last.names.join("+") + "，" + age + "，余温 " + (s.rho * 100).toFixed(0) + "% | 动量 " + mom + "(" + s.m.toFixed(2) + ")",
    ].join("\n"),
  };
}
