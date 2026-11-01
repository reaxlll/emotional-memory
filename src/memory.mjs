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
import { cos, descend } from "./tree.mjs";
import { matchAlias } from "./aliases.mjs";

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

function buildIndex(lib) {
  const df = new Map();
  const docs = lib.entries.map(e => {
    const body = [e.said, e.did, e.think, e.summary, (e.tags || []).join(" ")].join(" ");
    const g = grams(body);
    for (const t of g) df.set(t, (df.get(t) || 0) + 1);
    return { e, g };
  });
  return { df, docs, N: docs.length };
}

// 索引建一次就够：库里有一千七百多条，每问一句重算一遍词频表是白烧 CPU。
// 用条数当版本号——append 之后条数变了就重建。
const _idx = new WeakMap();
function index(lib) {
  const c = _idx.get(lib);
  if (c && c.N === lib.entries.length) return c;
  const fresh = buildIndex(lib);
  _idx.set(lib, fresh);
  return fresh;
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

// ── 语义检索：向量 + 树 + 别名，三样都是可选的 ──
//
// 纯词频那条路留着（recall 上面那个），因为它没依赖、够快、出问题好查。
// 下面这条路多三件事：
//   ① 别名表：他说过一个词，指的不是字面意思，直接跳过去
//   ② 树：一千多条里先挑两本「书」，再逐层往下翻到二十几条
//   ③ 语义：向量余弦，配上词频一起打分
//
// 三样都可以不给。给多少用多少。

const SEM_FLOOR = 0.35, SEM_SPAN = 0.32;   // 余弦 < 0.35 当 0 分，0.67 当满分

/**
 * @param {object} lib
 * @param {object} o
 * @param {string} o.about           主题词
 * @param {string} [o.want]          你要什么形状，用自己的话写
 * @param {number} [o.n]             要几条
 * @param {(t:string)=>Promise<Float32Array>} [o.embed]  把文本变向量；不给就退化成词频
 * @param {Map<string,Float32Array>} [o.vectors]         id → 向量
 * @param {object} [o.tree]          buildTree() 之后 hydrate() 过的树
 * @param {Array}  [o.aliases]       loadAliases() 的结果
 * @param {string[]} [o.affectWords] 情绪词表；给了就走情绪通道
 * @param {number} [o.books]         一次挑几本书，默认 2（1 本会漏）
 */
export async function recallSemantic(lib, o = {}) {
  const { about = "", want = "", n = 4, embed, vectors, tree, aliases = [],
    affectWords = [], books = 2 } = o;
  const q = (about + " " + want).trim();
  const picked = [];
  const taken = new Set();

  // ① 别名通道：不跟向量算，直接跳
  if (aliases.length) {
    for (const h of matchAlias(aliases, q)) {
      const e = lib.byId[h.id];
      if (e && !taken.has(h.id)) { picked.push({ e, s: 1.3, why: "别名「" + h.word + "」" }); taken.add(h.id); }
    }
  }

  // ② 情绪通道：「什么时候最沉」这种问法，语义只会捞回「讲沉的分析」，捞不回真的沉
  if (affectWords.length) {
    const word = pickAffectWord(q, affectWords);
    if (word) {
      const list = lib.entries
        .filter(e => affectOf(e).some(f => f.name === word))
        .sort((a, b) => Math.min(...affectOf(a).map(f => f.v)) - Math.min(...affectOf(b).map(f => f.v)));
      for (const e of list) {
        if (picked.length >= n) break;
        if (taken.has(e.id)) continue;
        picked.push({ e, s: 1.2, why: "情绪「" + word + "」" }); taken.add(e.id);
      }
    }
  }

  // 没有向量就退回词频，至少还能用
  if (!embed || !vectors) {
    const rest = recall(lib, { about, want, n: n + picked.length });
    for (const x of rest) {
      if (picked.length >= n) break;
      if (taken.has(x.e.id)) continue;
      picked.push({ e: x.e, s: x.s / 100, why: "" }); taken.add(x.e.id);
    }
    return picked.slice(0, n);
  }

  const qv = await embed(q);

  // ③ 树下钻：先挑书，再一层层往下，落在二十几条里
  let pool = lib.entries.filter(e => !taken.has(e.id));
  if (tree && tree.books.length) {
    const leaves = descend(tree, qv, { books, vectors });
    const sets = leaves.map(l => l.set).filter(Boolean);
    if (sets.length) {
      const narrowed = pool.filter(e => sets.some(s => s.has(e.id)));
      if (narrowed.length >= n) pool = narrowed;
    }
  }

  // ④ 精排：语义 + 词频
  const { df, docs, N } = index({ entries: pool });
  const qa = grams(about), qw2 = grams(want);
  const idf = t => Math.log(1 + N / (1 + (df.get(t) || 0)));
  const scored = docs.map(({ e, g }) => {
    const v = vectors.get(e.id);
    const c = v ? cos(qv, v) : -1;
    const sem = Math.max(0, Math.min(1, (c - SEM_FLOOR) / SEM_SPAN));
    let lex = 0;
    let tot = 0;
    for (const t of qa) { tot += idf(t); if (g.has(t)) lex += idf(t); }
    for (const t of qw2) { tot += idf(t) * 0.5; if (g.has(t)) lex += idf(t) * 0.5; }
    lex = tot > 0 ? lex / tot : 0;
    return { e, s: 0.7 * sem + 0.3 * lex, why: "" };
  }).filter(x => x.s > 0.18).sort((a, b) => b.s - a.s);

  for (const x of scored) {
    if (picked.length >= n) break;
    if (taken.has(x.e.id)) continue;
    picked.push(x); taken.add(x.e.id);
  }
  return picked.slice(0, n);
}

/** 情绪名可能叫 affect / Fs，两种都认 */
export function affectOf(e) {
  const a = Array.isArray(e.affect) ? e.affect : (Array.isArray(e.Fs) ? e.Fs : []);
  return a.map(x => ({ name: x.name || x.f, v: Number(x.v) || 0, a: Number(x.a) || 0 })).filter(x => x.name);
}

const DEGREE = "最很太真超特别有点十分非常尤其更";
const PUNCT = /[s，。？！、,.?!]/;

/**
 * 查询里点到某个情绪名就算命中，但单字情绪要防误伤——
 * 「重启」里的「重」不该把情绪「重」勾出来。前后得有程度词、标点或者边界。
 */
export function pickAffectWord(q, words) {
  const text = String(q || "");
  for (const w of [...words].filter(Boolean).sort((a, b) => String(b).length - String(a).length)) {
    let i = 0;
    while ((i = text.indexOf(w, i)) >= 0) {
      if (String(w).length >= 2) return w;
      const prev = text[i - 1] || "", next = text[i + 1] || "";
      const okPrev = !prev || DEGREE.includes(prev) || PUNCT.test(prev);
      const okNext = !next || !/[一-龥]/.test(next) || PUNCT.test(next);
      if (okPrev && okNext) return w;
      i += String(w).length;
    }
  }
  return null;
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
