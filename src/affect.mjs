/**
 * affect.mjs — 从一串带情绪标记的事件里，算出「此刻是什么状态」。
 *
 * 心法：情绪不是一个数，是三个东西叠出来的
 *   1. 基线   —— 最近这些日子我大概是个什么温度（指数加权，不是平均）
 *   2. 上轮   —— 刚才那下还剩多少（双指数余温）
 *   3. 来路   —— 从上头降下来、从坑里爬上来，说出来的话不一样
 *
 * 数据只有一个轴是真的（效价 v）。唤醒 a 常常是随手填的中庸值，
 * 所以这里不直接用 a，而是用「动量」「极值」「刚发生」三个客观量把它撑开。
 */

export const DEFAULT_CONFIG = {
  // ① 基线：记忆半衰（小时）
  halfLifeHours: 48,
  // ② 余温：双指数，快支 + 长尾
  fade: { weight: 0.6, fast: 8, slow: 30 },
  // 没数据时往哪边收缩（等效先验条数）
  prior: { v: 0.05, a: 0.45, weight: 3 },
  // ④ 动量：最近几条的加权斜率，再乘时间衰减
  momentum: { window: 4, halfLife: 6, clamp: 0.4 },
  // ③ 唤醒代偿
  arousal: { fromMomentum: 2.0, fromValue: 0.7, base: 0.1, burstHours: 0.5, burst: 0.15 },
  // ⑦ 档位：v 用分位切五带，a 用分位切三档
  vQuantiles: [0.2, 0.4, 0.6, 0.8],
  aQuantiles: [0.33, 0.67],
  // ⑤ 形状判定
  shape: { jump: 0.45, jumpHours: 2, swing: 0.25, swingLow: -0.2, swingHours: 6, warmDays: 3, warmLow: -0.15 },
  // 迟滞：同一格至少挂这么久才许翻
  hysteresisMinutes: 40,
  tensionHot: 0.25,
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** 把事件统一成 { t, v, a, name }。事件可以是单情绪，也可以是多情绪（取均值＝净向）。 */
export function normalize(entries, { calibrate = {} } = {}) {
  const out = [];
  for (const e of entries) {
    const t = e.t instanceof Date ? e.t.getTime() : Number(e.t);
    if (!Number.isFinite(t)) continue;
    const affects = Array.isArray(e.affect) ? e.affect : e.affect ? [e.affect] : [];
    if (!affects.length) continue;
    const vs = affects.map(f => (calibrate[f.name] !== undefined ? calibrate[f.name] : Number(f.v))).filter(Number.isFinite);
    const as = affects.map(f => Number(f.a)).filter(Number.isFinite);
    if (!vs.length) continue;
    out.push({
      t,
      v: vs.reduce((x, y) => x + y, 0) / vs.length,
      a: as.length ? as.reduce((x, y) => x + y, 0) / as.length : 0.45,
      names: affects.map(f => f.name),
      meta: e.meta || {},
    });
  }
  return out.sort((x, y) => x.t - y.t);
}

const quantile = (arr, q) => {
  const s = arr.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * q)))];
};

