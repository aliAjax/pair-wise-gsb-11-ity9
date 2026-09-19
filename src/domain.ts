/**
 * 油站巡检闭环领域逻辑（纯函数，不依赖 UI）：
 * 1. 异常巡检生成复检任务，绑定责任班组、时段、复查人；
 * 2. 同一设备同一时段仅允许一个进行中复检；班组同时段任务不得超载；
 * 3. 复检完成前原异常保持待处理，复检结果写回绑定的原记录；
 * 4. 已闭环记录禁止直接改写，调整必须留原因与旧版；
 * 5. 跨班交接先释放原班组，未完成复检转入下一班；
 * 6. 加载/刷新时做一致性校验，冲突列出设备、时段、班组与触发规则。
 *
 * 每个操作返回 Outcome：成功时携带下一份状态，失败时携带冲突列表。
 */

export type Disposition = "无" | "待处理" | "已闭环";
export type RecheckStatus = "待复检" | "复检中" | "通过" | "未通过" | "已取消";

export interface RecordVersion {
  id: string;
  at: string;
  reason: string;
  snapshot: {
    status: string;
    notes: string;
    inspector: string;
    checkedAt: string;
  };
}

export interface InspectionRecord {
  id: string;
  item: string;
  area: string;
  inspector: string;
  checkedAt: string;
  status: string; // 未检 | 正常 | 异常
  notes: string;
  createdAt: string;
  disposition: Disposition;
  versions: RecordVersion[];
}

export interface Handover {
  id: string;
  fromTeam: string;
  toTeam: string;
  at: string;
  note: string;
}

export interface RecheckTask {
  id: string;
  sourceId: string; // 绑定原巡检记录
  item: string;
  area: string;
  team: string;
  slot: string;
  reviewer: string;
  status: RecheckStatus;
  result: string;
  createdAt: string;
  completedAt: string | null;
  handovers: Handover[];
}

export interface Conflict {
  id: string;
  rule: string; // 触发规则
  item: string; // 设备
  slot: string; // 时段
  team: string; // 班组
  detail: string;
  at: string;
}

export const TEAMS = ["甲班", "乙班", "丙班"] as const;
export const SLOTS = ["早班", "中班", "晚班"] as const;
export const STATUS_FLOW = ["未检", "正常", "异常"] as const;
/** 班组在同一时段允许承载的进行中复检上限 */
export const TEAM_SLOT_CAPACITY = 3;

export const RULES = {
  UNIQUE_DEVICE_SLOT: "同一设备同一时段仅允许一个复检",
  TEAM_OVERLOAD: "班组同时段任务超载",
  ANOMALY_FLOW: "异常须复检闭环，禁止直接流转",
  LOCKED: "复检进行中，原记录已锁定",
  CLOSED_IMMUTABLE: "已闭环禁止直接改写，须调整留痕",
  BOUND: "存在绑定复检，禁止删除原记录",
  ORPHAN: "复检任务丢失原记录绑定",
  MISMATCH: "原记录状态与复检结果不一致",
  INCOMPLETE: "复检任务信息不完整",
  RESULT_REQUIRED: "复检结果必填，须绑定原记录",
  INVALID_HANDOVER: "交接目标班组无效",
} as const;

export type Outcome =
  | { ok: true; records: InspectionRecord[]; tasks: RecheckTask[]; message: string }
  | { ok: false; conflicts: Conflict[] };

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function makeConflict(rule: string, item: string, slot: string, team: string, detail: string): Conflict {
  return { id: uid(), rule, item, slot, team, detail, at: now() };
}

const fail = (conflicts: Conflict[]): Outcome => ({ ok: false, conflicts });
const ok = (records: InspectionRecord[], tasks: RecheckTask[], message: string): Outcome => ({
  ok: true,
  records,
  tasks,
  message,
});

export const isOpen = (task: RecheckTask) => task.status === "待复检" || task.status === "复检中";

export function openTaskOf(tasks: RecheckTask[], sourceId: string) {
  return tasks.find((t) => t.sourceId === sourceId && isOpen(t));
}

export function teamSlotLoad(tasks: RecheckTask[], team: string, slot: string) {
  return tasks.filter((t) => isOpen(t) && t.team === team && t.slot === slot).length;
}

export function nextTeam(team: string): string {
  const index = TEAMS.indexOf(team as (typeof TEAMS)[number]);
  return TEAMS[(index + 1) % TEAMS.length] ?? TEAMS[0];
}

