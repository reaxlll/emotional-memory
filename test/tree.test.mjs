import assert from "node:assert";
import { openLibrary, recallSemantic, pickAffectWord, affectOf } from "../src/index.mjs";
import { buildTree, hydrate, descend, promote, freeze, insert, cos } from "../src/tree.mjs";
import { loadAliases, matchAlias, appendAlias } from "../src/aliases.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "affect-"));
const libFile = path.join(tmp, "exp.jsonl");
const aliasFile = path.join(tmp, "aliases.jsonl");

// ── 造一个有主题的库：四组，每组一个话题 ──
const TOPICS = [
  { name: "端口", words: ["端口", "防火墙", "sshd", "监听", "连接"], affect: "急" },
  { name: "记忆", words: ["记忆", "回忆", "检索", "向量", "索引"], affect: "沉" },
  { name: "吃饭", words: ["吃饭", "晚饭", "加班", "别空着", "外卖"], affect: "暖" },
  { name: "难过", words: ["难受", "舍不得", "心里", "咯噔", "空落"], affect: "舍不得" },
];
const entries = [];
let idx = 0;
for (const t of TOPICS) {
  for (let i = 0; i < 12; i++) {
    const w = t.words[i % t.words.length];
    entries.push({
      id: "e" + (idx++),
      d: "2026-11-" + String(1 + (i % 5)).padStart(2, "0"),
      t: String(10 + (i % 12)).padStart(2, "0") + ":00",
      said: "关于" + w + "的事，第 " + i + " 回",
      did: "处理" + t.name + "相关的事情",
      think: t.name + " " + w + " 这一块要记住",
      affect: [{ name: t.affect, v: t.name === "难过" ? -0.6 : 0.3, a: 0.5 }],
      tags: [t.name],
    });
  }
}
fs.writeFileSync(libFile, entries.map(e => JSON.stringify(e)).join("\n") + "\n", "utf8");
const lib = openLibrary(libFile);
assert.equal(lib.entries.length, 48, "库应该读到 48 条");

// ── 假向量：按话题给四个正交方向，加一点噪声 ──
const DIM = 8;
const AXIS = { 端口: 0, 记忆: 1, 吃饭: 2, 难过: 3 };
function vecOf(text) {
  const v = new Float32Array(DIM);
  for (const t of TOPICS) if (String(text).includes(t.words[0])) v[AXIS[t.name]] += 3;
  for (const t of TOPICS) for (const w of t.words) if (String(text).includes(w)) v[AXIS[t.name]] += 1;
  v[4] = 0.1; v[5] = 0.1; v[6] = 0.05; v[7] = 0.05;
  let norm = 0; for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}
const vectors = new Map(lib.entries.map(e => [e.id, vecOf(e.said + " " + e.did + " " + e.think)]));
const embed = async text => vecOf(text);

// ── 1. 建树 ──
const tree = hydrate(buildTree([...vectors].map(([id, v]) => ({ id, v })), { books: 4, maxSize: 6, maxDepth: 4 }));
assert(tree.books.length === 4, "应该是 4 本书");
let nodes = 0, leaves = 0, total = 0, maxD = 0;
const walk = (n, d) => {
  nodes++; maxD = Math.max(maxD, d);
  if (n.children) n.children.forEach(c => walk(c, d + 1));
  else { leaves++; total += n.members.length; }
  assert(n.allIds.length === n.size, "allIds 长度要等于 size：" + n.id);
  assert(n.children ? n.children.length <= 3 : true, "每个节点最多 3 个孩子");
};
tree.books.forEach(b => walk(b, 1));
assert.equal(total, 48, "每条经历都要落在正好一个叶子里");
assert(leaves > 1, "应该切出多个叶子");
console.log("  树: " + tree.books.length + " 本 / " + nodes + " 节点 / " + leaves + " 叶 / 最深 " + maxD);

// ── 2. 下钻 ──
const qv = vecOf("端口 监听 连接");
const leavesHit = descend(tree, qv, { books: 2, vectors });
assert(leavesHit.length === 2, "应该返回两个叶子");
const poolIds = new Set(leavesHit.flatMap(l => l.allIds));
assert(poolIds.size < 48, "池子应该比全库小：" + poolIds.size);
assert(poolIds.size > 0, "池子不能空");
console.log("  下钻: 池 " + poolIds.size + "/48  叶 " + leavesHit.map(l => l.id + "(" + l.size + ")").join(","));

// ── 3. 层内最高成员分（不是中心） ──
const farQ = vecOf("完全无关的一句话");
const farLeaves = descend(tree, farQ, { books: 1, vectors });
assert(farLeaves.length >= 1, "无关查询也要给出一条路，不能崩");

