export function effectiveGroupSize(c) {
  return typeof c.size === "number" && !Number.isNaN(c.size) ? c.size : 2;
}

export function effectiveGroupCount(c) {
  return typeof c.count === "number" && !Number.isNaN(c.count) ? c.count : 1;
}

export function normalizeGroupConfig(groupConfig) {
  return groupConfig.map((c) => ({
    ...c,
    size: effectiveGroupSize(c),
    count: effectiveGroupCount(c),
  }));
}

export function totalGroupSlots(groupConfig) {
  return groupConfig.reduce((a, c) => a + effectiveGroupSize(c) * effectiveGroupCount(c), 0);
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function buildGroupNameMap(groupConfig) {
  const map = {};
  let idx = 0;
  normalizeGroupConfig(groupConfig).forEach((c) => {
    for (let i = 0; i < c.count; i++) {
      const name = c.name
        ? c.count === 1 ? c.name : `${c.name}${i + 1}`
        : `グループ${idx + 1}`;
      map[name] = c.size;
      idx++;
    }
  });
  return map;
}

function pairScore(a, b, affinity) {
  return (affinity[a]?.[b] || 0) + (affinity[b]?.[a] || 0);
}

function internalAffinity(id, cluster, affinity) {
  return cluster
    .filter((x) => x !== id)
    .reduce((sum, x) => sum + (affinity[id]?.[x] || 0), 0);
}

function buildAffinity(participants, ids) {
  const n = ids.length;
  const affinity = {};
  ids.forEach((a) => {
    affinity[a] = {};
    ids.forEach((b) => { affinity[a][b] = 0; });
  });
  participants.forEach((p) => {
    (p.preferences || []).forEach((prefId, idx) => {
      if (affinity[p.id][prefId] !== undefined) {
        const s = n - idx;
        affinity[p.id][prefId] += s;
        affinity[prefId][p.id] += s;
      }
    });
  });
  return affinity;
}

function buildEdges(ids, affinity) {
  const edges = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      const score = pairScore(a, b, affinity);
      if (score > 0) edges.push({ a, b, score });
    }
  }
  edges.sort((x, y) => y.score - x.score);
  return edges;
}

function buildClusters(ids, edges) {
  const parent = Object.fromEntries(ids.map((id) => [id, id]));

  const find = (x) => {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  };

  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (const { a, b } of edges) union(a, b);

  const map = new Map();
  for (const id of ids) {
    const root = find(id);
    if (!map.has(root)) map.set(root, new Set());
    map.get(root).add(id);
  }

  return [...map.values()].map((s) => [...s]);
}

function buildSlots(groupConfig) {
  const slots = [];
  groupConfig.forEach((c) => {
    for (let i = 0; i < c.count; i++) {
      const name = c.name
        ? c.count === 1 ? c.name : `${c.name}${i + 1}`
        : `グループ${slots.length + 1}`;
      slots.push({ slotSize: c.size, name, members: [] });
    }
  });
  return slots;
}

function removeWeakestFromCluster(members, affinity) {
  if (members.length <= 1) return members.pop();
  let weakest = members[0];
  let weakestScore = internalAffinity(weakest, members, affinity);
  for (const id of members) {
    const s = internalAffinity(id, members, affinity);
    if (s < weakestScore) {
      weakest = id;
      weakestScore = s;
    }
  }
  return members.splice(members.indexOf(weakest), 1)[0];
}

function bestUnassignedForSlot(slot, unassigned, affinity) {
  if (!unassigned.length) return null;
  let best = unassigned[0];
  let bestScore = -1;
  for (const id of unassigned) {
    const score = slot.members.reduce((sum, m) => sum + pairScore(id, m, affinity), 0);
    if (score > bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}

function slotFree(gi, groups) {
  return groups[gi].slotSize - groups[gi].members.length;
}

function findSlotWithSpace(groups) {
  for (let i = 0; i < groups.length; i++) {
    if (slotFree(i, groups) > 0) return i;
  }
  return -1;
}

function findSlotWithMostSpace(groups) {
  let best = -1;
  let bestFree = 0;
  for (let i = 0; i < groups.length; i++) {
    const free = slotFree(i, groups);
    if (free > bestFree) {
      bestFree = free;
      best = i;
    }
  }
  return bestFree > 0 ? best : -1;
}

function forceAssignAll(groups, ids) {
  const placed = new Set();
  groups.forEach((g) => g.members.forEach((id) => placed.add(id)));

  for (const id of ids) {
    if (placed.has(id)) continue;
    const gi = findSlotWithMostSpace(groups);
    if (gi < 0) {
      const fallback = findSlotWithSpace(groups);
      if (fallback < 0) break;
      groups[fallback].members.push(id);
      placed.add(id);
      continue;
    }
    groups[gi].members.push(id);
    placed.add(id);
  }
}

function pickBestSubset(pool, k, affinity) {
  if (k <= 0 || !pool.length) return [];
  if (pool.length <= k) return [...pool];

  if (k === 1) return [pool[0]];

  if (k === 2) {
    let best = [pool[0], pool[1]];
    let bestScore = pairScore(pool[0], pool[1], affinity);
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const score = pairScore(pool[i], pool[j], affinity);
        if (score > bestScore) {
          bestScore = score;
          best = [pool[i], pool[j]];
        }
      }
    }
    return best;
  }

  let best = pool.slice(0, k);
  let bestScore = -1;
  const dfs = (start, chosen) => {
    if (chosen.length === k) {
      let score = 0;
      for (let i = 0; i < chosen.length; i++) {
        for (let j = i + 1; j < chosen.length; j++) {
          score += pairScore(chosen[i], chosen[j], affinity);
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = [...chosen];
      }
      return;
    }
    for (let i = start; i < pool.length; i++) {
      chosen.push(pool[i]);
      dfs(i + 1, chosen);
      chosen.pop();
    }
  };
  dfs(0, []);
  return best;
}

function chooseSlotIndicesForCount(groups, n) {
  const m = groups.length;
  let best = null;
  let bestDiff = Infinity;

  const dfs = (i, sum, chosen) => {
    if (i === m) {
      const diff = Math.abs(sum - n);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = [...chosen];
      }
      return;
    }
    dfs(i + 1, sum, chosen);
    dfs(i + 1, sum + groups[i].slotSize, [...chosen, i]);
  };
  dfs(0, 0, []);

  if (best && best.reduce((s, i) => s + groups[i].slotSize, 0) >= n) return best;
  return groups.map((_, i) => i);
}