/** 异常巡检 → 复检任务：校验唯一性与班组容量，原记录保持待处理 */
export function createRecheck(
  records: InspectionRecord[],
  tasks: RecheckTask[],
  input: { sourceId: string; team: string; slot: string; reviewer: string }
): Outcome {
  const record = records.find((r) => r.id === input.sourceId);
  if (!record) {
    return fail([makeConflict(RULES.ORPHAN, "未知设备", input.slot, input.team, "原巡检记录不存在，无法生成复检")]);
  }
  if (record.status !== "异常") {
    return fail([makeConflict(RULES.ANOMALY_FLOW, record.item, input.slot, input.team, "仅异常记录可生成复检任务")]);
  }
  if (!input.reviewer.trim()) {
    return fail([makeConflict(RULES.INCOMPLETE, record.item, input.slot, input.team, "复查人必填")]);
  }
  if (openTaskOf(tasks, record.id)) {
    return fail([makeConflict(RULES.LOCKED, record.item, input.slot, input.team, "该异常已有进行中的复检任务")]);
  }
  const duplicate = tasks.find((t) => isOpen(t) && t.item === record.item && t.slot === input.slot);
  if (duplicate) {
    return fail([
      makeConflict(RULES.UNIQUE_DEVICE_SLOT, record.item, input.slot, input.team, `该时段已存在 ${duplicate.team} 的复检任务`),
    ]);
  }
  if (teamSlotLoad(tasks, input.team, input.slot) >= TEAM_SLOT_CAPACITY) {
    return fail([
      makeConflict(RULES.TEAM_OVERLOAD, record.item, input.slot, input.team, `${input.team}在${input.slot}已达 ${TEAM_SLOT_CAPACITY} 项上限`),
    ]);
  }
  const task: RecheckTask = {
    id: uid(),
    sourceId: record.id,
    item: record.item,
    area: record.area,
    team: input.team,
    slot: input.slot,
    reviewer: input.reviewer.trim(),
    status: "待复检",
    result: "",
    createdAt: now(),
    completedAt: null,
    handovers: [],
  };
  // 复检完成前原异常保持待处理，原记录不做任何改写
  return ok(records, [task, ...tasks], `已生成复检：${record.item} / ${input.slot} / ${input.team} / 复查人 ${task.reviewer}`);
}

export function startRecheck(records: InspectionRecord[], tasks: RecheckTask[], taskId: string): Outcome {
  const task = tasks.find((t) => t.id === taskId);
  if (!task || !isOpen(task)) {
    return fail([makeConflict(RULES.LOCKED, task?.item ?? "未知设备", task?.slot ?? "-", task?.team ?? "-", "任务不存在或已办结")]);
  }
  const nextTasks = tasks.map((t) => (t.id === taskId ? { ...t, status: "复检中" as RecheckStatus } : t));
  return ok(records, nextTasks, `${task.item} 开始复检`);
}

/** 复检办结：结果写回绑定的原记录；通过则闭环，未通过保持待处理 */
export function completeRecheck(
  records: InspectionRecord[],
  tasks: RecheckTask[],
  taskId: string,
  pass: boolean,
  result: string
): Outcome {
  const task = tasks.find((t) => t.id === taskId);
  if (!task || !isOpen(task)) {
    return fail([makeConflict(RULES.LOCKED, task?.item ?? "未知设备", task?.slot ?? "-", task?.team ?? "-", "任务不存在或已办结")]);
  }
  if (!result.trim()) {
    return fail([makeConflict(RULES.RESULT_REQUIRED, task.item, task.slot, task.team, "请填写复检结论后再办结")]);
  }
  const nextTasks = tasks.map((t) =>
    t.id === taskId
      ? { ...t, status: (pass ? "通过" : "未通过") as RecheckStatus, result: result.trim(), completedAt: now() }
      : t
  );
  const nextRecords = records.map((r) =>
    r.id === task.sourceId && pass ? { ...r, disposition: "已闭环" as Disposition } : r
  );
  return ok(
    nextRecords,
    nextTasks,
    pass ? `复检通过，${task.item} 已闭环（结果已绑定原记录）` : `复检未通过，${task.item} 保持待处理`
  );
}

