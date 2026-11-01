/**
 * tree.mjs — 把一堆向量组织成一棵树，检索时从书名一路翻到小节。
 *
 * 为什么要有这个：纯向量检索在时间轴上是胖的——一千多条里最近的那几条
 * 未必是最像的，而全量算一遍又慢又容易把「什么都沾一点」的长条目顶上来。
 *
 * 树是这么长的：
 *   书（第一层，粗分）→ 章 → 节 → … 最多 maxDepth 层
 *   每个节点最多分三个孩子；某个节点超过 maxSize 条就继续往下切，切到不动为止。
 *   切不动（最大的那份还占九成）就停手——那坨本来是一回事，硬撕没意义。
 *
 * 一条经历只会落在每一个祖先里，不会重复计入兄弟节点。
 */

/** 余弦相似度。向量必须自己保证归一化，这里不做保护。 */
export const cos = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i += 4) {
    s += a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2] + a[i + 3] * b[i + 3];
  }
  return s;
};

/** 算一组向量的归一化中心。 */
function centerOf(items, dim) {
  const c = new Float32Array(dim);
  for (const it of items) for (let i = 0; i < dim; i++) c[i] += it.v[i];
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += c[i] * c[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) c[i] /= norm;
  return c;
}

/**
 * 球面 k-means。返回 k 组（可能是 1 组，如果切不动）。
 * seed 固定 → 同样的数据同样的树，方便复现和测试。
 */
function kmeans(items, k, seed, dim) {
  if (items.length <= k || k <= 1) return [items];
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };

  // k-means++ 选初始中心
  const C = [new Float32Array(items[Math.floor(rnd() * items.length)].v)];
  while (C.length < k) {
    const d = items.map(x => {
      let best = -2;
      for (const c of C) { const v = cos(x.v, c); if (v > best) best = v; }
      return 1 - best;
    });
    const sum = d.reduce((a, b) => a + b, 0) || 1;
    let r = rnd() * sum, pick = items.length - 1;
    for (let i = 0; i < d.length; i++) { r -= d[i]; if (r <= 0) { pick = i; break; } }
    C.push(new Float32Array(items[pick].v));
  }

  const assign = new Uint16Array(items.length);
  for (let iter = 0; iter < 10; iter++) {
    for (let i = 0; i < items.length; i++) {
      let best = -2, bi = 0;
      for (let c = 0; c < C.length; c++) { const v = cos(items[i].v, C[c]); if (v > best) { best = v; bi = c; } }
      assign[i] = bi;
    }
    const sums = Array.from({ length: C.length }, () => new Float64Array(dim));
    const cnt = new Uint16Array(C.length);
    for (let i = 0; i < items.length; i++) {
      const a = assign[i]; cnt[a]++;
      for (let j = 0; j < dim; j++) sums[a][j] += items[i].v[j];
    }
    for (let c = 0; c < C.length; c++) {
      if (!cnt[c]) continue;
      const n = new Float32Array(dim);
      let norm = 0;
      for (let j = 0; j < dim; j++) { n[j] = sums[c][j] / cnt[c]; norm += n[j] * n[j]; }
      norm = Math.sqrt(norm) || 1;
      for (let j = 0; j < dim; j++) n[j] /= norm;
      C[c] = n;
    }
  }

  const groups = Array.from({ length: C.length }, () => []);
  for (let i = 0; i < items.length; i++) groups[assign[i]].push(items[i]);
  return groups.filter(g => g.length);
}

/**
 * 建树。
 * @param {Array<{id:string, v:Float32Array}>} vectors
 * @param {{books?:number, maxSize?:number, maxDepth?:number, seed?:number, heatBonusCap?:number}} opts
 */
export function buildTree(vectors, opts = {}) {
  const { books = 24, maxSize = 25, maxDepth = 5, seed = 20261101, heatBonusCap = 0.015 } = opts;
  if (!vectors.length) return { books: [], dim: 0, maxSize, maxDepth, heatBonusCap };
  const dim = vectors[0].v.length;
  let seedCursor = seed;

  const build = (items, path, depth) => {
    const node = { id: path, size: items.length, centroid: Array.from(centerOf(items, dim)), heat: 0 };
    const canSplit = items.length > maxSize && depth < maxDepth;
    if (!canSplit) { node.members = items.map(x => x.id); return node; }
    const parts = kmeans(items, 3, seedCursor++, dim);
    const biggest = Math.max(...parts.map(p => p.length));
    if (parts.length <= 1 || biggest > items.length * 0.9) {
      node.members = items.map(x => x.id);   // 切不动，停手
      return node;
    }
    node.children = parts.map((p, i) => build(p, path + String.fromCharCode(97 + i), depth + 1));
    return node;
  };

  const top = kmeans(vectors, books, seedCursor++, dim);
  return {
    dim, maxSize, maxDepth, heatBonusCap,
    books: top.map((b, i) => build(b, "b" + i, 1)),
  };
}