function takeClusterForSlot(clusters, slotSize, poolSet) {
  const inPool = (c) => c.every((id) => poolSet.has(id));
  const exact = clusters.find((c) => c.length === slotSize && inPool(c));
  if (exact) return exact;
  const fits = clusters
    .filter((c) => c.length <= slotSize && inPool(c))
    .sort((a, b) => b.length - a.length)[0];
  return fits || null;
}

function repackSlotsExactly(groups, ids, affinity, clusters) {
  let pool = shuffleArray([...ids]);
  const poolSet = () => new Set(pool);
  groups.forEach((g) => { g.members = []; });

  const active = chooseSlotIndicesForCount(groups, pool.length);
  const activeSet = new Set(active);
  const order = [...active].sort((a, b) => groups[b].slotSize - groups[a].slotSize);
  const clusterQueue = [...clusters].sort((a, b) => b.length - a.length);

  for (const gi of order) {
    const need = groups[gi].slotSize;
    let picked = [];

    const cluster = takeClusterForSlot(clusterQueue, need, poolSet());
    if (cluster) {
      const idx = clusterQueue.findIndex((c) => c === cluster);
      if (idx >= 0) clusterQueue.splice(idx, 1);
      let members = [...cluster];
      while (members.length > need) {
        pool.push(removeWeakestFromCluster(members, affinity));
      }
      picked = members;
      pool = pool.filter((id) => !picked.includes(id));
      while (picked.length < need && pool.length) {
        const extra = bestUnassignedForSlot({ members: picked }, pool, affinity);
        if (!extra) break;
        picked.push(extra);
        pool = pool.filter((id) => id !== extra);
      }
    } else {
      const k = Math.min(need, pool.length);
      if (k > 0) picked = pickBestSubset(pool, k, affinity);
    }

    groups[gi].members = picked.slice(0, need);
    const pickedSet = new Set(groups[gi].members);
    pool = pool.filter((id) => !pickedSet.has(id));
  }

  for (let gi = 0; gi < groups.length; gi++) {
    if (!activeSet.has(gi)) groups[gi].members = [];
  }

  return pool;
}

export function runMatching(participants, groupConfig) {
  groupConfig = normalizeGroupConfig(groupConfig);
  const ids = participants.map((p) => p.id);
  const n = ids.length;

  const affinity = buildAffinity(participants, ids);
  const edges = buildEdges(ids, affinity);
  const groups = buildSlots(groupConfig);

  // Step2: 希望グラフからクラスター（連結成分）を構築
  const clusters = buildClusters(ids, edges).sort((a, b) => b.length - a.length);

  // Step3〜5: クラスター優先でスロットに割当し、定員ぴったりに再パック
  let remaining = repackSlotsExactly(groups, ids, affinity, clusters);

  // Step4: 余った参加者を空きスロットへ（定員超過しない）
  remaining = shuffleArray(remaining);
  for (const id of remaining) {
    const gi = findSlotWithMostSpace(groups);
    if (gi < 0) break;
    groups[gi].members.push(id);
  }

  forceAssignAll(groups, ids);

  for (let gi = 0; gi < groups.length; gi++) {
    if (groups[gi].members.length > groups[gi].slotSize) {
      groups[gi].members = groups[gi].members.slice(0, groups[gi].slotSize);
    }
  }

  const result = groups
    .filter((g) => g.members.length > 0)
    .map((g) => ({
      members: [...g.members],
      name: g.name,
      slotSize: g.slotSize,
    }));

  const satisfaction = participants.map((p) => {
    const grp = result.find((g) => g.members.includes(p.id));
    const matched = grp
      ? (p.preferences || []).filter((pref) => grp.members.includes(pref))
      : [];
    const score = matched.reduce((acc, pref) => {
      const idx = (p.preferences || []).indexOf(pref);
      return acc + (n - idx);
    }, 0);
    return { id: p.id, score, matched };
  });

  return { groups: result, satisfaction };
}
