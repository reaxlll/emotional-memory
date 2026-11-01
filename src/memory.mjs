/**
 * memory.mjs — 一堆「经历」存在一个 JSONL 里，怎么翻。
 *
 * 一条经历长这样（字段名可以自己换，配置里反正能映射）：
 *   { "id": "...", "d": "2026-11-01", "t": "17:03",
 *     "said": "他说了什么", "did": "我做了什么", "think": "当时怎么想",
 *     "affect": [{ "name": "沉", "v": -0.6, "a": 0.55 }],
 *     "tags": ["情绪", "公式"] }
 *
 * 这里故意不绑向量库：检索用词频，够快、够透明、没依赖。
 * 真需要语义检索，把 recall() 换掉就行，接口不变。
 */

import fs from "node:fs";
import path from "node:path";

export function openLibrary(file) {
  const entries = [];
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try { entries.push(JSON.parse(s)); } catch { /* 半行就跳过，别让一行坏掉整库 */ }
    }
  }
  entries.sort((a, b) => key(a) < key(b) ? -1 : 1);
  const byId = Object.fromEntries(entries.map(e => [e.id, e]));
  return { file, entries, byId };
}

export const key = e => String(e.d || "") + " " + String(e.t || "00:00");

export function append(lib, entry) {
  if (!entry.id) throw new Error("entry 必须有 id");
  if (lib.byId[entry.id]) return false;
  fs.appendFileSync(lib.file, JSON.stringify(entry) + "\n", "utf8");
  lib.entries.push(entry);
  lib.byId[entry.id] = entry;
  return true;
}

const iso = (d) => d.toLocaleDateString("sv-SE");

/** 按天查。date 可以是 YYYY-MM-DD、today、yesterday，或者 evening（前一天 20:00 → 今天 06:00）。 */
export function byDate(lib, date, { limit = 20 } = {}) {
  const now = new Date();
  const yday = new Date(now); yday.setDate(yday.getDate() - 1);
  let d = String(date || "").trim().toLowerCase();
  let lo, hi, label;
  if (/^(evening|last-?night|昨晚|夜里|昨天晚上)$/.test(d)) {
    lo = iso(yday) + " 20:00"; hi = iso(now) + " 06:00";
    label = iso(yday) + " 20:00 → " + iso(now) + " 06:00";
  } else {
    if (/today|今天/.test(d)) d = iso(now);
    else if (/yesterday|昨天/.test(d)) d = iso(yday);
    lo = d + " 00:00"; hi = d + " 23:59"; label = d;
  }
  const list = lib.entries.filter(e => key(e) >= lo && key(e) <= hi);
  return { label, total: list.length, items: list.slice(0, limit) };
}

// ── 检索：中文按 2-gram 切，英文按词切；命中越稀有越值钱
function grams(s) {
  const text = String(s || "").toLowerCase();
  const out = new Set();
  for (const w of text.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  const han = text.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const run of han) {
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
    if (run.length === 1) out.add(run);
  }
  return out;
}

function index(lib) {
  const df = new Map();
  const docs = lib.entries.map(e => {
    const body = [e.said, e.did, e.think, e.summary, (e.tags || []).join(" ")].join(" ");
    const g = grams(body);
    for (const t of g) df.set(t, (df.get(t) || 0) + 1);
    return { e, g };
  });
  return { df, docs, N: docs.length };
}

/** 关键词召回。about 是主题词，want 是「我要什么形状」——用自然语言再提一次，权重低一点。 */
export function recall(lib, { about = "", want = "", n = 4 } = {}) {
  const { df, docs, N } = index(lib);
  const qa = grams(about), qw = grams(want);
  const idf = t => Math.log(1 + N / (1 + (df.get(t) || 0)));
  const scored = docs.map(({ e, g }) => {
    let s = 0;
    for (const t of qa) if (g.has(t)) s += idf(t) * 2;
    for (const t of qw) if (g.has(t)) s += idf(t) * 0.5;
    for (const t of e.tags || []) if (about && String(t).includes(about)) s += 3;
    return { e, s };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  return scored.slice(0, n);
}

/** 一件事在库里有多厚：多少条、跨几天、带多少情绪 */
export function shape(lib, { about = "" } = {}) {
  const list = about
    ? recall(lib, { about, n: 9999 }).map(x => x.e)
    : lib.entries.slice();
  if (!list.length) return null;
  const days = new Set(list.map(e => e.d));
  const withF = list.filter(e => Array.isArray(e.affect) ? e.affect.length : e.Fs && e.Fs.length);
  const names = {};
  for (const e of withF) {
    const f = Array.isArray(e.affect) ? e.affect[0] : e.Fs[0];
    if (f && f.name) names[f.name] = (names[f.name] || 0) + 1;
    else if (f && f.f) names[f.f] = (names[f.f] || 0) + 1;
  }
  return {
    count: list.length,
    days: days.size,
    withAffect: withF.length,
    top: Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 5),
    from: list[0].d, to: list[list.length - 1].d,
  };
}
