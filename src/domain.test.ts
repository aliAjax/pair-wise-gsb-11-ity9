import {
  TEAM_SLOT_CAPACITY,
  adjustRecord,
  completeRecheck,
  createRecheck,
  cycleStatus,
  handoverTeam,
  removeRecord,
  seedState,
  startRecheck,
  transferTask,
  validateConsistency,
} from "./domain.js";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}`, extra ?? "");
  }
}

// 基础状态：seed-2 异常已有甲班/早班复检，seed-3 异常待处理
const seed = seedState();
let { records, tasks } = seed;

// 1. 异常生成复检（绑定班组/时段/复查人）
let r = createRecheck(records, tasks, { sourceId: "seed-3", team: "乙班", slot: "中班", reviewer: "李工" });
check("异常可生成复检", r.ok);
if (r.ok) ({ records, tasks } = r);

// 2. 同一设备同一时段唯一（两条不同记录、同一设备名、同一时段）
const dupA = { ...records.find((x) => x.id === "seed-3")!, id: "dup-a", item: "同名机泵", status: "异常", disposition: "待处理" as const };
const dupB = { ...dupA, id: "dup-b" };
records = [dupB, dupA, ...records];
let dr = createRecheck(records, tasks, { sourceId: "dup-a", team: "甲班", slot: "中班", reviewer: "张三" });
check("同名设备首条可生成", dr.ok);
if (dr.ok) ({ records, tasks } = dr);
dr = createRecheck(records, tasks, { sourceId: "dup-b", team: "乙班", slot: "中班", reviewer: "李四" });
check("同设备同时段重复被拒", !dr.ok && dr.conflicts[0].rule.includes("同一设备同一时段"), dr);
// 同一异常记录已有进行中复检时，先触发锁定规则
dr = createRecheck(records, tasks, { sourceId: "dup-a", team: "丙班", slot: "晚班", reviewer: "王五" });
check("已有复检再生成被拒", !dr.ok && dr.conflicts[0].rule.includes("锁定"), dr);

// 3. 复查人必填
r = createRecheck(records, tasks, { sourceId: "seed-3", team: "丙班", slot: "晚班", reviewer: "  " });
check("复查人必填", !r.ok && r.conflicts[0].rule.includes("信息不完整"));

// 4. 复检完成前原异常保持待处理且锁定
const rec3 = records.find((x) => x.id === "seed-3")!;
check("原异常保持待处理", rec3.disposition === "待处理" && rec3.status === "异常");
r = cycleStatus(records, tasks, "seed-3");
check("复检中原记录锁定", !r.ok && r.conflicts[0].rule.includes("锁定"));
r = removeRecord(records, tasks, "seed-3");
check("复检中禁止删除", !r.ok && r.conflicts[0].rule.includes("锁定"));

// 5. 异常记录禁止直接流转（无复检任务时）
const noTask = { ...rec3, id: "no-task", item: "无任务设备", status: "异常", disposition: "待处理" as const };
records = [noTask, ...records];
r = cycleStatus(records, tasks, "no-task");
check("异常禁止直接流转", !r.ok && r.conflicts[0].rule.includes("复检闭环"), r);
// 有进行中复检的异常（seed-2）优先触发锁定
r = cycleStatus(records, tasks, "seed-2");
check("复检中异常优先锁定", !r.ok && r.conflicts[0].rule.includes("锁定"), r);

// 6. 班组容量超载
let overloadState = { records, tasks };
for (let i = 0; i < TEAM_SLOT_CAPACITY; i++) {
  const rec = {
    ...rec3,
    id: `tmp-${i}`,
    item: `设备${i}`,
    status: "异常",
    disposition: "待处理" as const,
  };
  overloadState.records = [rec, ...overloadState.records];
  const res = createRecheck(overloadState.records, overloadState.tasks, {
    sourceId: rec.id,
    team: "丙班",
    slot: "晚班",
    reviewer: "张三",
  });
  if (res.ok) overloadState = { records: res.records, tasks: res.tasks };
}
const extra = { ...rec3, id: "tmp-x", item: "设备X", status: "异常", disposition: "待处理" as const };
overloadState.records = [extra, ...overloadState.records];
r = createRecheck(overloadState.records, overloadState.tasks, { sourceId: "tmp-x", team: "丙班", slot: "晚班", reviewer: "张三" });
check("班组同时段超载被拒", !r.ok && r.conflicts[0].rule.includes("超载"), r);

// 7. 办结：通过 → 闭环且结果绑定原记录；未通过 → 保持待处理
const task3 = tasks.find((t) => t.sourceId === "seed-3")!;
r = completeRecheck(records, tasks, task3.id, true, "");
check("复检结果必填", !r.ok && r.conflicts[0].rule.includes("结果必填"));
let s = startRecheck(records, tasks, task3.id);
if (s.ok) ({ records, tasks } = s);
r = completeRecheck(records, tasks, task3.id, true, "更换阀盘后恢复正常");
check("复检通过可办结", r.ok);
if (r.ok) ({ records, tasks } = r);
const closed3 = records.find((x) => x.id === "seed-3")!;
check("通过后闭环且原记录未改写", closed3.disposition === "已闭环" && closed3.status === "异常" && closed3.notes === "阀盘卡涩，启闭不灵活");

// 8. 已闭环禁止直接流转/删除，调整须留痕
r = cycleStatus(records, tasks, "seed-3");
check("闭环禁止流转", !r.ok && r.conflicts[0].rule.includes("留痕"));
r = removeRecord(records, tasks, "seed-3");
check("闭环禁止删除", !r.ok);
r = adjustRecord(records, tasks, "seed-3", { status: "正常" }, "");
check("调整原因必填", !r.ok);
r = adjustRecord(records, tasks, "seed-3", { status: "正常", notes: "复检通过后复核确认恢复" }, "复检通过，复核确认");
check("调整留痕成功", r.ok);
if (r.ok) ({ records, tasks } = r);
const adjusted = records.find((x) => x.id === "seed-3")!;
check(
  "旧版已存档",
  adjusted.versions.length === 1 && adjusted.versions[0].snapshot.status === "异常" && adjusted.status === "正常"
);

// 9. 跨班交接：先释放原班组，未完成复检转入下一班
const t1 = tasks.find((t) => t.id === "seed-task-1")!;
r = transferTask(records, tasks, t1.id, "乙班", "手动交接");
check("单任务交接", r.ok);
if (r.ok) ({ records, tasks } = r);
const moved = tasks.find((t) => t.id === "seed-task-1")!;
check("交接留痕", moved.team === "乙班" && moved.handovers.length === 1 && moved.handovers[0].fromTeam === "甲班");

// 整班交接：乙班现有 1 项（seed-task-1），转到丙班
r = handoverTeam(records, tasks, "乙班", "丙班");
check("整班交接", r.ok);
if (r.ok) ({ records, tasks } = r);
check("整班交接后班组变更", tasks.find((t) => t.id === "seed-task-1")!.team === "丙班");

// 整班交接超载整批拒绝：给丙班晚班塞满，再让乙班晚班任务交入
let st = { records, tasks };
for (let i = 0; i < TEAM_SLOT_CAPACITY; i++) {
  const rec = { ...rec3, id: `ov-${i}`, item: `超载设备${i}`, status: "异常", disposition: "待处理" as const };
  st.records = [rec, ...st.records];
  const res = createRecheck(st.records, st.tasks, { sourceId: rec.id, team: "丙班", slot: "晚班", reviewer: "张三" });
  if (res.ok) st = { records: res.records, tasks: res.tasks };
}
const mv = { ...rec3, id: "mv-1", item: "待交设备", status: "异常", disposition: "待处理" as const };
st.records = [mv, ...st.records];
const resMv = createRecheck(st.records, st.tasks, { sourceId: "mv-1", team: "乙班", slot: "晚班", reviewer: "李四" });
if (resMv.ok) st = { records: resMv.records, tasks: resMv.tasks };
r = handoverTeam(st.records, st.tasks, "乙班", "丙班");
check("整班交接超载整批拒绝", !r.ok && r.conflicts.every((c) => c.rule.includes("超载") && c.team === "丙班" && c.slot === "晚班"), r);

// 10. 一致性校验：孤儿任务取消、重复去重、闭环无通过回退
const broken = {
  records: [
    { ...rec3, id: "b-1", item: "孤儿设备", status: "异常", disposition: "已闭环" as const },
  ],
  tasks: [
    { ...t1, id: "bk-1", sourceId: "missing", item: "孤儿设备", team: "甲班", slot: "早班", status: "待复检" as const },
    { ...t1, id: "bk-2", sourceId: "b-1", item: "孤儿设备", team: "甲班", slot: "早班", status: "待复检" as const, createdAt: "2026-09-19T01:00:00.000Z" },
    { ...t1, id: "bk-3", sourceId: "b-1", item: "孤儿设备", team: "乙班", slot: "早班", status: "复检中" as const, createdAt: "2026-09-19T02:00:00.000Z" },
  ],
};
const fixed = validateConsistency(broken.records, broken.tasks);
check("孤儿任务已取消", fixed.tasks.find((t) => t.id === "bk-1")!.status === "已取消");
check(
  "重复复检去重保留最早",
  fixed.tasks.find((t) => t.id === "bk-2")!.status === "待复检" && fixed.tasks.find((t) => t.id === "bk-3")!.status === "已取消"
);
check("闭环无通过回退待处理", fixed.records[0].disposition === "待处理");
check(
  "冲突列出设备/时段/班组/规则",
  fixed.conflicts.length >= 3 && fixed.conflicts.every((c) => c.rule && c.item && c.slot && c.team)
);

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
