// 设备复检与班组交接闭环：数据模型、规则引擎与持久化
// 闭环链路：异常巡检 → 复检任务（责任班组/时段/复查人）→ 结果绑定原记录 → 留痕调整 / 跨班交接

export type RecheckStatus = "待复检" | "复检中" | "已完成";
export type RecheckResult = "通过" | "未通过";

/** 留痕调整保留的旧版 */
export interface RecheckVersion {
  id: string;
  changedAt: string;
  reason: string;
  prevResult: RecheckResult;
  prevNotes: string;
  prevReviewer: string;
}

/** 复检任务，必须通过 sourceRecordId 绑定原异常记录 */
export interface RecheckTask {
  id: string;
  sourceRecordId: string;
  device: string;
  area: string;
  slot: string;
  team: string;
  reviewer: string;
  status: RecheckStatus;
  result: RecheckResult | null;
  resultNotes: string;
  createdAt: string;
  completedAt: string | null;
  /** 跨班交接时记录释放前的原班组 */
  releasedFrom: string | null;
  versions: RecheckVersion[];
}

export interface HandoverRecord {
  id: string;
  fromTeam: string;
  toTeam: string;
  targetSlot: string;
  transferred: string[];
  blocked: string[];
  createdAt: string;
}

/** 规则冲突：必须能列出设备、时段、班组和触发规则 */
export interface Conflict {
  id: string;
  device: string;
  slot: string;
  team: string;
  rule: string;
  detail: string;
  createdAt: string;
}

export const TEAMS = ["甲班", "乙班", "丙班"];
export const SLOTS = ["早班 06:00-14:00", "中班 14:00-22:00", "夜班 22:00-06:00"];
/** 同一班组同一时段允许承接的进行中复检上限，超出即超载 */
export const TEAM_SLOT_CAPACITY = 3;

export const RULES = {
  R1: "规则1 设备时段唯一：同一设备同一时段只能有一个进行中的复检",
  R2: `规则2 班组容量：同一班组同一时段进行中复检不得超过 ${TEAM_SLOT_CAPACITY} 项，任务重叠不得超载`,
  R3: "规则3 待处理保护：复检完成前原异常保持待处理，不得流转状态或重复发起复检",
  R4: "规则4 绑定保护：复检结果必须绑定原记录，存在绑定复检的记录不得删除",
  R5: "规则5 留痕调整：复检通过后不得直接改写，调整必须填写原因并保留旧版",
  R6: "规则6 交接规则：跨班交接先释放原班组，未完成复检转入下一班",
} as const;

const RECHECK_KEY = "dfwlfront-10-rechecks";
const HANDOVER_KEY = "dfwlfront-10-handovers";

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

export function isActive(task: RecheckTask) {
  return task.status !== "已完成";
}

/** 班组在某时段的进行中复检负载 */
export function teamSlotLoad(tasks: RecheckTask[], team: string, slot: string) {
  return tasks.filter((t) => isActive(t) && t.team === team && t.slot === slot).length;
}

export function makeConflict(device: string, slot: string, team: string, rule: string, detail: string): Conflict {
  return { id: uuid(), device, slot, team, rule, detail, createdAt: now() };
}

/** 原异常的闭环状态：复检完成（通过）前一律保持待处理 */
export interface AnomalyInfo {
  state: "待处理" | "已闭环";
  activeTask: RecheckTask | null;
  closedTask: RecheckTask | null;
  boundCount: number;
}

export function anomalyInfo(recordId: string, recordStatus: string, tasks: RecheckTask[]): AnomalyInfo | null {
  if (recordStatus !== "异常") return null;
  const bound = tasks.filter((t) => t.sourceRecordId === recordId);
  const closedTask = bound.find((t) => t.status === "已完成" && t.result === "通过") ?? null;
  const activeTask = bound.find(isActive) ?? null;
  return {
    state: closedTask ? "已闭环" : "待处理",
    activeTask,
    closedTask,
    boundCount: bound.length,
  };
}

export interface RecheckInput {
  sourceRecordId: string;
  device: string;
  area: string;
  slot: string;
  team: string;
  reviewer: string;
}

