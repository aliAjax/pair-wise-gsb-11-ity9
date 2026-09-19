import { FormEvent, useMemo, useState } from "react";
import {
  Conflict,
  InspectionRecord,
  Outcome,
  RecheckTask,
  SLOTS,
  STATUS_FLOW,
  TEAMS,
  TEAM_SLOT_CAPACITY,
  adjustRecord,
  completeRecheck,
  createRecheck,
  cycleStatus,
  handoverTeam,
  isOpen,
  nextTeam,
  openTaskOf,
  removeRecord,
  seedState,
  startRecheck,
  teamSlotLoad,
  transferTask,
  validateConsistency,
} from "./domain";

const STORAGE_KEY = "dfwlfront-10-closedloop-v1";
const AREAS = ["加油区", "油罐区", "收银区"];
const FILTERS = ["全部区域", ...AREAS];
const METRIC_LABELS = ["巡检项", "异常待处理", "复检进行中", "已闭环"];

function coerceRecords(input: unknown): InspectionRecord[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .filter((r) => typeof r.id === "string" && typeof r.item === "string")
    .map((r) => ({
      id: String(r.id),
      item: String(r.item),
      area: String(r.area ?? ""),
      inspector: String(r.inspector ?? ""),
      checkedAt: String(r.checkedAt ?? ""),
      status: String(r.status ?? "未检"),
      notes: String(r.notes ?? ""),
      createdAt: String(r.createdAt ?? new Date().toISOString()),
      disposition:
        r.disposition === "待处理" || r.disposition === "已闭环"
          ? r.disposition
          : r.status === "异常"
            ? "待处理"
            : "无",
      versions: Array.isArray(r.versions) ? (r.versions as InspectionRecord["versions"]) : [],
    }));
}

function coerceTasks(input: unknown): RecheckTask[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
    .filter((t) => typeof t.id === "string" && typeof t.sourceId === "string")
    .map((t) => ({
      id: String(t.id),
      sourceId: String(t.sourceId),
      item: String(t.item ?? ""),
      area: String(t.area ?? ""),
      team: String(t.team ?? TEAMS[0]),
      slot: String(t.slot ?? SLOTS[0]),
      reviewer: String(t.reviewer ?? ""),
      status: (["待复检", "复检中", "通过", "未通过", "已取消"] as const).includes(t.status as never)
        ? (t.status as RecheckTask["status"])
        : "待复检",
      result: String(t.result ?? ""),
      createdAt: String(t.createdAt ?? new Date().toISOString()),
      completedAt: typeof t.completedAt === "string" ? t.completedAt : null,
      handovers: Array.isArray(t.handovers) ? (t.handovers as RecheckTask["handovers"]) : [],
    }));
}

/** 加载并立即做一致性校验，保证刷新后关系一致 */
function loadState(): { records: InspectionRecord[]; tasks: RecheckTask[]; conflicts: Conflict[] } {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { records?: unknown; tasks?: unknown };
      return validateConsistency(coerceRecords(parsed.records), coerceTasks(parsed.tasks));
    } catch {
      // 数据损坏时回退种子数据
    }
  }
  return { ...seedState(), conflicts: [] };
}

function persist(records: InspectionRecord[], tasks: RecheckTask[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ records, tasks }));
}