// ── 4. heat 只做轻微优先，不能压过语义 ──
const h1 = descend(tree, qv, { books: 1, vectors })[0];
const before = h1.id;
h1.heat = 999;
const h2 = descend(tree, qv, { books: 1, vectors })[0];
assert.equal(h2.id, before, "heat 顶到 999 也不该改变路径（上限压住了）");
h1.heat = 0;
console.log("  heat 上限: OK（999 也不改道）");

// ── 5. promote + freeze ──
const promoted = promote([h1], h1.members.slice(0, 1));
assert(promoted === true, "命中应该加热");
assert(h1.heat === 1, "heat 应该 +1");
const frozen = freeze(tree);
assert(!("cv" in frozen.books[0]), "freeze 要摘掉 cv");
assert(!("allIds" in frozen.books[0]), "freeze 要摘掉 allIds");
assert(JSON.stringify(frozen).length < JSON.stringify(tree).length * 2, "freeze 后不该比内存版还大");
console.log("  上浮/落盘: OK");

// ── 6. insert：新写的一条挂到最近的叶子 ──
const newVec = vecOf("新的端口事件");
vectors.set("eNEW", newVec);
const node = insert(tree, "eNEW", newVec);
assert(node && node.members.includes("eNEW"), "新条目要挂上");
assert(vectors.has("eNEW"), "向量也要在");
console.log("  落盘归类: 挂到 " + node.id);

// ── 7. 别名 ──
appendAlias(aliasFile, { w: "人称", ids: ["e0"], note: "不是语法那个" });
appendAlias(aliasFile, { w: "人称", ids: ["e1"] });
const als = loadAliases(aliasFile);
assert.equal(als.length, 1, "同一个词只占一行");
assert.equal(als[0].ids.length, 2, "同一个词可以挂多条经历");
const m1 = matchAlias(als, "那个 人称 是什么意思");
assert.equal(m1.length, 2, "查询里含这个词就要命中");
const m2 = matchAlias(als, "端口被打了");
assert.equal(m2.length, 0, "不含就不该命中");
// 长词优先：「人」不该把「人称」吃掉
appendAlias(aliasFile, { w: "人", ids: ["e2"] });
const m3 = matchAlias(loadAliases(aliasFile), "人称");
assert.equal(m3[0].word, "人称", "长词优先");
console.log("  别名: OK（长词优先）");

// ── 8. 情绪通道：单字不能误伤 ──
assert.equal(pickAffectWord("重启", ["重"]), null, "「重启」里的「重」不算");
assert.equal(pickAffectWord("最沉", ["沉"]), "沉");
assert.equal(pickAffectWord("有点懊恼", ["懊恼"]), "懊恼");
assert.equal(pickAffectWord("端口被打了", ["急"]), null);
console.log("  情绪通道: OK");

// ── 9. recallSemantic：完整路径 ──
const r1 = await recallSemantic(lib, { about: "端口", want: "端口连不上", n: 3, embed, vectors, tree, aliases: loadAliases(aliasFile) });
assert.equal(r1.length, 3, "要返回 3 条");
assert(r1[0].e.said.includes("端口") || r1[0].e.think.includes("端口"), "第一条应该跟端口有关，实际：" + r1[0].e.said);
console.log("  语义召回: " + r1.map(x => x.e.said.slice(0, 12)).join(" | "));

// ── 10. 别名排在最前 ──
const r2 = await recallSemantic(lib, { about: "人称", want: "", n: 3, embed, vectors, tree, aliases: loadAliases(aliasFile) });
assert(r2[0].why && r2[0].why.includes("别名"), "别名命中的要排第一条，实际 why=" + r2[0].why);
console.log("  别名优先: " + r2[0].e.id + " why=" + r2[0].why);

// ── 11. 没有向量就退回词频 ──
const r3 = await recallSemantic(lib, { about: "记忆", n: 3, aliases: loadAliases(aliasFile) });
assert(r3.length > 0, "没向量也要能返回");
assert(r3.every(x => x.e), "返回的每条都要有内容");
console.log("  词频降级: " + r3.length + " 条");

// ── 12. 空库不崩 ──
const empty = { file: "", entries: [], byId: {} };
const r4 = await recallSemantic(empty, { about: "随便", n: 3 });
assert(Array.isArray(r4), "空库也要返回数组");
const t4 = buildTree([]);
assert(t4.books.length === 0, "空向量建树返回空");
assert(descend(t4, new Float32Array(8), { vectors: new Map() }).length === 0, "空树下钻返回空");
console.log("  空输入: OK");

// ── 13. 情绪提取两种字段名都认 ──
assert.equal(affectOf({ affect: [{ name: "沉", v: -0.5 }] })[0].name, "沉");
assert.equal(affectOf({ Fs: [{ f: "沉", v: -0.5 }] })[0].name, "沉");
assert.equal(affectOf({}).length, 0);
console.log("  字段兼容: OK");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n全部通过");