/** 生成复检前的规则预检，返回全部冲突（设备/时段/班组/触发规则） */
export function planRecheck(tasks: RecheckTask[], input: RecheckInput): Conflict[] {
  const conflicts: Conflict[] = [];
  if (tasks.some((t) => t.sourceRecordId === input.sourceRecordId && isActive(t))) {
    conflicts.push(makeConflict(input.device, input.slot, input.team, RULES.R3, "该异常已存在进行中的复检，完成前不得重复发起"));
  }
  const dup = tasks.find((t) => isActive(t) && t.device === input.device && t.slot === input.slot);
  if (dup) {
    conflicts.push(
      makeConflict(input.device, input.slot, input.team, RULES.R1, `该设备在此时段已有进行中复检（责任班组：${dup.team}，复查人：${dup.reviewer}）`)
    );
  }
  const load = teamSlotLoad(tasks, input.team, input.slot);
  if (load >= TEAM_SLOT_CAPACITY) {
    conflicts.push(
      makeConflict(input.device, input.slot, input.team, RULES.R2, `${input.team} 在「${input.slot}」已有 ${load} 项进行中复检，超出容量上限`)
    );
  }
  return conflicts;
}

export function createRecheck(tasks: RecheckTask[], input: RecheckInput): { tasks: RecheckTask[]; conflicts: Conflict[] } {
  const conflicts = planRecheck(tasks, input);
  if (conflicts.length > 0) return { tasks, conflicts };
  const task: RecheckTask = {
    id: uuid(),
    ...input,
    status: "待复检",
    result: null,
    resultNotes: "",
    createdAt: now(),
    completedAt: null,
    releasedFrom: null,
    versions: [],
  };
  return { tasks: [task, ...tasks], conflicts: [] };
}

export function startRecheck(tasks: RecheckTask[], id: string): RecheckTask[] {
  return tasks.map((t) => (t.id === id && t.status === "待复检" ? { ...t, status: "复检中" } : t));
}

/** 提交复检结果：结果随任务绑定原记录，通过与否由派生状态反映到原异常 */
export function completeRecheck(tasks: RecheckTask[], id: string, result: RecheckResult, notes: string): RecheckTask[] {
  return tasks.map((t) =>
    t.id === id && t.status === "复检中"
      ? { ...t, status: "已完成", result, resultNotes: notes, completedAt: now() }
      : t
  );
}

/** 留痕调整：只允许已完成的复检，旧版进 versions，必须填写原因 */
export function adjustRecheck(
  tasks: RecheckTask[],
  id: string,
  next: { result: RecheckResult; notes: string; reason: string }
): RecheckTask[] {
  return tasks.map((t) => {
    if (t.id !== id || t.status !== "已完成" || !t.result) return t;
    const version: RecheckVersion = {
      id: uuid(),
      changedAt: now(),
      reason: next.reason,
      prevResult: t.result,
      prevNotes: t.resultNotes,
      prevReviewer: t.reviewer,
    };
    return { ...t, result: next.result, resultNotes: next.notes, versions: [version, ...t.versions] };
  });
}

/**
 * 跨班交接：先释放原班组的全部未完成复检，再逐项转入接班班组。
 * 转入时仍受设备时段唯一与班组容量约束，冲突任务保留在原班组并逐条列出。
 */
export function handover(
  tasks: RecheckTask[],
  fromTeam: string,
  toTeam: string,
  targetSlot: string
): { tasks: RecheckTask[]; record: HandoverRecord | null; conflicts: Conflict[] } {
  if (fromTeam === toTeam) {
    return {
      tasks,
      record: null,
      conflicts: [makeConflict("-", targetSlot, fromTeam, RULES.R6, "交班班组与接班班组不能相同")],
    };
  }
  const moving = tasks.filter((t) => isActive(t) && t.team === fromTeam);
  let next = tasks;
  const transferred: string[] = [];
  const blocked: string[] = [];
  const conflicts: Conflict[] = [];

  for (const task of moving) {
    // 先释放原班组
    const released: RecheckTask = { ...task, releasedFrom: task.team };
    const dup = next.find((t) => t.id !== task.id && isActive(t) && t.device === task.device && t.slot === targetSlot);
    if (dup) {
      conflicts.push(
        makeConflict(task.device, targetSlot, toTeam, RULES.R1, `转入时段已存在该设备的进行中复检（责任班组：${dup.team}），本任务保留在 ${fromTeam}`)
      );
      blocked.push(task.id);
      continue;
    }
    const load = teamSlotLoad(next, toTeam, targetSlot);
    if (load >= TEAM_SLOT_CAPACITY) {
      conflicts.push(
        makeConflict(task.device, targetSlot, toTeam, RULES.R2, `${toTeam} 在「${targetSlot}」容量已满（${load}/${TEAM_SLOT_CAPACITY}），本任务保留在 ${fromTeam}`)
      );
      blocked.push(task.id);
      continue;
    }
    // 再转入下一班
    next = next.map((t) => (t.id === task.id ? { ...released, team: toTeam, slot: targetSlot } : t));
    transferred.push(task.id);
  }

  const record: HandoverRecord = { id: uuid(), fromTeam, toTeam, targetSlot, transferred, blocked, createdAt: now() };
  return { tasks: next, record, conflicts };
}

