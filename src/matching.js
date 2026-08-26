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

export function getSlotFixedMembers(c, slotIndex = 0) {
  if (!c.fixedMembers || !Array.isArray(c.fixedMembers) || c.fixedMembers.length === 0) {
    return [];
  }
  const count = effectiveGroupCount(c);
  if (count === 1) {
    if (typeof c.fixedMembers[0] === "string") return [...c.fixedMembers];
    return Array.isArray(c.fixedMembers[0]) ? [...c.fixedMembers[0]] : [];
  }
  const entry = c.fixedMembers[slotIndex];
  return Array.isArray(entry) ? [...entry] : [];
}

export function expandGroupSlots(groupConfig) {
  const slots = [];
  normalizeGroupConfig(groupConfig).forEach((c) => {
    for (let i = 0; i < c.count; i++) {
      const name = c.name
        ? c.count === 1 ? c.name : `${c.name}${i + 1}`
        : `グループ${slots.length + 1}`;
      slots.push({
        configId: c.id,
        slotIndex: i,
        name,
        size: c.size,
        fixedMembers: getSlotFixedMembers(c, i),
      });
    }
  });
  return slots;
}

export function setSlotFixedMembers(groupConfig, configId, slotIndex, memberIds) {
  return groupConfig.map((c) => {
    if (c.id !== configId) return c;
    const count = effectiveGroupCount(c);
    if (count === 1) {
      return { ...c, fixedMembers: [...memberIds] };
    }
    let fixed = c.fixedMembers;
    if (
      !Array.isArray(fixed) ||
      fixed.length !== count ||
      typeof fixed[0] === "string"
    ) {
      fixed = Array.from({ length: count }, () => []);
    } else {
      fixed = fixed.map((arr) => [...arr]);
    }
    fixed[slotIndex] = [...memberIds];
    return { ...c, fixedMembers: fixed };
  });
}