/** 已闭环记录的调整：必须留原因，旧版快照入库 */
export function adjustRecord(
  records: InspectionRecord[],
  tasks: RecheckTask[],
  recordId: string,
  patch: { status?: string; notes?: string },
  reason: string
): Outcome {
  const record = records.find((r) => r.id === recordId);
  if (!record) {
    return fail([makeConflict(RULES.ORPHAN, "未知设备", "-", "-", "原巡检记录不存在")]);
  }
  if (record.disposition !== "已闭环") {
    return fail([makeConflict(RULES.CLOSED_IMMUTABLE, record.item, "-", "-", "仅已闭环记录走调整留痕，其余记录按流程办理")]);
  }
  if (!reason.trim()) {
    return fail([makeConflict(RULES.CLOSED_IMMUTABLE, record.item, "-", "-", "调整必须填写原因")]);
  }
  const version: RecordVersion = {
    id: uid(),
    at: now(),
    reason: reason.trim(),
    snapshot: {
      status: record.status,
      notes: record.notes,
      inspector: record.inspector,
      checkedAt: record.checkedAt,
    },
  };
  const nextRecords = records.map((r) =>
    r.id === recordId
      ? {
          ...r,
          status: patch.status ?? r.status,
          notes: patch.notes ?? r.notes,
          versions: [version, ...r.versions],
        }
      : r
  );
  return ok(nextRecords, tasks, `已留痕调整：${record.item}（旧版已存档）`);
}

/** 状态流转：异常与已闭环记录禁止直接流转，须走复检/调整流程 */
export function cycleStatus(records: InspectionRecord[], tasks: RecheckTask[], recordId: string): Outcome {
  const record = records.find((r) => r.id === recordId);
  if (!record) {
    return fail([makeConflict(RULES.ORPHAN, "未知设备", "-", "-", "原巡检记录不存在")]);
  }
  const open = openTaskOf(tasks, recordId);
  if (open) {
    return fail([makeConflict(RULES.LOCKED, record.item, open.slot, open.team, "复检完成前原异常保持待处理，禁止流转")]);
  }
  if (record.disposition === "已闭环") {
    return fail([makeConflict(RULES.CLOSED_IMMUTABLE, record.item, "-", "-", "已闭环记录请使用调整留痕")]);
  }
  if (record.status === "异常") {
    return fail([makeConflict(RULES.ANOMALY_FLOW, record.item, "-", "-", "请生成复检任务，闭环前不得直接改状态")]);
  }
  const index = STATUS_FLOW.indexOf(record.status as (typeof STATUS_FLOW)[number]);
  const status = STATUS_FLOW[(index + 1) % STATUS_FLOW.length] ?? STATUS_FLOW[0];
  const disposition: Disposition = status === "异常" ? "待处理" : "无";
  const nextRecords = records.map((r) => (r.id === recordId ? { ...r, status, disposition } : r));
  return ok(nextRecords, tasks, `${record.item} 流转为 ${status}`);
}

export function removeRecord(records: InspectionRecord[], tasks: RecheckTask[], recordId: string): Outcome {
  const record = records.find((r) => r.id === recordId);
  if (!record) {
    return fail([makeConflict(RULES.ORPHAN, "未知设备", "-", "-", "原巡检记录不存在")]);
  }
  const open = openTaskOf(tasks, recordId);
  if (open) {
    return fail([makeConflict(RULES.LOCKED, record.item, open.slot, open.team, "复检进行中，禁止删除原记录")]);
  }
  if (record.disposition === "已闭环") {
    return fail([makeConflict(RULES.CLOSED_IMMUTABLE, record.item, "-", "-", "已闭环记录须保留闭环证据，禁止删除")]);
  }
  if (tasks.some((t) => t.sourceId === recordId)) {
    return fail([makeConflict(RULES.BOUND, record.item, "-", "-", "已办结复检绑定原记录，删除将丢失闭环证据")]);
  }
  return ok(
    records.filter((r) => r.id !== recordId),
    tasks,
    `已删除：${record.item}`
  );
}