/** 把树里的 centroid 变成 Float32Array，并给每个节点算好 allIds / set。就地改。 */
export function hydrate(tree) {
  const prep = n => {
    n.cv = new Float32Array(n.centroid);
    n.heat = n.heat || 0;
    n.allIds = n.children ? n.children.flatMap(prep) : n.members.slice();
    n.set = new Set(n.allIds);
    return n.allIds;
  };
  for (const b of tree.books) prep(b);
  return tree;
}

/**
 * 从书名往下走，每层挑一个孩子，走到叶子。
 * 用的是「层内最高成员相似度」，不是节点中心——
 * 中心是平均值，一个二十条的节平均下来什么都像一点、什么都不像，
 * 只要里面有一条跟查询像，这个节就该进。
 */
export function descend(tree, queryVec, { books = 2, vectors, heatBonusCap = tree.heatBonusCap ?? 0.015 } = {}) {
  if (!queryVec || !tree.books.length || !vectors) return [];
  // memo：同一层的几个孩子共享同一批成员，不缓存的话同一个 id 要算好几遍余弦
  const memo = new Map();
  const simOf = id => {
    let s = memo.get(id);
    if (s === undefined) { const v = vectors.get(id); s = v ? cos(queryVec, v) : -1; memo.set(id, s); }
    return s;
  };
  const bestOf = ids => {
    let b = -1;
    for (const id of ids) { const s = simOf(id); if (s > b) b = s; }
    return b;
  };
  const picked = tree.books
    .map(b => ({ b, s: bestOf(b.allIds) }))
    .sort((x, y) => y.s - x.s)
    .slice(0, books);

  const leaves = [];
  for (const { b } of picked) {
    let cur = b;
    while (cur.children) {
      let best = null, bs = -Infinity;
      for (const c of cur.children) {
        // heat 只做轻微优先。上限压得低是有教训的：原来给到 0.04，
        // 一条错误的节被反复命中后自己把路锁死，正解永远挤不进来。
        const v = bestOf(c.allIds) + Math.min(heatBonusCap, (c.heat || 0) * (heatBonusCap / 3));
        if (v > bs) { bs = v; best = c; }
      }
      if (!best) break;
      cur = best;
    }
    leaves.push(cur);
  }
  return leaves;
}

/** 命中之后给走过的节加热。被捞过的东西下次靠前一点。 */
export function promote(leaves, hitIds) {
  let dirty = false;
  for (const n of leaves) {
    for (const id of hitIds) {
      if (n.set && n.set.has(id)) { n.heat = (n.heat || 0) + 1; dirty = true; break; }
    }
  }
  return dirty;
}

/** 落盘用：把内存字段摘掉，否则一棵树能胀六倍（centroid 变成浮点数组）。 */
export function freeze(tree) {
  const clean = n => {
    const o = { id: n.id, size: n.size, centroid: n.centroid, heat: n.heat || 0 };
    if (n.children) o.children = n.children.map(clean);
    if (n.members) o.members = n.members;
    return o;
  };
  return { dim: tree.dim, maxSize: tree.maxSize, maxDepth: tree.maxDepth,
    heatBonusCap: tree.heatBonusCap, books: tree.books.map(clean) };
}

/** 新写的一条：从书往下挑最近的，一路走到叶子，挂上去。 */
export function insert(tree, id, vec) {
  if (!tree.books.length) return null;
  const simOf = v => cos(vec, v);
  let cur = null, bs = -Infinity;
  for (const b of tree.books) {
    const s = simOf(b.cv || new Float32Array(b.centroid));
    if (s > bs) { bs = s; cur = b; }
  }
  while (cur && cur.children) {
    let nb = null, ns = -Infinity;
    for (const c of cur.children) {
      const s = simOf(c.cv || new Float32Array(c.centroid));
      if (s > ns) { ns = s; nb = c; }
    }
    if (!nb) break;
    cur = nb;
  }
  if (!cur || !cur.members) return null;
  cur.members.push(id);
  cur.size = cur.members.length;
  if (cur.set) cur.set.add(id);
  return cur;
}
