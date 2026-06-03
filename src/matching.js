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

export function runMatching(participants, groupConfig) {
  groupConfig = normalizeGroupConfig(groupConfig);
  const ids = participants.map((p) => p.id);
  const n = ids.length;

  const affinity = {};
  ids.forEach((a) => { affinity[a] = {}; ids.forEach((b) => { affinity[a][b] = 0; }); });
  participants.forEach((p) => {
    (p.preferences || []).forEach((prefId, idx) => {
      if (affinity[p.id][prefId] !== undefined) {
        const s = n - idx;
        affinity[p.id][prefId] += s;
        affinity[prefId][p.id] += s;
      }
    });
  });

  const edges = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      const score = affinity[a][b] + affinity[b][a];
      if (score > 0) edges.push({ a, b, score });
    }
  edges.sort((x, y) => y.score - x.score);

  const slots = [];
  groupConfig.forEach((c) => {
    for (let i = 0; i < c.count; i++) {
      const name = c.name
        ? c.count === 1 ? c.name : `${c.name}${i + 1}`
        : `グループ${slots.length + 1}`;
      slots.push({ size: c.size, name });
    }
  });

  const groups = slots.map((s) => ({
    members: [],
    slotSize: s.size,
    name: s.name,
  }));

  const assigned = new Set();

  const groupIndexOf = (id) => groups.findIndex((g) => g.members.includes(id));

  const freeSpots = (gi) => groups[gi].slotSize - groups[gi].members.length;

  const findGroupWithSpace = (minSpaces) => {
    const viable = groups
      .map((g, i) => ({ i, free: freeSpots(i) }))
      .filter((x) => x.free >= minSpaces);
    if (!viable.length) return -1;
    viable.sort((a, b) => {
      const tightA = a.free - minSpaces;
      const tightB = b.free - minSpaces;
      if (tightA !== tightB) return tightA - tightB;
      return a.free - b.free;
    });
    return viable[0].i;
  };

  const addToGroup = (gi, id) => {
    if (gi < 0 || assigned.has(id) || groups[gi].members.length >= groups[gi].slotSize) return false;
    groups[gi].members.push(id);
    assigned.add(id);
    return true;
  };

  for (const { a, b } of edges) {
    const ia = groupIndexOf(a);
    const ib = groupIndexOf(b);
    if (ia !== -1 && ib !== -1) continue;
    if (ia !== -1) {
      addToGroup(ia, b);
      continue;
    }
    if (ib !== -1) {
      addToGroup(ib, a);
      continue;
    }
    const gi = findGroupWithSpace(2);
    if (gi !== -1) {
      addToGroup(gi, a);
      addToGroup(gi, b);
    }
  }

  const unassigned = shuffleArray(ids.filter((id) => !assigned.has(id)));
  for (const id of unassigned) {
    const candidates = groups.map((_, i) => i).filter((i) => freeSpots(i) > 0);
    if (!candidates.length) break;
    const gi = candidates[Math.floor(Math.random() * candidates.length)];
    addToGroup(gi, id);
  }

  for (const id of ids) {
    if (assigned.has(id)) continue;
    for (let i = 0; i < groups.length; i++) {
      if (freeSpots(i) > 0) {
        addToGroup(i, id);
        break;
      }
    }
  }

  for (const g of groups) {
    if (g.members.length > g.slotSize) {
      g.members = g.members.slice(0, g.slotSize);
    }
  }

  const result = groups
    .filter((g) => g.members.length > 0)
    .map((g) => ({ members: [...g.members], name: g.name, slotSize: g.slotSize }));

  const satisfaction = participants.map((p) => {
    const grp = result.find((g) => g.members.includes(p.id));
    const matched = grp ? (p.preferences || []).filter((pref) => grp.members.includes(pref)) : [];
    const score = matched.reduce((acc, pref) => {
      const idx = (p.preferences || []).indexOf(pref);
      return acc + (n - idx);
    }, 0);
    return { id: p.id, score, matched };
  });

  return { groups: result, satisfaction };
}
