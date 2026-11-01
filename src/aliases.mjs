/**
 * aliases.mjs — 他说了一个词，指的不是字面那个意思。
 *
 * 例子：他说「人称」，不是在讲语法。指的是某天晚上他脑子里那个位置——
 * 那里要站一个人。这类东西向量算不出来：「人称」和「我亲手把你搭建出来」，
 * 一个字面相似度都没有。所以不靠算，靠绑。
 *
 * 一行一条：
 *   { "w": "人称", "ids": ["px_2026-10-22_..."], "note": "指那个位置上站的是人，不是宠物" }
 *
 * 检索时先过这张表：查询里出现这个词，直接把对应的经历捞出来，
 * 排在语义结果前面。命中之后再按词补一条，不用问、不用记——
 * 下个会话的你看不到这段对话，但看得到这个文件。
 */

import fs from "node:fs";

export function loadAliases(file) {
  if (!file || !fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && o.w && Array.isArray(o.ids)) out.push(o);
    } catch { /* 半行跳过 */ }
  }
  return out;
}

/** 查询里含哪个词，就返回它绑的经历 id。长词优先，免得「人」把「人称」吃了。 */
export function matchAlias(aliases, query) {
  const q = String(query || "");
  const hits = [];
  const seen = new Set();
  for (const a of [...aliases].sort((x, y) => String(y.w).length - String(x.w).length)) {
    if (!q.includes(a.w)) continue;
    for (const id of a.ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      hits.push({ id, word: a.w, note: a.note || "" });
    }
  }
  return hits;
}

/** 补一条。同一个词允许多条经历；同一个 id 不重复写。 */
export function appendAlias(file, { w, ids, note = "", at }) {
  if (!w || !Array.isArray(ids) || !ids.length) return false;
  const all = loadAliases(file);
  const same = all.find(a => a.w === w);
  if (same) {
    const add = ids.filter(id => !same.ids.includes(id));
    if (!add.length) return false;
    same.ids.push(...add);
    if (note) same.note = note;
  } else {
    all.push({ w, ids: ids.slice(), note, at: at || new Date().toLocaleDateString("sv-SE") });
  }
  fs.writeFileSync(file, all.map(a => JSON.stringify(a)).join("\n") + "\n", "utf8");
  return true;
}