interface SourceRecordLike {
  id: string;
  [key: string]: string | number;
}

function seedRechecks(records: SourceRecordLike[]): RecheckTask[] {
  const anomaly = records.find((r) => r.id === "seed-2");
  if (!anomaly) return [];
  return [
    {
      id: uuid(),
      sourceRecordId: anomaly.id,
      device: String(anomaly.item),
      area: String(anomaly.area),
      slot: SLOTS[0],
      team: TEAMS[0],
      reviewer: "王强",
      status: "待复检",
      result: null,
      resultNotes: "",
      createdAt: now(),
      completedAt: null,
      releasedFrom: null,
      versions: [],
    },
  ];
}

/** 刷新后载入：校验绑定关系，丢失原记录的任务移除、设备信息与原记录重新对齐 */
export function loadRechecks(records: SourceRecordLike[]): { tasks: RecheckTask[]; repairs: string[] } {
  const repairs: string[] = [];
  const raw = localStorage.getItem(RECHECK_KEY);
  if (!raw) return { tasks: seedRechecks(records), repairs };

  let parsed: RecheckTask[];
  try {
    parsed = JSON.parse(raw) as RecheckTask[];
  } catch {
    repairs.push("复检数据解析失败，已重置为空清单");
    return { tasks: [], repairs };
  }

  const byId = new Map(records.map((r) => [r.id, r]));
  const tasks: RecheckTask[] = [];
  for (const task of parsed) {
    const source = byId.get(task.sourceRecordId);
    if (!source) {
      repairs.push(`复检任务「${task.device} / ${task.slot}」丢失原记录绑定，已移除（${RULES.R4}）`);
      continue;
    }
    const normalized: RecheckTask = {
      ...task,
      device: String(source.item),
      area: String(source.area),
      result: task.result ?? null,
      resultNotes: task.resultNotes ?? "",
      completedAt: task.completedAt ?? null,
      releasedFrom: task.releasedFrom ?? null,
      versions: Array.isArray(task.versions) ? task.versions : [],
    };
    if (normalized.device !== task.device || normalized.area !== task.area) {
      repairs.push(`复检任务「${task.device} / ${task.slot}」的设备信息已与原记录重新对齐`);
    }
    tasks.push(normalized);
  }
  return { tasks, repairs };
}

export function saveRechecks(tasks: RecheckTask[]) {
  localStorage.setItem(RECHECK_KEY, JSON.stringify(tasks));
}

export function loadHandovers(): HandoverRecord[] {
  const raw = localStorage.getItem(HANDOVER_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as HandoverRecord[];
  } catch {
    return [];
  }
}

export function saveHandovers(records: HandoverRecord[]) {
  localStorage.setItem(HANDOVER_KEY, JSON.stringify(records));
}

/** 刷新后的一致性扫描：对存量数据重放设备时段唯一与班组容量规则 */
export function scanConflicts(tasks: RecheckTask[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const active = tasks.filter(isActive);

  const byDeviceSlot = new Map<string, RecheckTask[]>();
  for (const t of active) {
    const key = `${t.device}@@${t.slot}`;
    byDeviceSlot.set(key, [...(byDeviceSlot.get(key) ?? []), t]);
  }
  for (const group of byDeviceSlot.values()) {
    if (group.length > 1) {
      const first = group[0];
      conflicts.push(
        makeConflict(
          first.device,
          first.slot,
          group.map((g) => g.team).join(" / "),
          RULES.R1,
          `一致性检查发现 ${group.length} 个进行中复检占用同一设备时段`
        )
      );
    }
  }

  const byTeamSlot = new Map<string, RecheckTask[]>();
  for (const t of active) {
    const key = `${t.team}@@${t.slot}`;
    byTeamSlot.set(key, [...(byTeamSlot.get(key) ?? []), t]);
  }
  for (const group of byTeamSlot.values()) {
    if (group.length > TEAM_SLOT_CAPACITY) {
      const first = group[0];
      conflicts.push(
        makeConflict(
          group.map((g) => g.device).join(" / "),
          first.slot,
          first.team,
          RULES.R2,
          `一致性检查发现该班组此时段负载 ${group.length} 项，超出容量上限 ${TEAM_SLOT_CAPACITY}`
        )
      );
    }
  }
  return conflicts;
}
