import { useState, useEffect, useCallback, useRef } from "react";
import { ref, set, get, remove } from "firebase/database";
import { db } from "./firebase";

// ─── Matching Algorithm ────────────────────────────────────────────────────────
function runMatching(participants, groupConfig) {
  groupConfig = normalizeGroupConfig(groupConfig);
  const ids = participants.map((p) => p.id);
  const n = participants.length;

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

  // Expand config into named slots
  const slots = [];
  groupConfig.forEach((c) => {
    for (let i = 0; i < c.count; i++) {
      const name = c.name
        ? c.count === 1 ? c.name : `${c.name}${i + 1}`
        : `グループ${slots.length + 1}`;
      slots.push({ size: c.size, name });
    }
  });

  const group = {};
  ids.forEach((id) => { group[id] = null; });
  const groups = slots.map((s) => ({ members: new Set(), slotSize: s.size, name: s.name }));

  const getFreeSlot = () => groups.findIndex((g) => g.members.size < g.slotSize);

  for (const { a, b } of edges) {
    const ga = group[a], gb = group[b];
    if (ga === null && gb === null) {
      const sl = getFreeSlot();
      if (sl === -1) continue;
      if (groups[sl].slotSize >= 2) { groups[sl].members.add(a); groups[sl].members.add(b); group[a] = sl; group[b] = sl; }
    } else if (ga === null && gb !== null) {
      if (groups[gb].members.size < groups[gb].slotSize) { groups[gb].members.add(a); group[a] = gb; }
    } else if (ga !== null && gb === null) {
      if (groups[ga].members.size < groups[ga].slotSize) { groups[ga].members.add(b); group[b] = ga; }
    } else if (ga !== gb) {
      const combined = groups[ga].members.size + groups[gb].members.size;
      if (combined <= groups[ga].slotSize) {
        groups[gb].members.forEach((id) => { groups[ga].members.add(id); group[id] = ga; });
        groups[gb].members = new Set();
      }
    }
  }

  ids.filter((id) => group[id] === null).forEach((id) => {
    const sl = getFreeSlot();
    if (sl !== -1) { groups[sl].members.add(id); group[id] = sl; }
    else { const last = groups.length - 1; groups[last].members.add(id); group[id] = last; }
  });

  const result = groups.filter((g) => g.members.size > 0)
    .map((g) => ({ members: [...g.members], name: g.name }));

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

// ─── Firebase helpers ──────────────────────────────────────────────────────────
async function saveSession(sessionId, data) {
  // Firebase doesn't allow undefined values — strip them
  const clean = JSON.parse(JSON.stringify(data));
  await set(ref(db, `sessions/${sessionId}`), clean);
}

async function loadSession(sessionId) {
  const snap = await get(ref(db, `sessions/${sessionId}`));
  if (!snap.exists()) return null;
  const data = snap.val();
  // Ensure participants is always an array
  if (data && !Array.isArray(data.participants)) {
    data.participants = data.participants ? Object.values(data.participants) : [];
  }
  return data;
}

async function deleteSession(sessionId) {
  await remove(ref(db, `sessions/${sessionId}`));
}

const unlockKey = (sessionId) => `tripmatch_unlock_${sessionId}`;
const participantKey = (sessionId) => `tripmatch_participant_${sessionId}`;

function saveParticipantIdentity(sessionId, { myId, myName }) {
  sessionStorage.setItem(
    participantKey(sessionId),
    JSON.stringify({ sessionId, myId, myName }),
  );
}

function loadParticipantIdentity(sessionId) {
  try {
    const raw = sessionStorage.getItem(participantKey(sessionId));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.sessionId !== sessionId || !data.myId || !data.myName) return null;
    return data;
  } catch {
    return null;
  }
}

function clearParticipantIdentity(sessionId) {
  sessionStorage.removeItem(participantKey(sessionId));
}

const ORGANIZER_SESSION_KEY = "tripmatch_organizer_sessionId";
const ORGANIZER_STEP_KEY = "tripmatch_organizer_step";
const ORGANIZER_STEPS_PERSIST = new Set(["dashboard", "result"]);

function saveOrganizerState({ sessionId, orgStep }) {
  if (!sessionId || !ORGANIZER_STEPS_PERSIST.has(orgStep)) return;
  localStorage.setItem(ORGANIZER_SESSION_KEY, sessionId);
  localStorage.setItem(ORGANIZER_STEP_KEY, orgStep);
}

function loadOrganizerState() {
  try {
    let sessionId = localStorage.getItem(ORGANIZER_SESSION_KEY);
    let orgStep = localStorage.getItem(ORGANIZER_STEP_KEY);
    if (!sessionId) {
      const legacy = sessionStorage.getItem("tripmatch_organizer");
      if (legacy) {
        const data = JSON.parse(legacy);
        sessionStorage.removeItem("tripmatch_organizer");
        if (data.sessionId && ORGANIZER_STEPS_PERSIST.has(data.orgStep)) {
          saveOrganizerState({ sessionId: data.sessionId, orgStep: data.orgStep });
          return { sessionId: data.sessionId, orgStep: data.orgStep };
        }
      }
    }
    if (!sessionId || !orgStep || !ORGANIZER_STEPS_PERSIST.has(orgStep)) return null;
    return { sessionId, orgStep };
  } catch {
    return null;
  }
}

function clearOrganizerState() {
  localStorage.removeItem(ORGANIZER_SESSION_KEY);
  localStorage.removeItem(ORGANIZER_STEP_KEY);
  try {
    sessionStorage.removeItem("tripmatch_organizer");
  } catch {
    /* old key cleanup */
  }
}