function fmtTime(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function statusPill(status: string) {
  if (status === "异常" || status === "未通过") return "pill red";
  if (status === "正常" || status === "通过") return "pill green";
  if (status === "复检中") return "pill blue";
  if (status === "已取消") return "pill gray";
  return "pill amber";
}

const blankForm = { item: "", area: "", inspector: "", checkedAt: "" };

export default function App() {
  const [initial] = useState(loadState);
  const [records, setRecords] = useState<InspectionRecord[]>(initial.records);
  const [tasks, setTasks] = useState<RecheckTask[]>(initial.tasks);
  const [conflicts, setConflicts] = useState<Conflict[]>(initial.conflicts);
  const [notice, setNotice] = useState("");

  const [form, setForm] = useState(blankForm);
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState(FILTERS[0]);

  const [recheckFor, setRecheckFor] = useState<string | null>(null);
  const [recheckForm, setRecheckForm] = useState({ team: TEAMS[0] as string, slot: SLOTS[0] as string, reviewer: "" });
  const [adjustFor, setAdjustFor] = useState<string | null>(null);
  const [adjustForm, setAdjustForm] = useState({ status: "", notes: "", reason: "" });
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [finishFor, setFinishFor] = useState<string | null>(null);
  const [finishNote, setFinishNote] = useState("");
  const [transferFor, setTransferFor] = useState<string | null>(null);
  const [transferTeam, setTransferTeam] = useState<string>(TEAMS[1]);
  const [handoverFrom, setHandoverFrom] = useState<string>(TEAMS[0]);

  /** 统一提交：成功落库，失败把冲突（设备/时段/班组/触发规则）推入冲突面板 */
  function apply(outcome: Outcome, after?: () => void) {
    if (outcome.ok) {
      setRecords(outcome.records);
      setTasks(outcome.tasks);
      persist(outcome.records, outcome.tasks);
      setNotice(outcome.message);
      after?.();
    } else {
      setConflicts((prev) => [...outcome.conflicts, ...prev].slice(0, 50));
      setNotice("");
    }
  }

  function runConsistencyCheck() {
    const result = validateConsistency(records, tasks);
    setRecords(result.records);
    setTasks(result.tasks);
    persist(result.records, result.tasks);
    setConflicts((prev) => [...result.conflicts, ...prev].slice(0, 50));
    setNotice(
      result.conflicts.length ? `一致性校验完成：修复/报告 ${result.conflicts.length} 处` : "一致性校验完成：关系一致，无冲突"
    );
  }

  const filteredRecords = useMemo(
    () => (filter.startsWith("全部") ? records : records.filter((r) => r.area === filter)),
    [filter, records]
  );

  const sortedTasks = useMemo(
    () => [...tasks].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.createdAt.localeCompare(a.createdAt)),
    [tasks]
  );

  const metrics = useMemo(
    () => [
      records.length,
      records.filter((r) => r.disposition === "待处理").length,
      tasks.filter(isOpen).length,
      records.filter((r) => r.disposition === "已闭环").length,
    ],
    [records, tasks]
  );

  const chartRows = STATUS_FLOW.map((status) => ({
    status,
    value: records.filter((r) => r.status === status).length,
  }));
  const maxChart = Math.max(1, ...chartRows.map((row) => row.value));

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const record: InspectionRecord = {
      id: crypto.randomUUID(),
      ...form,
      status: "未检",
      notes: note || "暂无备注",
      createdAt: new Date().toISOString(),
      disposition: "无",
      versions: [],
    };
    const nextRecords = [record, ...records];
    setRecords(nextRecords);
    persist(nextRecords, tasks);
    setForm(blankForm);
    setNote("");
    setNotice(`已加入清单：${record.item}`);
  }

  function submitRecheck(recordId: string) {
    apply(
      createRecheck(records, tasks, { sourceId: recordId, ...recheckForm }),
      () => setRecheckFor(null)
    );
  }

  function submitAdjust(recordId: string) {
    apply(
      adjustRecord(records, tasks, recordId, { status: adjustForm.status, notes: adjustForm.notes }, adjustForm.reason),
      () => setAdjustFor(null)
    );
  }

  function submitFinish(taskId: string, pass: boolean) {
    apply(completeRecheck(records, tasks, taskId, pass, finishNote), () => {
      setFinishFor(null);
      setFinishNote("");
    });
  }

  return (
    <main className="app">
      <div className="shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">石油行业前端最小闭环</p>
            <h1>油站设备巡检清单</h1>
            <p className="subtitle">
              异常巡检生成复检任务，绑定责任班组、时段与复查人；复检完成前原异常保持待处理，结果写回原记录；
              跨班交接先释放原班组，已闭环调整留痕可追溯。
            </p>
          </div>
          <div className="stack">
            {["React", "Vite", "TypeScript", "localStorage"].map((item) => (
              <span className="tag" key={item}>{item}</span>
            ))}
          </div>
        </header>

        <section className="metrics">
          {METRIC_LABELS.map((label, index) => (
            <article className="metric" key={label}>
              <span>{label}</span>
              <strong>{metrics[index]}</strong>
            </article>
          ))}
        </section>

        {notice && <div className="notice">{notice}</div>}

        <section className="workspace">
          <div className="side">
            <form className="panel" onSubmit={handleSubmit}>
              <h2>新增巡检项</h2>
              <div className="form-grid">
                <label>
                  巡检项
                  <input value={form.item} onChange={(e) => setForm({ ...form, item: e.target.value })} required />
                </label>
                <label>
                  区域
                  <select value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} required>
                    <option value="">请选择</option>
                    {AREAS.map((area) => (
                      <option key={area}>{area}</option>
                    ))}
                  </select>
                </label>
                <label>
                  巡检人
                  <input value={form.inspector} onChange={(e) => setForm({ ...form, inspector: e.target.value })} required />
                </label>
                <label>
                  巡检日期
                  <input
                    type="date"
                    value={form.checkedAt}
                    onChange={(e) => setForm({ ...form, checkedAt: e.target.value })}
                    required
                  />
                </label>
                <label>
                  备注
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="填写处理说明或现场备注" />
                </label>
                <button type="submit">加入清单</button>
              </div>
            </form>

            <section className="panel">
              <h2>班组负荷与交接</h2>
              <div className="team-loads">
                {TEAMS.map((team) => (
                  <div className="team-row" key={team}>
                    <strong>{team}</strong>
                    <div className="slot-chips">
                      {SLOTS.map((slot) => {
                        const load = teamSlotLoad(tasks, team, slot);
                        const cls =
                          load > TEAM_SLOT_CAPACITY ? "slot-chip over" : load === TEAM_SLOT_CAPACITY ? "slot-chip full" : "slot-chip";
                        return (
                          <span className={cls} key={slot}>
                            {slot} {load}/{TEAM_SLOT_CAPACITY}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="handover-box">
                <label>
                  交班班组
                  <select value={handoverFrom} onChange={(e) => setHandoverFrom(e.target.value)}>
                    {TEAMS.map((team) => (
                      <option key={team}>{team}</option>
                    ))}
                  </select>
                </label>
                <p className="handover-hint">
                  未完成复检 {tasks.filter((t) => isOpen(t) && t.team === handoverFrom).length} 项 → 下一班{" "}
                  {nextTeam(handoverFrom)}（先释放原班组，超载则整批拒绝）
                </p>
                <button type="button" onClick={() => apply(handoverTeam(records, tasks, handoverFrom, nextTeam(handoverFrom)))}>
                  整班交接
                </button>
              </div>
            </section>
          </div>

          <div className="main-col">
            <section className="list-panel">
              <div className="toolbar">
                <h2>巡检记录</h2>
                <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                  {FILTERS.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </div>

              <div className="record-grid">
                {filteredRecords.length === 0 ? (
                  <div className="empty">暂无匹配数据</div>
                ) : (
                  filteredRecords.map((record) => {
                    const openTask = openTaskOf(tasks, record.id);
                    const boundTasks = tasks.filter((t) => t.sourceId === record.id);
                    const closedBy = boundTasks.find((t) => t.status === "通过");
                    return (
                      <article className="record" key={record.id}>
                        <div className="record-head">
                          <p className="record-title">
                            {record.item} / {record.area}
                          </p>
                          <div className="pill-row">
                            <span className={statusPill(record.status)}>{record.status}</span>
                            {record.disposition !== "无" && (
                              <span className={record.disposition === "已闭环" ? "pill green" : "pill amber"}>
                                {record.disposition}
                              </span>
                            )}
                            {openTask && <span className="pill blue">复检中</span>}
                          </div>
                        </div>
                        <div className="details">
                          <span>巡检人: {record.inspector}</span>
                          <span>巡检日期: {record.checkedAt}</span>
                          <span>绑定复检: {boundTasks.length ? `${boundTasks.length} 项` : "无"}</span>
                          <span>创建: {fmtTime(record.createdAt)}</span>
                        </div>
                        <p className="note">{record.notes}</p>
                        {openTask && (
                          <p className="locked-tip">
                            复检完成前原异常保持待处理：{openTask.team} / {openTask.slot} / 复查人 {openTask.reviewer}
                          </p>
                        )}
                        {closedBy?.completedAt && (
                          <p className="closure">
                            闭环依据：{closedBy.reviewer} 复检通过（{fmtTime(closedBy.completedAt)}）— {closedBy.result}
                          </p>
                        )}
                        <div className="actions">
                          <button type="button" onClick={() => apply(cycleStatus(records, tasks, record.id))}>
                            流转状态
                          </button>
                          {record.status === "异常" && !openTask && (
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => {
                                setRecheckFor(recheckFor === record.id ? null : record.id);
                                setRecheckForm({ team: TEAMS[0], slot: SLOTS[0], reviewer: "" });
                              }}
                            >
                              生成复检任务
                            </button>
                          )}
                          {record.disposition === "已闭环" && (
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => {
                                setAdjustFor(adjustFor === record.id ? null : record.id);
                                setAdjustForm({ status: record.status, notes: record.notes, reason: "" });
                              }}
                            >
                              调整留痕
                            </button>
                          )}
                          {record.versions.length > 0 && (
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => setHistoryFor(historyFor === record.id ? null : record.id)}
                            >
                              留痕 {record.versions.length}
                            </button>
                          )}
                          <button
                            type="button"
                            className="secondary"
                            onClick={() =>
                              navigator.clipboard?.writeText(`${record.item} / ${record.area} / ${record.status} / ${record.disposition}`)
                            }
                          >
                            复制摘要
                          </button>
                          <button type="button" className="danger" onClick={() => apply(removeRecord(records, tasks, record.id))}>
                            删除
                          </button>
                        </div>

                        {recheckFor === record.id && (
                          <div className="inline-form">
                            <div className="inline-grid">
                              <label>
                                责任班组
                                <select
                                  value={recheckForm.team}
                                  onChange={(e) => setRecheckForm({ ...recheckForm, team: e.target.value })}
                                >
                                  {TEAMS.map((team) => (
                                    <option key={team}>{team}</option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                时段
                                <select
                                  value={recheckForm.slot}
                                  onChange={(e) => setRecheckForm({ ...recheckForm, slot: e.target.value })}
                                >
                                  {SLOTS.map((slot) => (
                                    <option key={slot}>{slot}</option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                复查人
                                <input
                                  value={recheckForm.reviewer}
                                  placeholder="填写复查人姓名"
                                  onChange={(e) => setRecheckForm({ ...recheckForm, reviewer: e.target.value })}
                                />
                              </label>
                            </div>
                            <div className="actions">
                              <button type="button" onClick={() => submitRecheck(record.id)}>
                                确认生成
                              </button>
                              <button type="button" className="secondary" onClick={() => setRecheckFor(null)}>
                                取消
                              </button>
                            </div>
                          </div>
                        )}

                        {adjustFor === record.id && (
                          <div className="inline-form">
                            <div className="inline-grid">
                              <label>
                                结论状态
                                <select
                                  value={adjustForm.status}
                                  onChange={(e) => setAdjustForm({ ...adjustForm, status: e.target.value })}
                                >
                                  <option>异常</option>
                                  <option>正常</option>
                                </select>
                              </label>
                              <label>
                                调整原因（必填）
                                <input
                                  value={adjustForm.reason}
                                  placeholder="例如：复检通过后复核确认恢复"
                                  onChange={(e) => setAdjustForm({ ...adjustForm, reason: e.target.value })}
                                />
                              </label>
                            </div>
                            <label>
                              备注
                              <textarea
                                value={adjustForm.notes}
                                onChange={(e) => setAdjustForm({ ...adjustForm, notes: e.target.value })}
                              />
                            </label>
                            <div className="actions">
                              <button type="button" onClick={() => submitAdjust(record.id)}>
                                确认调整（旧版存档）
                              </button>
                              <button type="button" className="secondary" onClick={() => setAdjustFor(null)}>
                                取消
                              </button>
                            </div>
                          </div>
                        )}

                        {historyFor === record.id && record.versions.length > 0 && (
                          <div className="versions">
                            {record.versions.map((version) => (
                              <div className="version-item" key={version.id}>
                                <strong>
                                  {fmtTime(version.at)} · {version.reason}
                                </strong>
                                <span>
                                  旧版：状态 {version.snapshot.status} / 备注 {version.snapshot.notes} / 巡检人{" "}
                                  {version.snapshot.inspector} / 日期 {version.snapshot.checkedAt}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </article>
                    );
                  })
                )}
              </div>

              <div className="mini-chart">
                {chartRows.map((row) => (
                  <div className="bar" key={row.status}>
                    <span>{row.status}</span>
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${(row.value / maxChart) * 100}%` }} />
                    </div>
                    <strong>{row.value}</strong>
                  </div>
                ))}
              </div>
            </section>

            <section className="list-panel">
              <div className="toolbar">
                <h2>复检任务</h2>
                <span className="hint">进行中 {tasks.filter(isOpen).length} 项</span>
              </div>
              <div className="record-grid">
                {sortedTasks.length === 0 ? (
                  <div className="empty">暂无复检任务，异常记录可生成复检</div>
                ) : (
                  sortedTasks.map((task) => {
                    const source = records.find((r) => r.id === task.sourceId);
                    return (
                      <article className="record" key={task.id}>
                        <div className="record-head">
                          <p className="record-title">
                            {task.item} / {task.area}
                          </p>
                          <span className={statusPill(task.status)}>{task.status}</span>
                        </div>
                        <div className="details">
                          <span>责任班组: {task.team}</span>
                          <span>时段: {task.slot}</span>
                          <span>复查人: {task.reviewer}</span>
                          <span>
                            绑定原记录: {source ? `${source.item}（${source.checkedAt} ${source.inspector}）` : "原记录缺失"}
                          </span>
                          <span>创建: {fmtTime(task.createdAt)}</span>
                          {task.completedAt && <span>办结: {fmtTime(task.completedAt)}</span>}
                        </div>
                        {task.result && <p className="note">复检结果：{task.result}</p>}
                        {task.handovers.length > 0 && (
                          <p className="handover-trail">
                            交接链：{task.handovers.map((h) => `${h.fromTeam}→${h.toTeam}`).join("，")}（
                            {task.handovers[task.handovers.length - 1].note}）
                          </p>
                        )}
                        {isOpen(task) && (
                          <div className="actions">
                            {task.status === "待复检" && (
                              <button type="button" onClick={() => apply(startRecheck(records, tasks, task.id))}>
                                开始复检
                              </button>
                            )}
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => {
                                setFinishFor(finishFor === task.id ? null : task.id);
                                setFinishNote("");
                              }}
                            >
                              办结复检
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => {
                                setTransferFor(transferFor === task.id ? null : task.id);
                                setTransferTeam(nextTeam(task.team));
                              }}
                            >
                              交接
                            </button>
                          </div>
                        )}

                        {finishFor === task.id && (
                          <div className="inline-form">
                            <label>
                              复检结果（写回绑定原记录）
                              <textarea
                                value={finishNote}
                                placeholder="填写复检结论，通过/未通过都会绑定到原异常记录"
                                onChange={(e) => setFinishNote(e.target.value)}
                              />
                            </label>
                            <div className="actions">
                              <button type="button" onClick={() => submitFinish(task.id, true)}>
                                复检通过
                              </button>
                              <button type="button" className="danger" onClick={() => submitFinish(task.id, false)}>
                                复检未通过
                              </button>
                              <button type="button" className="secondary" onClick={() => setFinishFor(null)}>
                                取消
                              </button>
                            </div>
                          </div>
                        )}

                        {transferFor === task.id && (
                          <div className="inline-form">
                            <div className="inline-grid">
                              <label>
                                转入班组
                                <select value={transferTeam} onChange={(e) => setTransferTeam(e.target.value)}>
                                  {TEAMS.filter((team) => team !== task.team).map((team) => (
                                    <option key={team}>{team}</option>
                                  ))}
                                </select>
                              </label>
                            </div>
                            <div className="actions">
                              <button
                                type="button"
                                onClick={() =>
                                  apply(transferTask(records, tasks, task.id, transferTeam, "手动交接"), () => setTransferFor(null))
                                }
                              >
                                确认交接（先释放{task.team}）
                              </button>
                              <button type="button" className="secondary" onClick={() => setTransferFor(null)}>
                                取消
                              </button>
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })
                )}
              </div>
            </section>
          </div>
        </section>

        <section className="list-panel conflict-panel">
          <div className="toolbar">
            <h2>冲突与一致性</h2>
            <div className="actions">
              <button type="button" className="secondary" onClick={runConsistencyCheck}>
                重新校验
              </button>
              <button type="button" className="secondary" onClick={() => setConflicts([])} disabled={conflicts.length === 0}>
                清空
              </button>
            </div>
          </div>
          {conflicts.length === 0 ? (
            <div className="empty">当前无冲突，刷新后关系一致</div>
          ) : (
            <div className="conflict-list">
              {conflicts.map((conflict) => (
                <div className="conflict-item" key={conflict.id}>
                  <span className="rule-tag">{conflict.rule}</span>
                  <div className="conflict-meta">
                    <span>设备：{conflict.item}</span>
                    <span>时段：{conflict.slot}</span>
                    <span>班组：{conflict.team}</span>
                    <span>{fmtTime(conflict.at)}</span>
                  </div>
                  <p>{conflict.detail}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
