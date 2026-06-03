import {
  runMatching,
  normalizeGroupConfig,
  totalGroupSlots,
  buildGroupNameMap,
} from "../src/matching.js";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function makeParticipants(n, prefs = () => []) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `User${i}`,
    preferences: prefs(i) || [],
    submitted: true,
  }));
}

function validate(participants, groupConfig, result) {
  const nameToSize = buildGroupNameMap(groupConfig);
  const capacity = totalGroupSlots(groupConfig);
  const assigned = new Set();

  for (const g of result.groups) {
    const max = nameToSize[g.name] ?? g.slotSize;
    assert(
      g.members.length <= max,
      `グループ「${g.name}」が定員超過: ${g.members.length}人 > ${max}人`,
    );
    if (g.slotSize != null) {
      assert(
        g.members.length <= g.slotSize,
        `slotSize超過: ${g.name} ${g.members.length} > ${g.slotSize}`,
      );
    }
    for (const id of g.members) {
      assert(!assigned.has(id), `重複割当: ${id}`);
      assigned.add(id);
    }
  }

  if (participants.length <= capacity) {
    assert(
      assigned.size === participants.length,
      `未割当あり: ${assigned.size}/${participants.length}人`,
    );
  }

  const singletonInMultiSlot = result.groups.some(
    (g) => g.members.length === 1 && (nameToSize[g.name] ?? 2) >= 2,
  );
  const hasMultiWithSpace =
    result.groups.some((g) => {
      const max = nameToSize[g.name] ?? g.slotSize;
      return g.members.length >= 2 && g.members.length < max;
    }) ||
    result.groups.filter((g) => g.members.length === 0).length > 0;

  return { assigned, capacity, singletonInMultiSlot, hasMultiWithSpace };
}

console.log("TripMatch マッチングアルゴリズム テスト\n");

// 1. 期待例: 9人, 2人×3 + 3人×1
{
  const config = [{ size: 2, count: 3 }, { size: 3, count: 1 }];
  const participants = makeParticipants(9, (i) =>
    i < 8 ? [`p${i + 1}`] : ["p0", "p1"],
  );
  const { groups } = runMatching(participants, config);
  console.log("1. 9人・2人×3・3人×1");
  const sizes = groups.map((g) => g.members.length).sort((a, b) => a - b);
  console.log(`   グループ人数: [${sizes.join(", ")}]`);
  validate(participants, config, { groups });
  assert(sizes.join(",") === "2,2,2,3", `期待 [2,2,2,3] 実際 [${sizes}]`);
  assert(groups.length === 4, `グループ数は4つ: ${groups.length}`);
}

// 2. 旧バグ再現: 2人×4 + 3人×1, 9人 → 4人グループが出ない
{
  const config = [{ size: 2, count: 4 }, { size: 3, count: 1 }];
  const participants = makeParticipants(9);
  const { groups } = runMatching(participants, config);
  console.log("2. 旧バグケース（2人枠に4人が入らない）");
  for (const g of groups) {
    console.log(`   ${g.name}: ${g.members.length}人 (上限${g.slotSize})`);
    assert(g.members.length <= 2 || g.slotSize === 3, `${g.name} が4人以上`);
    assert(g.members.length <= 3, `${g.name} が定員超過`);
  }
  validate(participants, config, { groups });
}

// 3. 相互希望ペアが同じ2人グループに
{
  const config = [{ size: 2, count: 2 }];
  const participants = [
    { id: "a", name: "A", preferences: ["b"], submitted: true },
    { id: "b", name: "B", preferences: ["a"], submitted: true },
    { id: "c", name: "C", preferences: ["d"], submitted: true },
    { id: "d", name: "D", preferences: ["c"], submitted: true },
  ];
  const { groups } = runMatching(participants, config);
  console.log("3. 相互希望ペア");
  const together = (x, y) =>
    groups.some((g) => g.members.includes(x) && g.members.includes(y));
  assert(together("a", "b"), "AとBが同グループ");
  assert(together("c", "d"), "CとDが同グループ");
  validate(participants, config, { groups });
}

// 4. ランダム振り分け100回 — 定員超過なし・全員割当
{
  console.log("4. ランダム100回（不変条件）");
  const config = [{ size: 2, count: 3 }, { size: 3, count: 1 }];
  let trials = 0;
  for (let t = 0; t < 100; t++) {
    const participants = makeParticipants(9, (i) => {
      const prefs = [];
      if (i > 0) prefs.push(`p${i - 1}`);
      if (i < 8) prefs.push(`p${i + 1}`);
      return prefs;
    });
    const { groups } = runMatching(participants, config);
    validate(participants, config, { groups });
    for (const g of groups) {
      if (g.members.length > g.slotSize) trials++;
    }
  }
  assert(trials === 0, `100回中 ${trials} 回で定員超過`);
}

// 5. 定員ぴったりで過不足なし
{
  const config = [{ size: 2, count: 2 }, { size: 3, count: 1 }];
  const participants = makeParticipants(7);
  const { groups } = runMatching(participants, config);
  console.log("5. 7人・2人×2・3人×1");
  const total = groups.reduce((s, g) => s + g.members.length, 0);
  assert(total === 7, `合計7人: ${total}`);
  validate(participants, config, { groups });
}

console.log(`\n${"─".repeat(40)}`);
console.log(`結果: ${passed} 成功, ${failed} 失敗`);
process.exit(failed > 0 ? 1 : 0);