function isValidJoinPassword(pw) {
  return /^\d{4}$/.test(pw);
}

function digitsOnly(value, maxLen = 4) {
  return value.replace(/\D/g, "").slice(0, maxLen);
}

function effectiveGroupSize(c) {
  return typeof c.size === "number" && !Number.isNaN(c.size) ? c.size : 2;
}

function effectiveGroupCount(c) {
  return typeof c.count === "number" && !Number.isNaN(c.count) ? c.count : 1;
}

function normalizeGroupConfig(groupConfig) {
  return groupConfig.map((c) => ({
    ...c,
    size: effectiveGroupSize(c),
    count: effectiveGroupCount(c),
  }));
}

function configNumDisplay(n) {
  return typeof n === "number" && !Number.isNaN(n) ? String(n) : "";
}

// ─── Design tokens ────────────────────────────────────────────────────────────
const C = {
  bg: "#0a0a0f",
  surface: "#12121a",
  surface2: "#1a1a28",
  border: "#2a2a3a",
  accent: "#7c6af7",
  accentLight: "#a89cf8",
  teal: "#4ecdc4",
  red: "#ff6b6b",
  text: "#e8e8f8",
  muted: "#6b6b8a",
  white: "#ffffff",
};

const GROUP_COLORS = ["#7c6af7","#4ecdc4","#f7c16a","#ff6b6b","#6af7b8","#f76af7","#6ab8f7","#f7956a","#a8f76a","#f76a8e"];

const s = {
  btn: (variant = "primary") => ({
    fontFamily: "inherit", cursor: "pointer", border: "none", borderRadius: 10,
    fontWeight: 700, fontSize: 14, padding: "11px 20px", transition: "all 0.18s",
    ...(variant === "primary" ? { background: C.accent, color: C.white } :
        variant === "teal"    ? { background: C.teal, color: "#000" } :
        variant === "ghost"   ? { background: "none", border: `1px solid ${C.border}`, color: C.muted } :
        variant === "danger"  ? { background: "#ff6b6b20", border: `1px solid ${C.red}40`, color: C.red } :
                                { background: C.surface2, color: C.text }),
  }),
  input: {
    background: C.surface, border: `1px solid ${C.border}`, color: C.text,
    borderRadius: 8, padding: "9px 13px", fontSize: 14, fontFamily: "inherit",
    outline: "none", width: "100%", boxSizing: "border-box",
  },
  card: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 18 },
  label: { fontSize: 11, letterSpacing: 2, color: C.muted, textTransform: "uppercase", marginBottom: 6, display: "block" },
};

// ─── Shared components ─────────────────────────────────────────────────────────
function Tag({ children, color }) {
  return (
    <span style={{
      background: color + "25", border: `1px solid ${color}50`,
      color, borderRadius: 20, padding: "2px 10px", fontSize: 11, fontWeight: 600,
    }}>{children}</span>
  );
}

function StatusBadge({ status }) {
  const map = {
    waiting: { label: "参加者募集中", color: C.teal },
    ready:   { label: "希望収集中",   color: "#f7c16a" },
    matched: { label: "マッチング完了", color: C.accent },
  };
  const { label, color } = map[status] || map.waiting;
  return <Tag color={color}>{label}</Tag>;
}

function previewGroupNames(groupConfig) {
  const names = [];
  groupConfig.forEach((c) => {
    const count = effectiveGroupCount(c);
    for (let i = 0; i < count; i++)
      names.push(c.name ? (count === 1 ? c.name : `${c.name}${i + 1}`) : `グループ${names.length + 1}`);
  });
  return names;
}

function GroupConfigEditor({ groupConfig, setGroupConfig, onChange }) {
  const update = (next) => {
    setGroupConfig(next);
    onChange?.();
  };
  const totalSlots  = groupConfig.reduce((a, c) => a + effectiveGroupSize(c) * effectiveGroupCount(c), 0);
  const totalGroups = groupConfig.reduce((a, c) => a + effectiveGroupCount(c), 0);
  const previewNames = previewGroupNames(groupConfig);

  return (
    <>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>部屋番号・チーム名など名前をつけられます</div>
      {groupConfig.map((c) => (
        <div key={c.id} style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
          <input
            style={{ ...s.input, padding: "8px 12px" }}
            placeholder="名前（例: 201号室, Aチーム）"
            value={c.name}
            onChange={(e) => update(groupConfig.map((x) => x.id === c.id ? { ...x, name: e.target.value } : x))}
          />
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={configNumDisplay(c.size)}
            placeholder="2"
            onChange={(e) => {
              const raw = digitsOnly(e.target.value, 2);
              const size = raw === "" ? null : Math.min(20, Math.max(2, parseInt(raw, 10) || 2));
              update(groupConfig.map((x) => x.id === c.id ? { ...x, size } : x));
            }}
            onBlur={() => {
              if (c.size == null) update(groupConfig.map((x) => x.id === c.id ? { ...x, size: 2 } : x));
            }}
            style={{ ...s.input, width: 56, textAlign: "center", padding: "8px 4px", flexShrink: 0 }}
          />
          <span style={{ color: C.muted, fontSize: 13, whiteSpace: "nowrap" }}>人 ×</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={configNumDisplay(c.count)}
            placeholder="1"
            onChange={(e) => {
              const raw = digitsOnly(e.target.value, 2);
              const count = raw === "" ? null : Math.min(50, Math.max(1, parseInt(raw, 10) || 1));
              update(groupConfig.map((x) => x.id === c.id ? { ...x, count } : x));
            }}
            onBlur={() => {
              if (c.count == null) update(groupConfig.map((x) => x.id === c.id ? { ...x, count: 1 } : x));
            }}
            style={{ ...s.input, width: 52, textAlign: "center", padding: "8px 4px", flexShrink: 0 }}
          />
          <button
            onClick={() => update(groupConfig.filter((x) => x.id !== c.id))}
            disabled={groupConfig.length <= 1}
            style={{
              background: "none", border: "none", color: C.red, cursor: groupConfig.length <= 1 ? "not-allowed" : "pointer",
              fontSize: 20, padding: "0 4px", flexShrink: 0, opacity: groupConfig.length <= 1 ? 0.35 : 1,
            }}
          >×</button>
        </div>
      ))}
      <button onClick={() => update([...groupConfig, { id: Date.now(), size: 2, count: 1, name: "" }])}
        style={{ ...s.btn("ghost"), width: "100%", marginTop: 4 }}>+ 構成を追加</button>
      <div style={{ marginTop: 16, padding: "12px 16px", background: C.surface2, borderRadius: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
          <span style={{ color: C.muted }}>合計定員</span><span style={{ fontWeight: 700 }}>{totalSlots}人</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
          <span style={{ color: C.muted }}>グループ数</span><span style={{ fontWeight: 700 }}>{totalGroups}グループ</span>
        </div>
        {previewNames.length > 0 && (
          <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6 }}>
            {previewNames.map((name, i) => <Tag key={i} color={GROUP_COLORS[i % GROUP_COLORS.length]}>{name}</Tag>)}
          </div>
        )}
      </div>
    </>
  );
}