/** 单任务交接：先释放原班组，再转入目标班组（校验唯一性与容量） */
export function transferTask(
  records: InspectionRecord[],
  tasks: RecheckTask[],
  taskId: string,
  toTeam: string,
  note: string
): Outcome {
  const task = tasks.find((t) => t.id === taskId);
  if (!task || !isOpen(task)) {
    return fail([makeConflict(RULES.LOCKED, task?.item ?? "未知设备", task?.slot ?? "-", task?.team ?? "-", "任务不存在或已办结")]);
  }
  if (toTeam === task.team || !TEAMS.includes(toTeam as (typeof TEAMS)[number])) {
    return fail([makeConflict(RULES.INVALID_HANDOVER, task.item, task.slot, toTeam, "目标班组与当前班组相同或不存在")]);
  }
  const duplicate = tasks.find((t) => t.id !== taskId && isOpen(t) && t.item === task.item && t.slot === task.slot);
  if (duplicate) {
    return fail([makeConflict(RULES.UNIQUE_DEVICE_SLOT, task.item, task.slot, toTeam, `该时段已存在 ${duplicate.team} 的复检任务`)]);
  }
  if (teamSlotLoad(tasks, toTeam, task.slot) >= TEAM_SLOT_CAPACITY) {
    return fail([
      makeConflict(RULES.TEAM_OVERLOAD, task.item, task.slot, toTeam, `${toTeam}在${task.slot}已达 ${TEAM_SLOT_CAPACITY} 项上限，无法承接`),
    ]);
  }
  const handover: Handover = { id: uid(), fromTeam: task.team, toTeam, at: now(), note: note || "跨班交接" };
  const nextTasks = tasks.map((t) =>
    t.id === taskId ? { ...t, team: toTeam, handovers: [...t.handovers, handover] } : t
  );
  return ok(records, nextTasks, `已释放${task.team}，${task.item}（${task.slot}）转入${toTeam}`);
}

/** 整班交接：释放原班组全部未完成复检，整体转入下一班；任一超载则整批拒绝 */
export function handoverTeam(
  records: InspectionRecord[],
  tasks: RecheckTask[],
  fromTeam: string,
  toTeam: string
): Outcome {
  if (fromTeam === toTeam || !TEAMS.includes(toTeam as (typeof TEAMS)[number])) {
    return fail([makeConflict(RULES.INVALID_HANDOVER, "-", "-", toTeam, "交班班组与接班班组不能相同")]);
  }
  const moving = tasks.filter((t) => isOpen(t) && t.team === fromTeam);
  if (moving.length === 0) {
    return ok(records, tasks, `${fromTeam}无未完成复检，无需交接`);
  }
  const conflicts: Conflict[] = [];
  for (const slot of SLOTS) {
    const incoming = moving.filter((t) => t.slot === slot);
    if (incoming.length === 0) continue;
    const load = teamSlotLoad(tasks, toTeam, slot);
    if (load + incoming.length > TEAM_SLOT_CAPACITY) {
      for (const task of incoming) {
        conflicts.push(
          makeConflict(
            RULES.TEAM_OVERLOAD,
            task.item,
            slot,
            toTeam,
            `整班交接将使${toTeam}在${slot}达到 ${load + incoming.length} 项，超过 ${TEAM_SLOT_CAPACITY} 项上限`
          )
        );
      }
    }
  }
  if (conflicts.length > 0) {
    return fail(conflicts);
  }
  const at = now();
  const nextTasks = tasks.map((t) =>
    isOpen(t) && t.team === fromTeam
      ? {
          ...t,
          team: toTeam,
          handovers: [
            ...t.handovers,
            { id: uid(), fromTeam, toTeam, at, note: "整班交接：先释放原班组，未完成复检转入下一班" },
          ],
        }
      : t
  );
  return ok(records, nextTasks, `已释放${fromTeam} ${moving.length} 项未完成复检，转入${toTeam}`);
}

/**
 * 一致性校验（加载/刷新后执行）：修复可自动修复的关系，其余以冲突形式报告。
 * 保证刷新后：任务必有原记录、同设备同时段唯一、处置状态与复检结果对齐。
 */
