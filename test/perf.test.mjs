import assert from "node:assert";
import { buildTree, hydrate, descend, cos, freeze, insert } from "../src/tree.mjs";
import { openLibrary, recallSemantic } from "../src/memory.mjs";
import { loadAliases, matchAlias, appendAlias } from "../src/aliases.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "affect-perf-"));
const DIM = 32;
const N = 1000;

// 造 1000 条：20 个话题，每个 50 条，话题各有自己的方向
const AXES = 20;
// 确定性伪随机：同样的种子出同样的数，测试才能复现
const rng = s => () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
function topicVec(t, seed = 1, noise = 0.45) {
  const v = new Float32Array(DIM);
  v[t] = 1;
  const r = rng(seed * 7919 + t);
  for (let i = AXES; i < DIM; i++) v[i] = (r() - 0.5) * noise * 2;
  let norm = 0; for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}
const entries = [], vectors = new Map();
for (let i = 0; i < N; i++) {
  const t = i % AXES;
  const id = "e" + i;
  entries.push({ id, d: "2026-10-" + String(1 + (i % 28)).padStart(2, "0"), t: "12:00",
    said: "第" + t + "号话题第" + Math.floor(i / AXES) + "回", did: "做事", think: "想法", affect: [], tags: [] });
  vectors.set(id, topicVec(t, i));
}
const libFile = path.join(tmp, "exp.jsonl");
fs.writeFileSync(libFile, entries.map(e => JSON.stringify(e)).join("\n") + "\n", "utf8");
const lib = openLibrary(libFile);
assert.equal(lib.entries.length, N);

// ── 建树 ──
const t0 = Date.now();
const tree = hydrate(buildTree([...vectors].map(([id, v]) => ({ id, v })), { books: 24, maxSize: 25, maxDepth: 5 }));
const buildMs = Date.now() - t0;
let nodes = 0, leaves = 0, total = 0, maxD = 0, biggestLeaf = 0;
const walk = (n, d) => {
  nodes++; maxD = Math.max(maxD, d);
  assert(n.children ? n.children.length <= 3 : true, "最多 3 个孩子");
  if (n.children) n.children.forEach(c => walk(c, d + 1));
  else { leaves++; total += n.members.length; biggestLeaf = Math.max(biggestLeaf, n.members.length); }
};
tree.books.forEach(b => walk(b, 1));
assert.equal(total, N, "1000 条一条不能丢");
assert.equal(new Set(tree.books.flatMap(b => b.allIds)).size, N, "书之间不能重复");
console.log("  建树 " + buildMs + "ms | " + tree.books.length + " 本 / " + nodes + " 节点 / " + leaves + " 叶 / 最深 " + maxD + " | 最大叶 " + biggestLeaf);

// ── 下钻 vs 全量 ──
const qv = topicVec(3);
let t1 = Date.now();
for (let i = 0; i < 50; i++) descend(tree, qv, { books: 2, vectors });
const descendMs = (Date.now() - t1) / 50;

t1 = Date.now();
for (let i = 0; i < 50; i++) for (const [, v] of vectors) cos(qv, v);
const fullScanMs = (Date.now() - t1) / 50;

const leavesHit = descend(tree, qv, { books: 2, vectors });
const pool = new Set(leavesHit.flatMap(l => l.allIds));
assert(pool.size < N / 4, "池子要明显小于全库，实际 " + pool.size);
// 下钻本身不省第一层的余弦——书这一层本来就要跟全库比。
// 它省的是「后面精排要处理的条数」：词频表、打分、排序都只在池子里做。
assert(pool.size < N / 6, "池子要比全库小一个量级才划算，实际 " + pool.size);
console.log("  下钻 " + descendMs.toFixed(2) + "ms 得池 " + pool.size + " 条（全量余弦 " + fullScanMs.toFixed(2) + "ms）");
console.log("  精排范围: " + pool.size + " 条 vs 全库 " + N + " 条");

// ── 目标话题在不在池子里 ──
const targetIn = [...pool].filter(id => id.startsWith("e") && (Number(id.slice(1)) % AXES) === 3).length;
assert(targetIn > 0, "目标话题必须有条目在池子里");
console.log("  目标话题落在池内: " + targetIn + " 条");

// ── freeze 体积 ──
const frozenStr = JSON.stringify(freeze(tree));
assert(frozenStr.length < JSON.stringify(tree).length, "freeze 后要更小");
console.log("  体积: 内存 " + (JSON.stringify(tree).length / 1024).toFixed(0) + "KB → 落盘 " + (frozenStr.length / 1024).toFixed(0) + "KB");

// ── 边界：所有向量一模一样（切不动） ──
const same = new Float32Array(DIM); same[0] = 1;
const sameVecs = new Map(Array.from({ length: 60 }, (_, i) => ["s" + i, same]));
const sameTree = hydrate(buildTree([...sameVecs].map(([id, v]) => ({ id, v })), { books: 3, maxSize: 10, maxDepth: 5 }));
let sameLeaves = 0, sameTotal = 0;
const walk2 = n => { if (n.children) n.children.forEach(walk2); else { sameLeaves++; sameTotal += n.members.length; } };
sameTree.books.forEach(walk2);
assert.equal(sameTotal, 60, "切不动也不能丢条目");
console.log("  全相同向量: " + sameLeaves + " 叶 / " + sameTotal + " 条（没硬切）");

// ── 边界：单条库 ──
const one = hydrate(buildTree([{ id: "only", v: new Float32Array(DIM).fill(1 / Math.sqrt(DIM)) }], { books: 4, maxSize: 25, maxDepth: 5 }));
assert.equal(one.books.length, 1, "一条就一本");
assert.equal(one.books[0].members[0], "only");

// ── 边界：查询空串 / 空向量 ──
const r1 = await recallSemantic(lib, { about: "", n: 3 });
assert(Array.isArray(r1), "空查询不能崩");
const leavesEmpty = descend(tree, null, { vectors });
assert.deepEqual(leavesEmpty, [], "空向量返回空");

// ── 边界：别名表文件不存在 ──
const noFile = loadAliases(path.join(tmp, "nope.jsonl"));
assert.deepEqual(noFile, [], "没文件返回空数组");
assert.equal(matchAlias(noFile, "任何").length, 0);

// ── 边界：树持久化往返 ──
const round = JSON.parse(JSON.stringify(freeze(tree)));
assert.equal(round.books.length, tree.books.length, "存读之后书数不变");
const rehyd = hydrate(round);
const leaves2 = descend(rehyd, qv, { books: 2, vectors });
assert.equal(leaves2.length, 2, "存读之后还能下钻");
assert.deepEqual(leaves2.map(l => l.id), leavesHit.map(l => l.id), "存读前后走的路径要一致");
console.log("  持久化往返: 路径一致");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n性能与边界全部通过");