function totalGroupSlots(groupConfig) {
  return groupConfig.reduce((a, c) => a + effectiveGroupSize(c) * effectiveGroupCount(c), 0);
}

// ─── Organizer: Setup ──────────────────────────────────────────────────────────
function OrgSetup({ onStart }) {
  const [eventName, setEventName] = useState("団体旅行2025");
  const [joinPassword, setJoinPassword] = useState("");
  const [setupErr, setSetupErr] = useState("");
  const [groupConfig, setGroupConfig] = useState([{ id: 1, size: 2, count: 2, name: "" }]);

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, color: C.accent, marginBottom: 8 }}>ORGANIZER SETUP</div>
        <h2 style={{ margin: 0, fontSize: 24, fontWeight: 900 }}>イベント設定</h2>
      </div>

      <div style={{ ...s.card, marginBottom: 16 }}>
        <label style={s.label}>イベント名</label>
        <input style={s.input} value={eventName} onChange={(e) => setEventName(e.target.value)} placeholder="例：春合宿2025" />
      </div>

      <div style={{ ...s.card, marginBottom: 16 }}>
        <label style={s.label}>グループ構成</label>
        <GroupConfigEditor groupConfig={groupConfig} setGroupConfig={setGroupConfig} />
      </div>

      <div style={{ ...s.card, marginBottom: 16 }}>
        <label style={s.label}>参加パスワード（4桁）</label>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>参加者に別途伝えてください（URLだけでは参加できません）</div>
        <input
          style={{ ...s.input, letterSpacing: 8, fontSize: 22, textAlign: "center", fontFamily: "monospace" }}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          value={joinPassword}
          onChange={(e) => { setJoinPassword(digitsOnly(e.target.value)); setSetupErr(""); }}
          placeholder="••••"
        />
        {setupErr && <div style={{ color: C.red, fontSize: 13, marginTop: 8 }}>{setupErr}</div>}
      </div>

      <button
        onClick={() => {
          const pin = digitsOnly(joinPassword);
          if (!isValidJoinPassword(pin)) {
            setSetupErr("4桁の数字を設定してください");
            return;
          }
          onStart(eventName, normalizeGroupConfig(groupConfig), pin);
        }}
        style={{ ...s.btn("primary"), width: "100%", padding: 16, fontSize: 16 }}>
        参加URLを発行する →
      </button>
    </div>
  );
}

