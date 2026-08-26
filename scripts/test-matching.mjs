import {
  runMatching,
  normalizeGroupConfig,
  totalGroupSlots,
  buildGroupNameMap,
  validateFixedMembers,
  expandGroupSlots,
  getUnassignedParticipantIds,
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
  const expectedGroupCount = expandGroupSlots(groupConfig).length;
  const assigned = new Set();

  assert(
    result.groups.length === expectedGroupCount,
    `グループ数が設定と不一致: ${result.groups.length} ≠ ${expectedGroupCount}`,
  );

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
      if (participants.length === capacity) {
        assert(
          g.members.length === g.slotSize,
          `定員と一致しない: ${g.name} ${g.members.length} ≠ ${g.slotSize}`,
        );
      }
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
    const unassigned = getUnassignedParticipantIds(participants, result.groups);
    assert(unassigned.length === 0, `未配置メンバー: ${unassigned.join(", ")}`);
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

// 2. 旧バグ再現: 2人×4 + 3人×1, 9人 → 定員ぴったり・4人グループなし
{
  const config = [{ size: 2, count: 4 }, { size: 3, count: 1 }];
  const participants = makeParticipants(9);
  const { groups } = runMatching(participants, config);
  console.log("2. 旧バグケース（2人枠に4人が入らない）");
  const sizes = groups.map((g) => g.members.length).sort((a, b) => a - b);
  console.log(`   グループ人数: [${sizes.join(", ")}]`);
  assert(groups.length === 5, `設定グループ数5: ${groups.length}`);
  for (const g of groups) {
    if (g.members.length > 0) {
      assert(g.members.length === g.slotSize, `${g.name} が定員と不一致`);
      assert(g.members.length <= 3, `${g.name} が定員超過`);
    }
  }
  assert(!sizes.some((s) => s >= 4), "4人以上のグループが存在");
  validate(participants, config, { groups });
}

// 2b. 4人相互希望クラスター → 4人スロットへ
{
  const config = [{ size: 4, count: 1 }, { size: 2, count: 2 }];
  const participants = [
    { id: "a", name: "A", preferences: ["b", "c", "d"], submitted: true },
    { id: "b", name: "B", preferences: ["a", "c", "d"], submitted: true },
    { id: "c", name: "C", preferences: ["a", "b", "d"], submitted: true },
    { id: "d", name: "D", preferences: ["a", "b", "c"], submitted: true },
    { id: "e", name: "E", preferences: ["f"], submitted: true },
    { id: "f", name: "F", preferences: ["e"], submitted: true },
  ];
  const { groups } = runMatching(participants, config);
  console.log("2b. 4人クラスター → 4人スロット");
  const four = groups.find((g) => g.slotSize === 4);
  assert(four && four.members.length === 4, "4人スロットに4人");
  assert(
    ["a", "b", "c", "d"].every((id) => four.members.includes(id)),
    "相互希望4人が同一グループ",
  );
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

// 5. 定員ぴったりで過不足なし（全グループ表示）
{
  const config = [{ size: 2, count: 2 }, { size: 3, count: 1 }];
  const participants = makeParticipants(7);
  const { groups } = runMatching(participants, config);
  console.log("5. 7人・2人×2・3人×1");
  const total = groups.reduce((s, g) => s + g.members.length, 0);
  assert(total === 7, `合計7人: ${total}`);
  assert(groups.length === 3, `3グループすべて表示: ${groups.length}`);
  validate(participants, config, { groups });
}

// 5b. 人数 < 定員でも全グループ名を返し空きグループを表示
{
  const config = [{ size: 2, count: 2 }, { size: 3, count: 1 }];
  const participants = makeParticipants(5);
  const { groups } = runMatching(participants, config);
  console.log("5b. 5人・2人×2・3人×1（空きグループあり）");
  assert(groups.length === 3, `3グループすべて表示: ${groups.length}`);
  assert(groups.some((g) => g.members.length === 0), "空きグループが1つ以上");
  validate(participants, config, { groups });
}

// 6. 再マッチング: データ保持・status/result リセット・再実行
{
  console.log("6. 再マッチング（データ保持・再実行）");
  const config = [{ size: 2, count: 2 }];
  const participants = [
    { id: "a", name: "A", preferences: ["b"], submitted: true },
    { id: "b", name: "B", preferences: ["a"], submitted: true },
    { id: "c", name: "C", preferences: ["d"], submitted: true },
    { id: "d", name: "D", preferences: ["c"], submitted: true },
  ];
  const session = {
    eventName: "テスト",
    groupConfig: config,
    participants: JSON.parse(JSON.stringify(participants)),
    joinPassword: "1234",
    status: "matched",
    result: runMatching(participants, config),
  };
  const beforeIds = session.participants.map((p) => p.id);
  const beforePrefs = session.participants.map((p) => [...(p.preferences || [])]);

  // handleRematch 相当
  session.result = null;
  session.status = "waiting";

  assert(session.result === null, "result が null");
  assert(session.status === "waiting", "status が waiting");
  assert(session.joinPassword === "1234", "パスワード保持");
  assert(
    session.participants.every((p, i) => p.id === beforeIds[i]),
    "参加者ID保持",
  );
  assert(
    session.participants.every(
      (p, i) => JSON.stringify(p.preferences) === JSON.stringify(beforePrefs[i]),
    ),
    "希望データ保持",
  );

  // handleMatch 相当（複数回）
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const { groups, satisfaction } = runMatching(session.participants, session.groupConfig);
    session.status = "matched_pending";
    session.result = { groups, satisfaction };
    runs.push(groups.map((g) => g.members.sort().join(",")).sort().join("|"));
  }
  assert(session.status === "matched_pending", "再実行後 status が matched_pending");
  assert(session.result?.groups?.length === 2, "2グループ生成");
  assert(
    runs.every((r) => r === "a,b|c,d"),
    "希望ペアが同グループに維持される",
  );
}

// 7. 10人・定員に余裕・希望なし → 全員が結果に含まれる
{
  const config = [{ size: 2, count: 4 }, { size: 3, count: 1 }];
  const participants = makeParticipants(10);
  const { groups } = runMatching(participants, config);
  console.log("7. 10人・空き部屋あり・希望なし");
  const assigned = new Set();
  groups.forEach((g) => g.members.forEach((id) => assigned.add(id)));
  console.log(`   配置: ${groups.map((g) => g.members.length).join(", ")}人 (${groups.length}グループ)`);
  assert(assigned.size === 10, `10人全員がグループに入る: ${assigned.size}/10`);
  assert(groups.length === 5, `設定グループ数5: ${groups.length}`);
  validate(participants, config, { groups });
}

// 8. 固定メンバー配置
{
  console.log("8. 固定メンバー配置");
  const config = [
    { id: 1, size: 2, count: 2, name: "A", fixedMembers: [["p0"], ["p1"]] },
  ];
  const participants = makeParticipants(4);
  assert(validateFixedMembers(config, participants) === null, "固定メンバー検証OK");
  const { groups } = runMatching(participants, config);
  const g0 = groups.find((g) => g.name === "A1");
  const g1 = groups.find((g) => g.name === "A2");
  assert(g0?.members.includes("p0"), "p0 が A1 に固定");
  assert(g1?.members.includes("p1"), "p1 が A2 に固定");
  assert(groups.flatMap((g) => g.members).length === 4, "全員配置");
  const overConfig = [{ id: 1, size: 2, count: 1, name: "B", fixedMembers: ["p0", "p1", "p2"] }];
  assert(
    validateFixedMembers(overConfig, participants) !== null,
    "定員超過の固定メンバーはエラー",
  );
}

// 9. 20人・2人×5 + 3人×2 + 4人×1 — 全員配置・優先度（ペア→2人部屋、三重→3人部屋、余り→3人+）
{
  console.log("9. 20人・2人×5 + 3人×2 + 4人×1（優先度テスト）");
  const config = [
    { size: 2, count: 5, name: "二人部屋" },
    { size: 3, count: 2, name: "三人部屋" },
    { size: 4, count: 1, name: "四人部屋" },
  ];

  const together = (groups, a, b) =>
    groups.some((g) => g.members.includes(a) && g.members.includes(b));

  const groupOf = (groups, id) => groups.find((g) => g.members.includes(id));

  function make20Participants() {
    const participants = [];
    for (let i = 0; i < 10; i += 2) {
      participants.push({ id: `p${i}`, name: `P${i}`, preferences: [`p${i + 1}`], submitted: true });
      participants.push({ id: `p${i + 1}`, name: `P${i + 1}`, preferences: [`p${i}`], submitted: true });
    }
    const triple = ["p10", "p11", "p12"];
    triple.forEach((id) => {
      participants.push({
        id,
        name: id,
        preferences: triple.filter((x) => x !== id),
        submitted: true,
      });
    });
    for (let i = 13; i < 20; i++) {
      participants.push({ id: `p${i}`, name: `P${i}`, preferences: [], submitted: true });
    }
    return participants;
  }

  const participants = make20Participants();
  assert(totalGroupSlots(config) === 20, "定員合計20");
  assert(participants.length === 20, "参加者20人");

  const { groups } = runMatching(participants, config);
  validate(participants, config, { groups });

  const assigned = new Set(groups.flatMap((g) => g.members));
  assert(assigned.size === 20, `全員配置: ${assigned.size}/20`);
  assert(groups.length === 8, `8グループ: ${groups.length}`);

  const twoGroups = groups.filter((g) => g.slotSize === 2);
  const threeGroups = groups.filter((g) => g.slotSize === 3);
  const fourGroups = groups.filter((g) => g.slotSize === 4);
  assert(twoGroups.length === 5, "2人部屋5つ");
  assert(threeGroups.length === 2, "3人部屋2つ");
  assert(fourGroups.length === 1, "4人部屋1つ");

  for (let i = 0; i < 10; i += 2) {
    const a = `p${i}`;
    const b = `p${i + 1}`;
    assert(together(groups, a, b), `${a}と${b}が同グループ`);
    const g = groupOf(groups, a);
    assert(g.slotSize === 2, `${a}${b}は2人部屋に配置 (${g.name}, ${g.members.length}人)`);
  }

  const tripleIds = ["p10", "p11", "p12"];
  assert(
    tripleIds.every((id) => groupOf(groups, id).slotSize === 3),
    "相互希望3人組は3人部屋に配置",
  );
  assert(
    tripleIds.every((id) => groupOf(groups, id) === groupOf(groups, "p10")),
    "3人組は同一グループ",
  );

  for (let i = 13; i < 20; i++) {
    const g = groupOf(groups, `p${i}`);
    assert(g.slotSize >= 3, `希望なし p${i} は3人以上の部屋 (${g.name}, ${g.slotSize}人枠)`);
  }

  console.log("   配置:");
  groups
    .sort((a, b) => a.slotSize - b.slotSize || a.name.localeCompare(b.name))
    .forEach((g) => {
      console.log(`     ${g.name} (${g.slotSize}人枠): ${g.members.join(", ")}`);
    });

  // ランダム希望100回 — 全員配置・定員遵守
  let overflowTrials = 0;
  for (let t = 0; t < 100; t++) {
    const rnd = makeParticipants(20, (i) => {
      const prefs = [];
      if (i > 0 && Math.random() < 0.4) prefs.push(`p${i - 1}`);
      if (i < 19 && Math.random() < 0.4) prefs.push(`p${i + 1}`);
      return prefs;
    });
    const r = runMatching(rnd, config);
    validate(rnd, config, r);
    if (r.groups.some((g) => g.members.length > g.slotSize)) overflowTrials++;
  }
  assert(overflowTrials === 0, `20人ランダム100回で定員超過なし (${overflowTrials}回)`);
}

console.log(`\n${"─".repeat(40)}`);
console.log(`結果: ${passed} 成功, ${failed} 失敗`);
process.exit(failed > 0 ? 1 : 0);