export function validateFixedMembers(groupConfig, participants) {
  const ids = new Set((participants || []).map((p) => p.id));
  const seen = new Set();
  const slots = expandGroupSlots(groupConfig);

  for (const slot of slots) {
    if (slot.fixedMembers.length > slot.size) {
      return `「${slot.name}」の固定メンバー（${slot.fixedMembers.length}人）が定員（${slot.size}人）を超えています`;
    }
    for (const id of slot.fixedMembers) {
      if (!ids.has(id)) {
        return "固定メンバーに存在しない参加者が含まれています";
      }
      if (seen.has(id)) {
        return "同じ参加者が複数グループに固定されています";
      }
      seen.add(id);
    }
  }
  return null;
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
  normalizeGroupConfig(groupConfig).forEach((c) => {
    for (let i = 0; i < c.count; i++) {
      const name = c.name
        ? c.count === 1 ? c.name : `${c.name}${i + 1}`
        : `グループ${slots.length + 1}`;
      const fixed = getSlotFixedMembers(c, i);
      slots.push({ slotSize: c.size, name, members: [...fixed] });
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

/** 余った参加者は3人以上の部屋を優先（なければ2人部屋） */
function findSlotForRemaining(groups) {
  const candidates = [];
  for (let i = 0; i < groups.length; i++) {
    const free = slotFree(i, groups);
    if (free > 0) candidates.push({ gi: i, free, size: groups[i].slotSize });
  }
  if (!candidates.length) return -1;
  const large = candidates.filter((c) => c.size >= 3);
  const pool = large.length ? large : candidates;
  pool.sort((a, b) => b.size - a.size || b.free - a.free);
  return pool[0].gi;
}

function slotFillOrder(groups) {
  return groups
    .map((g, gi) => ({ gi, free: g.slotSize - g.members.length, size: g.slotSize }))
    .filter(({ free }) => free > 0)
    .sort((a, b) => a.size - b.size || b.free - a.free)
    .map(({ gi }) => gi);
}

function forceAssignAll(groups, ids, pickSlot = findSlotWithMostSpace) {
  const placed = new Set();
  groups.forEach((g) => g.members.forEach((id) => placed.add(id)));

  for (const id of ids) {
    if (placed.has(id)) continue;
    const gi = pickSlot(groups);
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

function repackSlotsWithFixed(groups, ids, affinity, clusters) {
  let pool = shuffleArray([...ids]);
  const poolSet = () => new Set(pool);
  let clusterQueue = [...clusters].sort((a, b) => b.length - a.length);
  const activeSet = new Set(chooseSlotIndicesForCount(groups, pool.length));
  const fillOrder = slotFillOrder(groups).filter((gi) => activeSet.has(gi));

  // Phase 1: クラスターと同じ定員のスロットへ（2人部屋から優先）
  for (const gi of fillOrder) {
    const need = groups[gi].slotSize - groups[gi].members.length;
    if (need <= 0) continue;
    const exactIdx = clusterQueue.findIndex(
      (c) => c.length === need && c.every((id) => poolSet().has(id)),
    );
    if (exactIdx >= 0) {
      const exact = clusterQueue.splice(exactIdx, 1)[0];
      groups[gi].members.push(...exact);
      pool = pool.filter((id) => !exact.includes(id));
    }
  }

  // Phase 2: 残りを定員の小さいスロットから埋める（大クラスターは分割しない）
  clusterQueue = clusterQueue.filter((c) => c.every((id) => poolSet().has(id)));
  for (const gi of fillOrder) {
    const need = groups[gi].slotSize - groups[gi].members.length;
    if (need <= 0 || !pool.length) continue;
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
        const blocked = new Set(
          clusterQueue.filter((c) => c.length > need).flat(),
        );
        const candidates = pool.filter((id) => !blocked.has(id));
        const extra = bestUnassignedForSlot(
          { members: [...groups[gi].members, ...picked] },
          candidates.length ? candidates : pool,
          affinity,
        );
        if (!extra) break;
        picked.push(extra);
        pool = pool.filter((id) => id !== extra);
      }
    } else {
      const blocked = new Set(
        clusterQueue.filter((c) => c.length > need).flat(),
      );
      const candidates = pool.filter((id) => !blocked.has(id));
      const k = Math.min(need, (candidates.length ? candidates : pool).length);
      if (k > 0) {
        picked = pickBestSubset(candidates.length ? candidates : pool, k, affinity);
      }
    }

    groups[gi].members.push(...picked.slice(0, need));
    const pickedSet = new Set(picked);
    pool = pool.filter((id) => !pickedSet.has(id));
  }

  // 2人部屋に1人だけ残った場合は大きい部屋へ移す
  for (let gi = 0; gi < groups.length; gi++) {
    if (groups[gi].slotSize === 2 && groups[gi].members.length === 1) {
      const id = groups[gi].members.pop();
      const target = findSlotForRemaining(groups);
      if (target >= 0) groups[target].members.push(id);
      else groups[gi].members.push(id);
    }
  }

  for (let gi = 0; gi < groups.length; gi++) {
    if (!activeSet.has(gi)) groups[gi].members = [];
  }

  return pool;
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

export function normalizeResultGroups(groupConfig, groups = []) {
  const slots = buildSlots(normalizeGroupConfig(groupConfig));
  const byName = new Map(groups.map((g) => [g.name, g]));
  return slots.map((s) => {
    const existing = byName.get(s.name);
    return {
      name: s.name,
      slotSize: s.slotSize,
      members: [...(existing?.members ?? [])],
    };
  });
}

export function getUnassignedParticipantIds(participants, groups) {
  const assigned = new Set(groups.flatMap((g) => g.members));
  return (participants || []).filter((p) => !assigned.has(p.id)).map((p) => p.id);
}

export function computeSatisfaction(participants, groups) {
  const n = participants.length;
  return participants.map((p) => {
    const grp = groups.find((g) => g.members.includes(p.id));
    const matched = grp
      ? (p.preferences || []).filter((pref) => grp.members.includes(pref))
      : [];
    const score = matched.reduce((acc, pref) => {
      const idx = (p.preferences || []).indexOf(pref);
      return acc + (n - idx);
    }, 0);
    return { id: p.id, score, matched };
  });
}

export function runMatching(participants, groupConfig) {
  const fixedErr = validateFixedMembers(groupConfig, participants);
  if (fixedErr) throw new Error(fixedErr);

  groupConfig = normalizeGroupConfig(groupConfig);
  const ids = participants.map((p) => p.id);

  const affinity = buildAffinity(participants, ids);
  const groups = buildSlots(groupConfig);

  const fixedIds = new Set();
  groups.forEach((g) => g.members.forEach((id) => fixedIds.add(id)));
  const remainingIds = ids.filter((id) => !fixedIds.has(id));

  const edges = buildEdges(remainingIds, affinity);
  const clusters = buildClusters(remainingIds, edges).sort((a, b) => b.length - a.length);

  let remaining = repackSlotsWithFixed(groups, remainingIds, affinity, clusters);

  remaining = shuffleArray(remaining);
  for (const id of remaining) {
    const gi = findSlotForRemaining(groups);
    if (gi < 0) break;
    groups[gi].members.push(id);
  }

  forceAssignAll(groups, ids, findSlotForRemaining);

  for (let gi = 0; gi < groups.length; gi++) {
    if (groups[gi].members.length > groups[gi].slotSize) {
      groups[gi].members = groups[gi].members.slice(0, groups[gi].slotSize);
    }
  }

  // 未配置が残っていれば空きスロットへ
  const placed = new Set(groups.flatMap((g) => g.members));
  for (const id of ids) {
    if (placed.has(id)) continue;
    const gi = findSlotWithSpace(groups);
    if (gi < 0) break;
    groups[gi].members.push(id);
    placed.add(id);
  }

  const allGroups = groups.map((g) => ({
    members: [...g.members],
    name: g.name,
    slotSize: g.slotSize,
  }));

  return {
    groups: normalizeResultGroups(groupConfig, allGroups),
    satisfaction: computeSatisfaction(participants, allGroups),
  };
}