// ─── Organizer: Dashboard ──────────────────────────────────────────────────────
function OrgDashboard({ session, sessionId, onRefresh, onMatch, onReset, onSaveSettings }) {
  const [copied, setCopied] = useState(false);
  const [eventName, setEventName] = useState(session.eventName);
  const [groupConfig, setGroupConfig] = useState(session.groupConfig);
  const [settingsErr, setSettingsErr] = useState("");
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(false);
  const origin = window.location.origin + window.location.pathname;
  const participantUrl = `${origin}?join=${sessionId}`;
  const participantCount = (session.participants || []).length;

  useEffect(() => {
    if (!dirtyRef.current) {
      setEventName(session.eventName);
      setGroupConfig(session.groupConfig);
    }
  }, [session.eventName, session.groupConfig]);

  const markDirty = () => { dirtyRef.current = true; };

  const copy = () => {
    navigator.clipboard.writeText(participantUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const saveSettings = async () => {
    if (!eventName.trim()) {
      setSettingsErr("イベント名を入力してください");
      return;
    }
    const slots = totalGroupSlots(groupConfig);
    if (slots < participantCount) {
      setSettingsErr(`合計定員（${slots}人）は参加者数（${participantCount}人）以上にしてください`);
      return;
    }
    setSaving(true); setSettingsErr("");
    const ok = await onSaveSettings(eventName.trim(), normalizeGroupConfig(groupConfig));
    if (ok) dirtyRef.current = false;
    else setSettingsErr("保存に失敗しました");
    setSaving(false);
  };

  const submitted = (session.participants || []).filter((p) => p.submitted);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 3, color: C.accent, marginBottom: 4 }}>ORGANIZER</div>
          <div style={{ marginTop: 6 }}><StatusBadge status={session.status} /></div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onRefresh} style={{ ...s.btn("ghost"), padding: "8px 14px", fontSize: 13 }}>↻ 更新</button>
          <button onClick={onReset} style={{ ...s.btn("danger"), padding: "8px 14px", fontSize: 13 }}>リセット</button>
        </div>
      </div>

      <div style={{ ...s.card, marginBottom: 16 }}>
        <label style={s.label}>イベント名</label>
        <input
          style={s.input}
          value={eventName}
          onChange={(e) => { setEventName(e.target.value); markDirty(); setSettingsErr(""); }}
        />
      </div>

      <div style={{ ...s.card, marginBottom: 16, borderColor: C.accent + "40" }}>
        <label style={s.label}>参加者用URL</label>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>このURLをLINEなどで参加者に共有してください</div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{
            flex: 1, background: C.surface2, border: `1px solid ${C.border}`,
            borderRadius: 8, padding: "9px 13px", fontSize: 12, color: C.muted,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{participantUrl}</div>
          <button onClick={copy} style={{ ...s.btn("primary"), whiteSpace: "nowrap", padding: "9px 16px" }}>
            {copied ? "✓ コピー済" : "コピー"}
          </button>
        </div>
      </div>

      {session.joinPassword && (
        <div style={{ ...s.card, marginBottom: 16, borderColor: C.teal + "40" }}>
          <label style={s.label}>参加パスワード</label>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>URLとは別に、LINEなどで参加者へ共有してください</div>
          <div style={{
            fontFamily: "monospace", fontSize: 28, fontWeight: 900, letterSpacing: 12,
            textAlign: "center", padding: "12px 0", color: C.teal,
          }}>{session.joinPassword}</div>
        </div>
      )}

      <div style={{ ...s.card, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <label style={{ ...s.label, margin: 0 }}>参加者状況</label>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.teal }}>
            {submitted.length} / {(session.participants || []).length} 人 提出済
          </span>
        </div>
        {(session.participants || []).length === 0 ? (
          <div style={{ textAlign: "center", color: C.muted, padding: "24px 0", fontSize: 14 }}>
            まだ参加者がいません。URLを共有してください。
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(session.participants || []).map((p) => (
              <div key={p.id} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                background: C.surface2, borderRadius: 9, padding: "10px 14px",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: "50%",
                    background: p.submitted ? C.teal : C.border,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 13, fontWeight: 700, color: p.submitted ? "#000" : C.muted,
                  }}>{(p.name || "?").charAt(0)}</div>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</span>
                </div>
                {p.submitted
                  ? <Tag color={C.teal}>提出済 ({(p.preferences || []).length}人希望)</Tag>
                  : <Tag color={C.muted}>未提出</Tag>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ ...s.card, marginBottom: 16 }}>
        <label style={s.label}>グループ構成</label>
        {participantCount > 0 && (
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
            参加者 {participantCount} 人 — 合計定員は参加者数以上にしてください
          </div>
        )}
        <GroupConfigEditor
          groupConfig={groupConfig}
          setGroupConfig={setGroupConfig}
          onChange={() => { markDirty(); setSettingsErr(""); }}
        />
        {settingsErr && <div style={{ color: C.red, fontSize: 13, marginTop: 10 }}>{settingsErr}</div>}
        <button
          onClick={saveSettings}
          disabled={saving}
          style={{ ...s.btn("primary"), width: "100%", marginTop: 14, opacity: saving ? 0.6 : 1 }}
        >
          {saving ? "保存中..." : "構成を保存"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <button
          onClick={onMatch}
          disabled={(session.participants || []).length < 2}
          style={{
            ...s.btn("teal"), width: "100%", padding: 14, fontSize: 15,
            opacity: (session.participants || []).length < 2 ? 0.5 : 1,
          }}
        >
          🎲 マッチング実行 ({submitted.length}/{(session.participants || []).length}人)
        </button>
      </div>
    </div>
  );
}

// ─── Organizer: Result ─────────────────────────────────────────────────────────
function OrgResult({ session, onReset }) {
  const { groups, satisfaction } = session.result;
  const getName = (id) => (session.participants || []).find((p) => p.id === id)?.name || id;
  const getSat  = (id) => satisfaction.find((s) => s.id === id);
  const totalScore = satisfaction.reduce((a, s) => a + s.score, 0);
  const maxScore   = (session.participants || []).length * ((session.participants || []).length - 1) * 2;
  const pct = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, color: C.accent, marginBottom: 4 }}>RESULT</div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 900 }}>{session.eventName}</h2>
      </div>

      <div style={{
        ...s.card, marginBottom: 20,
        background: `linear-gradient(135deg, ${C.accent}20 0%, ${C.teal}10 100%)`,
        border: `1px solid ${C.accent}40`,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div>
          <div style={{ fontSize: 11, color: C.muted, letterSpacing: 1, textTransform: "uppercase" }}>マッチング満足度</div>
          <div style={{ fontSize: 44, fontWeight: 900, color: C.accentLight, lineHeight: 1 }}>{pct}%</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 11, color: C.muted }}>グループ数</div>
          <div style={{ fontSize: 36, fontWeight: 900 }}>{groups.length}</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 14, marginBottom: 20 }}>
        {groups.map((g, i) => {
          const color = GROUP_COLORS[i % GROUP_COLORS.length];
          return (
            <div key={i} style={{ ...s.card, border: `1px solid ${color}50`, boxShadow: `0 0 24px ${color}10` }}>
              <div style={{ fontWeight: 800, fontSize: 15, color, marginBottom: 12 }}>
                {g.name}
                <span style={{ color: C.muted, fontWeight: 400, fontSize: 12, marginLeft: 6 }}>{g.members.length}人</span>
              </div>
              {g.members.map((id) => {
                const sat = getSat(id);
                return (
                  <div key={id} style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{getName(id)}</div>
                    {(sat?.matched || []).length > 0
                      ? <div style={{ fontSize: 11, color: C.teal, marginTop: 2 }}>✓ {sat.matched.map(getName).join(", ")}</div>
                      : <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>希望マッチなし</div>}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <button onClick={onReset} style={{ ...s.btn("danger"), width: "100%" }}>リセット（セッションを削除して最初から）</button>
    </div>
  );
}

// ─── Participant View ──────────────────────────────────────────────────────────
function ParticipantView({ sessionId }) {
  const savedIdentity = loadParticipantIdentity(sessionId);
  const [session,     setSession]     = useState(null);
  const [myName,      setMyName]      = useState(savedIdentity?.myName ?? "");
  const [myId,        setMyId]        = useState(savedIdentity?.myId ?? null);
  const [preferences, setPreferences] = useState([]);
  const [passwordInput, setPasswordInput] = useState("");
  const hasUnlock = () =>
    !!sessionStorage.getItem(unlockKey(sessionId)) || !!loadParticipantIdentity(sessionId)?.myId;
  const [unlocked, setUnlocked] = useState(() => hasUnlock());
  const [step, setStep] = useState(() => {
    if (!hasUnlock()) return "password";
    if (savedIdentity?.myId) return "restore";
    return "join";
  });
  const [loading,     setLoading]     = useState(false);
  const [err,         setErr]         = useState("");
  const pollRef = useRef(null);

  const applyParticipantFromSession = useCallback((s, participant) => {
    setMyId(participant.id);
    setMyName(participant.name);
    setPreferences(participant.preferences || []);
    setSession(s);
    sessionStorage.setItem(unlockKey(sessionId), "1");
    saveParticipantIdentity(sessionId, {
      myId: participant.id,
      myName: participant.name,
    });
    if (s.status === "matched") setStep("result");
    else if (participant.submitted) setStep("done");
    else setStep("vote");
  }, [sessionId]);

  const refresh = useCallback(async () => {
    if (!unlocked) return;
    const s = await loadSession(sessionId);
    if (s) {
      setSession(s);
      if (s.status === "matched") {
        setStep((prev) => (prev === "password" ? prev : "result"));
        return;
      }
      if (myId) {
        const me = (s.participants || []).find((p) => p.id === myId);
        if (!me) {
          clearParticipantIdentity(sessionId);
          setMyId(null);
          setMyName("");
          setPreferences([]);
          setStep("join");
          return;
        }
        setPreferences((prev) =>
          prev.filter((id) => (s.participants || []).some((p) => p.id === id)),
        );
      }
    } else {
      setSession(null);
      setStep("password");
      setUnlocked(false);
      setMyId(null);
      setMyName("");
      setPreferences([]);
      sessionStorage.removeItem(unlockKey(sessionId));
      clearParticipantIdentity(sessionId);
    }
  }, [sessionId, unlocked, myId]);

  useEffect(() => {
    if (!unlocked || step !== "restore") return;
    const saved = loadParticipantIdentity(sessionId);
    if (!saved?.myId) {
      setStep("join");
      return;
    }

    let cancelled = false;
    (async () => {
      const s = await loadSession(sessionId);
      if (cancelled) return;
      if (!s) {
        clearParticipantIdentity(sessionId);
        setStep("password");
        setUnlocked(false);
        sessionStorage.removeItem(unlockKey(sessionId));
        return;
      }
      const me = (s.participants || []).find((p) => p.id === saved.myId);
      if (!me) {
        clearParticipantIdentity(sessionId);
        setMyId(null);
        setMyName("");
        setStep("join");
        return;
      }
      applyParticipantFromSession(s, me);
    })();

    return () => { cancelled = true; };
  }, [unlocked, step, sessionId, applyParticipantFromSession]);

  useEffect(() => {
    if (!unlocked || step === "restore") return;
    refresh();
    pollRef.current = setInterval(refresh, 4000);
    return () => clearInterval(pollRef.current);
  }, [refresh, unlocked, step]);

  const verifyPassword = async () => {
    const pin = digitsOnly(passwordInput);
    if (!isValidJoinPassword(pin)) {
      setErr("4桁のパスワードを入力してください");
      return;
    }
    setLoading(true); setErr("");
    const s = await loadSession(sessionId);
    if (!s) {
      setErr("セッションが見つかりません");
      setLoading(false);
      return;
    }
    if (s.joinPassword && pin !== s.joinPassword) {
      setErr("パスワードが正しくありません");
      setLoading(false);
      return;
    }
    sessionStorage.setItem(unlockKey(sessionId), "1");
    setUnlocked(true);
    const saved = loadParticipantIdentity(sessionId);
    if (saved?.myId) {
      const me = (s.participants || []).find((p) => p.id === saved.myId);
      if (me) {
        applyParticipantFromSession(s, me);
        setLoading(false);
        return;
      }
      clearParticipantIdentity(sessionId);
    }
    setSession(s);
    setStep(s.status === "matched" ? "result" : "join");
    setLoading(false);
  };

  const joinSession = async () => {
    if (!myName.trim()) { setErr("名前を入力してください"); return; }
    setLoading(true); setErr("");
    const s = await loadSession(sessionId);
    if (!s) { setErr("セッションが見つかりません"); setLoading(false); return; }
    const existing = (s.participants || []).find((p) => p.name === myName.trim());
    if (existing) {
      applyParticipantFromSession(s, existing);
      setLoading(false);
      return;
    }
    const newId = `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newParticipant = { id: newId, name: myName.trim(), preferences: [], submitted: false };
    if (!s.participants) s.participants = [];
    s.participants.push(newParticipant);
    await saveSession(sessionId, s);
    applyParticipantFromSession(s, newParticipant);
    setLoading(false);
  };

  const submitPrefs = async () => {
    setLoading(true);
    const s = await loadSession(sessionId);
    if (!s.participants) s.participants = [];
    const idx = s.participants.findIndex((p) => p.id === myId);
    if (idx !== -1) {
      s.participants[idx].preferences = preferences;
      s.participants[idx].submitted   = true;
      await saveSession(sessionId, s);
      applyParticipantFromSession(s, s.participants[idx]);
    }
    setLoading(false);
  };

  // Auto-update others list when new participants join
  useEffect(() => {
    if (myId && session) {
      const updated = (session.participants || []).filter((p) => p.id !== myId);
      // If someone new joined, keep current prefs but show new options
      // Only warn if a preference target was removed
      setPreferences((prev) => 
        prev.filter(id => updated.some(p => p.id === id))
      );
    }
  }, [session?.participants?.length, myId, session]);

  const others   = (session?.participants || []).filter((p) => p.id !== myId);
  const togglePref = (id) => setPreferences((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const movePref   = (id, dir) => setPreferences((prev) => {
    const arr = [...prev]; const i = arr.indexOf(id); const j = i + dir;
    if (j < 0 || j >= arr.length) return arr;
    [arr[i], arr[j]] = [arr[j], arr[i]]; return arr;
  });

  if (step === "restore") return (
    <div style={{ textAlign: "center", padding: 60, color: C.muted }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
      <div>参加情報を復元しています...</div>
    </div>
  );

  if (step === "password") return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, color: C.accent, marginBottom: 8 }}>JOIN SESSION</div>
        <h2 style={{ margin: 0, fontSize: 24, fontWeight: 900 }}>参加パスワード</h2>
        <div style={{ color: C.muted, fontSize: 14, marginTop: 6 }}>幹事から共有された4桁の数字を入力してください</div>
      </div>
      <div style={{ ...s.card, marginBottom: 20 }}>
        <label style={s.label}>パスワード（4桁）</label>
        <input
          style={{ ...s.input, letterSpacing: 8, fontSize: 22, textAlign: "center", fontFamily: "monospace" }}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          value={passwordInput}
          onChange={(e) => { setPasswordInput(digitsOnly(e.target.value)); setErr(""); }}
          placeholder="••••"
          onKeyDown={(e) => e.key === "Enter" && verifyPassword()}
        />
        {err && <div style={{ color: C.red, fontSize: 13, marginTop: 8 }}>{err}</div>}
      </div>
      <button onClick={verifyPassword} disabled={loading} style={{ ...s.btn("teal"), width: "100%", padding: 16, fontSize: 15 }}>
        {loading ? "確認中..." : "次へ →"}
      </button>
    </div>
  );

  if (!session) return (
    <div style={{ textAlign: "center", padding: 60, color: C.muted }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
      <div>セッションを読み込み中...</div>
    </div>
  );

  // ── Result ──
  if (step === "result" && session.result) {
    const { groups } = session.result;
    const myGroup = groups.find((g) => g.members.includes(myId));
    const getName = (id) => (session.participants || []).find((p) => p.id === id)?.name || id;
    const color   = myGroup ? GROUP_COLORS[groups.indexOf(myGroup) % GROUP_COLORS.length] : C.accent;
    return (
      <div>
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, letterSpacing: 3, color: C.teal, marginBottom: 4 }}>RESULT</div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 900 }}>{session.eventName}</h2>
        </div>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>あなたのグループ</div>
          <div style={{ fontSize: 36, fontWeight: 900, color, padding: "16px 0", marginBottom: 4 }}>{myGroup?.name || "未配置"}</div>
          <Tag color={color}>{myGroup?.members.length}人グループ</Tag>
        </div>
        {myGroup && (
          <div style={{ ...s.card, marginBottom: 20, border: `1px solid ${color}50` }}>
            <label style={s.label}>グループメンバー</label>
            {myGroup.members.map((id) => (
              <div key={id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                <div style={{
                  width: 34, height: 34, borderRadius: "50%",
                  background: id === myId ? color : C.surface2,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontWeight: 700, fontSize: 13, color: id === myId ? "#000" : C.text,
                }}>{getName(id).charAt(0)}</div>
                <span style={{ fontWeight: id === myId ? 700 : 400 }}>
                  {getName(id)}{id === myId ? " (あなた)" : ""}
                </span>
              </div>
            ))}
          </div>
        )}
        <div style={s.card}>
          <label style={s.label}>全グループ</label>
          {groups.map((g, i) => {
            const c = GROUP_COLORS[i % GROUP_COLORS.length];
            return (
              <div key={i} style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700, color: c, fontSize: 13, marginBottom: 6 }}>{g.name}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {g.members.map((id) => <Tag key={id} color={id === myId ? c : C.muted}>{getName(id)}</Tag>)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Done ──
  if (step === "done" && session.status !== "matched") return (
    <div style={{ textAlign: "center", padding: "32px 0" }}>
      <div style={{ fontSize: 56, marginBottom: 16 }}>✅</div>
      <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 8 }}>希望を提出しました！</div>
      <div style={{ color: C.muted, fontSize: 14, marginBottom: 24 }}>幹事がマッチングを実行するまでお待ちください。</div>
      <div style={{ ...s.card, textAlign: "left" }}>
        <label style={s.label}>あなたの希望順位</label>
        {preferences.length === 0
          ? <div style={{ color: C.muted, fontSize: 13 }}>希望なし（ランダム配置）</div>
          : preferences.map((id, i) => {
              const p = (session.participants || []).find((x) => x.id === id);
              return (
                <div key={id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
                  <span style={{ color: C.accent, fontWeight: 700, width: 22, fontSize: 13 }}>{i + 1}.</span>
                  <span>{p?.name}</span>
                </div>
              );
            })}
      </div>
      <button
        onClick={() => setStep("vote")}
        style={{ ...s.btn("ghost"), width: "100%", marginTop: 20 }}
      >
        希望を編集する
      </button>
      <div style={{ marginTop: 16, color: C.muted, fontSize: 12 }}>このページを開いたままにしておくと結果が自動で表示されます</div>
    </div>
  );

  // ── Vote ──
  if (step === "vote") {
    const me = (session.participants || []).find((p) => p.id === myId);
    const isUpdate = !!me?.submitted;
    return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, color: C.accent, marginBottom: 4 }}>PARTICIPANT</div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 900 }}>{session.eventName}</h2>
        <div style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>こんにちは、{myName}さん</div>
      </div>
      <div style={{ ...s.card, marginBottom: 16 }}>
        <label style={s.label}>一緒になりたい人（希望順位）</label>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>追加した順に優先度が高くなります。上下で順番を変えられます。</div>

        {preferences.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            {preferences.map((id, i) => {
              const p = (session.participants || []).find((x) => x.id === id);
              if (!p) return null;
              return (
                <div key={id} style={{ display: "flex", alignItems: "center", gap: 8, background: C.surface2, borderRadius: 8, padding: "9px 12px", marginBottom: 6 }}>
                  <span style={{ color: C.accent, fontWeight: 700, width: 22, fontSize: 13, flexShrink: 0 }}>{i + 1}.</span>
                  <span style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>{p.name}</span>
                  <button onClick={() => movePref(id, -1)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 16, padding: "0 3px" }}>↑</button>
                  <button onClick={() => movePref(id,  1)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 16, padding: "0 3px" }}>↓</button>
                  <button onClick={() => togglePref(id)}   style={{ background: "none", border: "none", color: C.red,  cursor: "pointer", fontSize: 18, padding: "0 3px" }}>×</button>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {others.filter((o) => !preferences.includes(o.id)).map((o) => (
            <button key={o.id} onClick={() => togglePref(o.id)} style={{
              background: C.surface2, border: `1px solid ${C.border}`,
              borderRadius: 20, padding: "6px 14px", color: C.muted,
              cursor: "pointer", fontSize: 13, fontFamily: "inherit", transition: "all 0.15s",
            }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.color = C.accent; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border;  e.currentTarget.style.color = C.muted; }}
            >+ {o.name}</button>
          ))}
          {others.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>他の参加者の参加を待っています...</div>}
        </div>
      </div>
      <button onClick={submitPrefs} disabled={loading} style={{ ...s.btn("primary"), width: "100%", padding: 16, fontSize: 15 }}>
        {loading ? "送信中..." : isUpdate ? "希望を更新する →" : "希望を提出する →"}
      </button>
    </div>
    );
  }

  // ── Join ──
  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, color: C.accent, marginBottom: 8 }}>JOIN SESSION</div>
        <h2 style={{ margin: 0, fontSize: 24, fontWeight: 900 }}>{session.eventName}</h2>
        <div style={{ color: C.muted, fontSize: 14, marginTop: 6 }}>{(session.participants || []).length} 人が参加中</div>
      </div>
      <div style={{ ...s.card, marginBottom: 20 }}>
        <label style={s.label}>あなたの名前</label>
        <input style={s.input} value={myName} onChange={(e) => { setMyName(e.target.value); setErr(""); }}
          placeholder="名前を入力" onKeyDown={(e) => e.key === "Enter" && joinSession()} />
        {err && <div style={{ color: C.red, fontSize: 13, marginTop: 8 }}>{err}</div>}
      </div>
      <button onClick={joinSession} disabled={loading} style={{ ...s.btn("teal"), width: "100%", padding: 16, fontSize: 15 }}>
        {loading ? "参加中..." : "参加する →"}
      </button>
    </div>
  );
}

// ─── Main App ──────────────────────────────────────────────────────────────────
function generateSessionId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export default function App() {
  const params    = new URLSearchParams(window.location.search);
  const joinParam = params.get("join");
  const savedOrganizer = !joinParam ? loadOrganizerState() : null;

  const [mode,    setMode]    = useState(joinParam ? "participant" : "organizer");
  const [orgStep, setOrgStep] = useState(
    savedOrganizer?.sessionId ? savedOrganizer.orgStep : "setup",
  );
  const [sessionId, setSessionId] = useState(joinParam || savedOrganizer?.sessionId || null);
  const [session,   setSession]   = useState(null);
  const [orgRestoring, setOrgRestoring] = useState(
    !joinParam && !!savedOrganizer?.sessionId,
  );
  const pollRef = useRef(null);

  const refreshSession = useCallback(async () => {
    if (!sessionId) return;
    const s = await loadSession(sessionId);
    if (s) {
      setSession(s);
      if (s.status === "matched") {
        setOrgStep((prev) => {
          if (prev !== "result") saveOrganizerState({ sessionId, orgStep: "result" });
          return "result";
        });
      }
    }
  }, [sessionId]);

  useEffect(() => {
    if (joinParam || !orgRestoring || !sessionId) return;

    let cancelled = false;
    (async () => {
      const saved = loadOrganizerState();
      const s = await loadSession(sessionId);
      if (cancelled) return;
      if (!s) {
        clearOrganizerState();
        setSessionId(null);
        setOrgStep("setup");
        setOrgRestoring(false);
        return;
      }
      setSession(s);
      let step = saved?.orgStep || "dashboard";
      if (s.status === "matched") step = "result";
      else if (step === "result") step = "dashboard";
      setOrgStep(step);
      saveOrganizerState({ sessionId, orgStep: step });
      setOrgRestoring(false);
    })();

    return () => { cancelled = true; };
  }, [joinParam, orgRestoring, sessionId]);

  useEffect(() => {
    if (mode !== "organizer") return;
    if (!sessionId || orgStep === "setup") {
      if (!sessionId) clearOrganizerState();
      return;
    }
    saveOrganizerState({ sessionId, orgStep });
  }, [mode, sessionId, orgStep]);

  useEffect(() => {
    if (sessionId && mode === "organizer" && !orgRestoring) {
      refreshSession();
      pollRef.current = setInterval(refreshSession, 4000);
      return () => clearInterval(pollRef.current);
    }
  }, [sessionId, mode, refreshSession, orgRestoring]);

  const handleStart = async (eventName, groupConfig, joinPassword) => {
    const id = generateSessionId();
    const newSession = {
      id, eventName, groupConfig, joinPassword,
      participants: [], status: "waiting", result: null, createdAt: Date.now(),
    };
    await saveSession(id, newSession);
    saveOrganizerState({ sessionId: id, orgStep: "dashboard" });
    setSessionId(id);
    setSession(newSession);
    setOrgStep("dashboard");
    setOrgRestoring(false);
  };

  const handleSaveSettings = async (eventName, groupConfig) => {
    const s = await loadSession(sessionId);
    if (!s) return false;
    const slots = totalGroupSlots(groupConfig);
    const n = (s.participants || []).length;
    if (slots < n) return false;
    s.eventName = eventName;
    s.groupConfig = groupConfig;
    await saveSession(sessionId, s);
    setSession(s);
    return true;
  };

  const handleMatch = async () => {
    const s = await loadSession(sessionId);
    if (!s || (s.participants || []).length < 2) return;
    const { groups, satisfaction } = runMatching(s.participants, s.groupConfig);
    s.status = "matched";
    s.result = { groups, satisfaction };
    await saveSession(sessionId, s);
    saveOrganizerState({ sessionId, orgStep: "result" });
    setSession(s);
    setOrgStep("result");
  };

  const handleReset = async () => {
    if (sessionId) {
      await deleteSession(sessionId);
      sessionStorage.removeItem(unlockKey(sessionId));
      clearParticipantIdentity(sessionId);
    }
    clearOrganizerState();
    setSessionId(null);
    setSession(null);
    setOrgStep("setup");
    setOrgRestoring(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', sans-serif" }}>
      {/* Top bar */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: `linear-gradient(135deg, ${C.accent}, ${C.teal})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>🗺️</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 14, lineHeight: 1.1 }}>TripMatch</div>
            <div style={{ fontSize: 10, color: C.muted, letterSpacing: 1 }}>GROUP MATCHING SYSTEM</div>
          </div>
        </div>
        {!joinParam && (
          <div style={{ display: "flex", gap: 6 }}>
            {[["organizer", "幹事"], ["participant", "参加者"]].map(([m, label]) => (
              <button key={m} onClick={() => setMode(m)}
                style={{ ...s.btn("ghost"), padding: "6px 12px", fontSize: 12, background: mode === m ? C.surface2 : "none", color: mode === m ? C.text : C.muted, border: `1px solid ${mode === m ? C.border : "transparent"}` }}>
                {label}
              </button>
            ))}
          </div>
        )}
        {joinParam && <Tag color={C.teal}>参加者モード</Tag>}
      </div>

      {sessionId && mode === "organizer" && (
        <div style={{ background: C.surface2, borderBottom: `1px solid ${C.border}`, padding: "8px 20px", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: C.muted }}>セッションID</span>
          <span style={{ fontFamily: "monospace", fontWeight: 700, color: C.accentLight, fontSize: 13, letterSpacing: 2 }}>{sessionId}</span>
          {session && <StatusBadge status={session.status} />}
        </div>
      )}

      <div style={{ maxWidth: 680, margin: "0 auto", padding: "24px 16px" }}>
        {mode === "organizer" && orgRestoring && (
          <div style={{ textAlign: "center", padding: 60, color: C.muted }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
            <div>幹事セッションを復元しています...</div>
          </div>
        )}
        {mode === "organizer" && !orgRestoring && (
          <>
            {orgStep === "setup"     && <OrgSetup onStart={handleStart} />}
            {orgStep === "dashboard" && session && <OrgDashboard session={session} sessionId={sessionId} onRefresh={refreshSession} onMatch={handleMatch} onReset={handleReset} onSaveSettings={handleSaveSettings} />}
            {orgStep === "result"    && session?.result && <OrgResult session={session} onReset={handleReset} />}
          </>
        )}
        {mode === "participant" && sessionId  && <ParticipantView sessionId={sessionId} />}
        {mode === "participant" && !sessionId && (
          <div style={{ textAlign: "center", padding: "60px 0", color: C.muted }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🔗</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>参加URLが必要です</div>
            <div style={{ fontSize: 13 }}>幹事から共有されたURLにアクセスしてください</div>
          </div>
        )}
      </div>
    </div>
  );
}