export function validateConsistency(
  records: InspectionRecord[],
  tasks: RecheckTask[]
): { records: InspectionRecord[]; tasks: RecheckTask[]; conflicts: Conflict[] } {
  const conflicts: Conflict[] = [];

  // 1. 孤儿任务：原记录缺失 → 取消任务
  let nextTasks = tasks.map((t) => {
    if (t.status !== "已取消" && !records.some((r) => r.id === t.sourceId)) {
      conflicts.push(makeConflict(RULES.ORPHAN, t.item, t.slot, t.team, "原巡检记录缺失，任务已取消"));
      return { ...t, status: "已取消" as RecheckStatus, completedAt: t.completedAt ?? now(), result: t.result || "一致性修复：原记录缺失" };
    }
    return t;
  });

  // 2. 同设备同时段重复复检 → 保留最早，取消其余
  const groups = new Map<string, RecheckTask[]>();
  for (const t of nextTasks.filter(isOpen)) {
    const key = `${t.item}@@${t.slot}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const cancelled = new Set<string>();
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const sorted = [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const extra of sorted.slice(1)) {
      cancelled.add(extra.id);
      conflicts.push(makeConflict(RULES.UNIQUE_DEVICE_SLOT, extra.item, extra.slot, extra.team, "重复复检已取消，保留最早任务"));
    }
  }
  if (cancelled.size > 0) {
    nextTasks = nextTasks.map((t) =>
      cancelled.has(t.id) ? { ...t, status: "已取消" as RecheckStatus, completedAt: now(), result: "一致性修复：重复复检" } : t
    );
  }

  // 3. 原记录处置状态与复检结果对齐
  const nextRecords = records.map((r) => {
    const bound = nextTasks.filter((t) => t.sourceId === r.id);
    const passed = bound.some((t) => t.status === "通过");
    if (r.disposition === "已闭环" && !passed) {
      conflicts.push(makeConflict(RULES.MISMATCH, r.item, "-", "-", "已闭环但无通过的复检，回退为待处理"));
      return { ...r, disposition: (r.status === "异常" ? "待处理" : "无") as Disposition };
    }
    if (r.status === "异常" && r.disposition === "无") {
      conflicts.push(makeConflict(RULES.MISMATCH, r.item, "-", "-", "异常记录缺少待处理标记，已补齐"));
      return { ...r, disposition: "待处理" as Disposition };
    }
    if (r.status !== "异常" && r.disposition === "待处理") {
      conflicts.push(makeConflict(RULES.MISMATCH, r.item, "-", "-", "非异常记录存在待处理标记，已清除"));
      return { ...r, disposition: "无" as Disposition };
    }
    return r;
  });

  // 4. 班组同时段超载：只报告不自动调整，需人工交接分流
  for (const team of TEAMS) {
    for (const slot of SLOTS) {
      const overloaded = nextTasks.filter((t) => isOpen(t) && t.team === team && t.slot === slot);
      if (overloaded.length > TEAM_SLOT_CAPACITY) {
        conflicts.push(
          makeConflict(
            RULES.TEAM_OVERLOAD,
            overloaded.map((t) => t.item).join("、"),
            slot,
            team,
            `${team}在${slot}有 ${overloaded.length} 项复检，超过 ${TEAM_SLOT_CAPACITY} 项上限，请交接分流`
          )
        );
      }
    }
  }

  return { records: nextRecords, tasks: nextTasks, conflicts };
}

/** 种子数据：首启演示用，含一个待复检任务与两个待处理异常 */
export function seedState(): { records: InspectionRecord[]; tasks: RecheckTask[] } {
  const base = Date.now();
  const records: InspectionRecord[] = [
    {
      id: "seed-1",
      item: "加油机1号",
      area: "加油区",
      inspector: "何鑫",
      checkedAt: "2026-09-18",
      status: "正常",
      notes: "运行平稳，无渗漏",
      createdAt: new Date(base - 86400000).toISOString(),
      disposition: "无",
      versions: [],
    },
    {
      id: "seed-2",
      item: "卸油口密封",
      area: "油罐区",
      inspector: "何鑫",
      checkedAt: "2026-09-18",
      status: "异常",
      notes: "密封圈老化，存在渗油风险",
      createdAt: new Date(base - 80000000).toISOString(),
      disposition: "待处理",
      versions: [],
    },
    {
      id: "seed-3",
      item: "油罐呼吸阀",
      area: "油罐区",
      inspector: "王芳",
      checkedAt: "2026-09-19",
      status: "异常",
      notes: "阀盘卡涩，启闭不灵活",
      createdAt: new Date(base - 3600000).toISOString(),
      disposition: "待处理",
      versions: [],
    },
    {
      id: "seed-4",
      item: "收银台防爆终端",
      area: "收银区",
      inspector: "王芳",
      checkedAt: "2026-09-19",
      status: "未检",
      notes: "待班中巡检",
      createdAt: new Date(base - 1800000).toISOString(),
      disposition: "无",
      versions: [],
    },
  ];
  const tasks: RecheckTask[] = [
    {
      id: "seed-task-1",
      sourceId: "seed-2",
      item: "卸油口密封",
      area: "油罐区",
      team: "甲班",
      slot: "早班",
      reviewer: "王工",
      status: "待复检",
      result: "",
      createdAt: new Date(base - 7200000).toISOString(),
      completedAt: null,
      handovers: [],
    },
  ];
  return { records, tasks };
}