/** 算某个时刻的状态。entries 必须是 normalize() 之后、且按时间排好序的。 */
export function stateAt(entries, now, cfg = DEFAULT_CONFIG) {
  const upto = entries.filter(e => e.t <= now);
  if (!upto.length) return null;

  // ① 基线
  let sw = 0, sv = 0, sa = 0;
  for (const e of upto) {
    const w = Math.exp(-(now - e.t) / 3.6e6 / cfg.halfLifeHours);
    sw += w; sv += w * e.v; sa += w * e.a;
  }
  const V = (sv + cfg.prior.weight * cfg.prior.v) / (sw + cfg.prior.weight);
  const A = (sa + cfg.prior.weight * cfg.prior.a) / (sw + cfg.prior.weight);

  // ② 上轮 + 双指数余温
  const last = upto[upto.length - 1];
  const h = (now - last.t) / 3.6e6;
  const rho = cfg.fade.weight * Math.exp(-h / cfg.fade.fast)
            + (1 - cfg.fade.weight) * Math.exp(-h / cfg.fade.slow);
  const v = V + (last.v - V) * rho;
  const a = A + (last.a - A) * rho;

  // ④ 动量（带时间衰减，17 小时前的暴跌不该还叫「现在坐不住」）
  const tail = upto.slice(-cfg.momentum.window);
  let mn = 0, md = 0;
  for (let i = 1; i < tail.length; i++) {
    const dv = tail[i].v - tail[i - 1].v;
    const dt = Math.max((tail[i].t - tail[i - 1].t) / 3.6e6, 0.05);
    mn += i * dv / dt; md += i;
  }
  const m = clamp((md ? mn / md / 10 : 0) * Math.exp(-h / cfg.momentum.halfLife), -cfg.momentum.clamp, cfg.momentum.clamp);

  // ③ 唤醒代偿：模型给的 a 只会是中庸值，用动量、极值、刚发生把住它
  let aEff = Math.max(a, Math.abs(m) * cfg.arousal.fromMomentum, Math.abs(v) * cfg.arousal.fromValue + cfg.arousal.base);
  if (h < cfg.arousal.burstHours) aEff += cfg.arousal.burst;
  aEff = clamp(aEff, 0, 1);

  return { v, a, aEff, m, h, V, A, rho, last, tension: Math.abs(last.v - V) };
}

/** ⑤ 形状：突变 / 反差 / 回暖。强覆盖档位，因为它描述的是「刚刚发生了什么」。 */
export function shapeAt(entries, now, cfg = DEFAULT_CONFIG) {
  const upto = entries.filter(e => e.t <= now);
  if (upto.length < 2) return null;
  const a = upto[upto.length - 1], b = upto[upto.length - 2];
  const h = (now - a.t) / 3.6e6;
  if (h > cfg.shape.jumpHours) return null;          // 形状只在刚发生时有意义

  const dv = a.v - b.v, dt = (a.t - b.t) / 3.6e6;
  if (dv >= cfg.shape.jump && dt < cfg.shape.jumpHours) return "surge";
  if (dv <= -cfg.shape.jump && dt < cfg.shape.jumpHours) return "break";

  const recent = upto.filter(e => now - e.t <= cfg.shape.swingHours * 3.6e6);
  if (recent.length >= 2) {
    const hi = recent.filter(e => e.v > cfg.shape.swing);
    const lo = recent.filter(e => e.v < cfg.shape.swingLow);
    if (hi.length && lo.length && Math.min(...hi.map(e => e.t)) < Math.max(...lo.map(e => e.t))) return "flip";
  }
  const span = upto.filter(e => now - e.t <= cfg.shape.warmDays * 864e5);
  if (span.length >= 3) {
    const head = span.slice(0, -2), tail = span.slice(-2);
    if (head.length && head.reduce((s, e) => s + e.v, 0) / head.length < cfg.shape.warmLow && tail.every(e => e.v > 0.05)) return "warm";
  }
  return null;
}

/**
 * ⑦ 档位：阈值跟着数据自己的分布走，不拍脑袋。
 * 数据太少时（<20 条）分位数没有意义，退回一组固定边界。
 */
export function bands(entries, cfg = DEFAULT_CONFIG) {
  if (entries.length < 20) {
    return { v: [-0.35, -0.12, 0.12, 0.35], a: [0.45, 0.60], derived: false };
  }
  return {
    v: cfg.vQuantiles.map(q => quantile(entries.map(e => e.v), q)),
    a: cfg.aQuantiles.map(q => quantile(entries.map(e => e.a), q)),
    derived: true,
  };
}

export function bandOf(x, th, names) {
  for (let i = 0; i < th.length; i++) if (x < th[i]) return names[i];
  return names[names.length - 1];
}
