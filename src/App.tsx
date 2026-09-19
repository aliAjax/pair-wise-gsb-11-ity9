import { FormEvent, useMemo, useState } from "react";
import {
  Conflict,
  HandoverRecord,
  RecheckResult,
  RecheckTask,
  RULES,
  SLOTS,
  TEAMS,
  TEAM_SLOT_CAPACITY,
  adjustRecheck,
  anomalyInfo,
  completeRecheck,
  createRecheck,
  handover as runHandover,
  isActive,
  loadHandovers,
  loadRechecks,
  saveHandovers,
  saveRechecks,
  scanConflicts,
  startRecheck,
  teamSlotLoad,
} from "./loop";

type Field = {
  key: string;
  label: string;
  type?: "number" | "date" | "select";
  options?: string[];
};

type RecordItem = {
  id: string;
  status: string;
  notes: string;
  createdAt: string;
  [key: string]: string | number;
};

const project = {
  "number": 10,
  "folder": "dfwl/frontend/dfwlfront-10",
  "framework": "react",
  "title": "油站设备巡检清单",
  "subtitle": "异常巡检生成复检任务，结果绑定原记录，跨班交接形成闭环。",
  "industry": "石油",
  "stack": [
    "React",
    "Vite",
    "TypeScript",
    "Zustand",
    "Ant Design"
  ],
  "storageKey": "dfwlfront-10-inspection",
  "formTitle": "新增巡检项",
  "primaryAction": "加入清单",
  "entityLabel": "巡检项",
  "statuses": [
    "未检",
    "正常",
    "异常"
  ],
  "filters": [
    "全部区域",
    "加油区",
    "油罐区",
    "收银区"
  ],
  "fields": [
    {
      "key": "item",
      "label": "巡检项"
    },
    {
      "key": "area",
      "label": "区域",
      "type": "select",
      "options": [
        "加油区",
        "油罐区",
        "收银区"
      ]
    },
    {
      "key": "inspector",
      "label": "巡检人"
    },
    {
      "key": "checkedAt",
      "label": "巡检日期",
      "type": "date"
    }
  ],
  "records": [
    {
      "item": "加油机1号",
      "area": "加油区",
      "inspector": "何鑫",
      "checkedAt": "2026-06-30",
      "status": "正常",
      "notes": "无异常"
    },
    {
      "item": "卸油口密封",
      "area": "油罐区",
      "inspector": "何鑫",
      "checkedAt": "2026-06-30",
      "status": "异常",
      "notes": "密封圈老化"
    }
  ],
  "metricLabels": [
    "巡检项",
    "异常待处理",
    "复检进行中",
    "已闭环"
  ]
} as const;

const fields = project.fields as unknown as Field[];
const statuses: string[] = [...project.statuses];

function createBlank() {
  return Object.fromEntries(fields.map((field) => [field.key, field.type === "number" ? 0 : ""]));
}

function loadRecords(): RecordItem[] {
  const raw = localStorage.getItem(project.storageKey);
  if (!raw) {
    return project.records.map((record, index) => ({
      ...record,
      id: `seed-${index + 1}`,
      createdAt: new Date(Date.now() - index * 86400000).toISOString()
    })) as RecordItem[];
  }
  try {
    return JSON.parse(raw) as RecordItem[];
  } catch {
    return [];
  }
}

function saveRecords(records: RecordItem[]) {
  localStorage.setItem(project.storageKey, JSON.stringify(records));
}

function nextStatus(status: string) {
  const index = statuses.indexOf(status);
  return statuses[(index + 1) % statuses.length];
}

function primaryText(record: RecordItem) {
  const first = fields[0];
  const second = fields[1];
  return [record[first.key], record[second.key]].filter(Boolean).join(" / ") || project.entityLabel;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

export default function App() {
  const [records, setRecords] = useState<RecordItem[]>(loadRecords);
  const [initialLoop] = useState(() => loadRechecks(loadRecords()));
  const [rechecks, setRechecks] = useState<RecheckTask[]>(initialLoop.tasks);
  const [handovers, setHandovers] = useState<HandoverRecord[]>(loadHandovers);
  const [conflicts, setConflicts] = useState<Conflict[]>(() => scanConflicts(initialLoop.tasks));
  const [notices, setNotices] = useState<string[]>(initialLoop.repairs);

  const [form, setForm] = useState<Record<string, string | number>>(createBlank);
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState<string>(project.filters[0]);

  const [recheckFormFor, setRecheckFormFor] = useState<string | null>(null);
  const [recheckDraft, setRecheckDraft] = useState({ slot: SLOTS[0], team: TEAMS[0], reviewer: "" });
  const [completeFor, setCompleteFor] = useState<string | null>(null);
  const [completeDraft, setCompleteDraft] = useState<{ result: RecheckResult; notes: string }>({ result: "通过", notes: "" });
  const [adjustFor, setAdjustFor] = useState<string | null>(null);
  const [adjustDraft, setAdjustDraft] = useState<{ result: RecheckResult; notes: string; reason: string }>({ result: "通过", notes: "", reason: "" });
  const [versionsFor, setVersionsFor] = useState<string | null>(null);
  const [handoverForm, setHandoverForm] = useState({ fromTeam: TEAMS[0], toTeam: TEAMS[1], targetSlot: SLOTS[1] });

  const filteredRecords = useMemo(() => {
    if (filter.startsWith("全部")) return records;
    return records.filter((record) => Object.values(record).includes(filter));
  }, [filter, records]);

  const metrics = useMemo(() => {
    const infos = records.map((record) => anomalyInfo(record.id, record.status, rechecks));
    const pending = infos.filter((info) => info?.state === "待处理").length;
    const closed = infos.filter((info) => info?.state === "已闭环").length;
    const active = rechecks.filter(isActive).length;
    return [records.length, pending, active, closed];
  }, [records, rechecks]);

  const chartRows = statuses.map((status) => ({
    status,
    value: records.filter((record) => record.status === status).length
  }));
  const maxChart = Math.max(1, ...chartRows.map((row) => row.value));

  const sortedRechecks = useMemo(
    () => [...rechecks].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.createdAt.localeCompare(a.createdAt)),
    [rechecks]
  );

  function updateRecords(next: RecordItem[]) {
    setRecords(next);
    saveRecords(next);
  }

  function updateRechecks(next: RecheckTask[]) {
    setRechecks(next);
    saveRechecks(next);
  }

  function updateHandovers(next: HandoverRecord[]) {
    setHandovers(next);
    saveHandovers(next);
  }

  function pushConflicts(next: Conflict[]) {
    if (next.length > 0) setConflicts((prev) => [...next, ...prev]);
  }

  function addNotice(text: string) {
    setNotices((prev) => [text, ...prev].slice(0, 20));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next: RecordItem = {
      ...form,
      id: crypto.randomUUID(),
      status: statuses[0],
      notes: note || "暂无备注",
      createdAt: new Date().toISOString()
    } as RecordItem;
    updateRecords([next, ...records]);
    setForm(createBlank());
    setNote("");
  }

  function handleFlow(record: RecordItem) {
    const info = anomalyInfo(record.id, record.status, rechecks);
    if (record.status === "异常" && info?.activeTask) {
      const task = info.activeTask;
      pushConflicts([{
        id: crypto.randomUUID(),
        device: String(record.item),
        slot: task.slot,
        team: task.team,
        rule: RULES.R3,
        detail: "复检完成前原异常保持待处理，禁止流转状态",
        createdAt: new Date().toISOString()
      }]);
      return;
    }
    if (record.status === "异常" && info?.closedTask) {
      const task = info.closedTask;
      pushConflicts([{
        id: crypto.randomUUID(),
        device: String(record.item),
        slot: task.slot,
        team: task.team,
        rule: RULES.R5,
        detail: "复检已通过，原记录不得直接改写；如需变更请在复检任务中留痕调整",
        createdAt: new Date().toISOString()
      }]);
      return;
    }
    updateRecords(records.map((item) => (item.id === record.id ? { ...item, status: nextStatus(item.status) } : item)));
  }

  function handleDelete(record: RecordItem) {
    const bound = rechecks.filter((task) => task.sourceRecordId === record.id);
    if (bound.length > 0) {
      pushConflicts([{
        id: crypto.randomUUID(),
        device: String(record.item),
        slot: bound[0].slot,
        team: bound[0].team,
        rule: RULES.R4,
        detail: `该记录已绑定 ${bound.length} 条复检任务，绑定关系不得删除`,
        createdAt: new Date().toISOString()
      }]);
      return;
    }
    updateRecords(records.filter((item) => item.id !== record.id));
  }

  function handleCreateRecheck(record: RecordItem) {
    const input = {
      sourceRecordId: record.id,
      device: String(record.item),
      area: String(record.area),
      slot: recheckDraft.slot,
      team: recheckDraft.team,
      reviewer: recheckDraft.reviewer.trim()
    };
    const result = createRecheck(rechecks, input);
    if (result.conflicts.length > 0) {
      pushConflicts(result.conflicts);
      return;
    }
    updateRechecks(result.tasks);
    setRecheckFormFor(null);
    setRecheckDraft({ slot: SLOTS[0], team: TEAMS[0], reviewer: "" });
    addNotice(`已为「${input.device}」生成复检任务：${input.slot} / ${input.team} / 复查人 ${input.reviewer}`);
  }

  function handleComplete(task: RecheckTask) {
    updateRechecks(completeRecheck(rechecks, task.id, completeDraft.result, completeDraft.notes.trim()));
    setCompleteFor(null);
    addNotice(
      completeDraft.result === "通过"
        ? `「${task.device}」复检通过，结果已绑定原记录，原异常闭环`
        : `「${task.device}」复检未通过，结果已绑定原记录，原异常保持待处理`
    );
  }

  function handleAdjust(task: RecheckTask) {
    updateRechecks(adjustRecheck(rechecks, task.id, {
      result: adjustDraft.result,
      notes: adjustDraft.notes.trim(),
      reason: adjustDraft.reason.trim()
    }));
    setAdjustFor(null);
    addNotice(`「${task.device}」复检结果已调整，旧版与原因已留痕`);
  }

  function handleHandover() {
    const { tasks, record, conflicts: handoverConflicts } = runHandover(
      rechecks,
      handoverForm.fromTeam,
      handoverForm.toTeam,
      handoverForm.targetSlot
    );
    pushConflicts(handoverConflicts);
    if (!record) return;
    if (record.transferred.length === 0 && record.blocked.length === 0) {
      addNotice(`${handoverForm.fromTeam} 当前无未完成复检，无需交接`);
      return;
    }
    updateRechecks(tasks);
    updateHandovers([record, ...handovers]);
    addNotice(
      `交接完成：${record.fromTeam} 已释放，${record.transferred.length} 项转入 ${record.toTeam}（${record.targetSlot}）` +
        (record.blocked.length > 0 ? `，${record.blocked.length} 项因冲突保留原班组` : "")
    );
  }

  return (
    <main className="app">
      <div className="shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">{project.industry}行业前端最小闭环</p>
            <h1>{project.title}</h1>
            <p className="subtitle">{project.subtitle}</p>
          </div>
          <div className="stack">{project.stack.map((item) => <span className="tag" key={item}>{item}</span>)}</div>
        </header>

        <section className="metrics">
          {project.metricLabels.map((label, index) => (
            <article className="metric" key={label}>
              <span>{label}</span>
              <strong>{metrics[index]}</strong>
            </article>
          ))}
        </section>

        {(conflicts.length > 0 || notices.length > 0) && (
          <section className="consistency">
            <div className="consistency-head">
              <h2>闭环一致性与冲突</h2>
              <button className="secondary" type="button" onClick={() => { setConflicts([]); setNotices([]); }}>清空</button>
            </div>
            {notices.length > 0 && (
              <ul className="notice-list">
                {notices.map((item, index) => <li key={index}>{item}</li>)}
              </ul>
            )}
            {conflicts.length > 0 && (
              <ul className="conflict-list">
                {conflicts.map((conflict) => (
                  <li key={conflict.id}>
                    <strong>{conflict.rule}</strong>
                    <span className="conflict-meta">设备：{conflict.device} ｜ 时段：{conflict.slot} ｜ 班组：{conflict.team}</span>
                    <span>{conflict.detail}</span>
                    <time>{formatTime(conflict.createdAt)}</time>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section className="workspace">
          <div className="side">
            <form className="panel" onSubmit={handleSubmit}>
              <h2>{project.formTitle}</h2>
              <div className="form-grid">
                {fields.map((field) => (
                  <label key={field.key}>
                    {field.label}
                    {field.type === "select" ? (
                      <select
                        value={String(form[field.key])}
                        onChange={(event) => setForm({ ...form, [field.key]: event.target.value })}
                        required
                      >
                        <option value="">请选择</option>
                        {field.options?.map((option) => <option key={option}>{option}</option>)}
                      </select>
                    ) : (
                      <input
                        type={field.type || "text"}
                        value={form[field.key]}
                        onChange={(event) =>
                          setForm({ ...form, [field.key]: field.type === "number" ? Number(event.target.value) : event.target.value })
                        }
                        required
                      />
                    )}
                  </label>
                ))}
                <label>
                  备注
                  <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="填写处理说明或现场备注" />
                </label>
                <button type="submit">{project.primaryAction}</button>
              </div>
            </form>

            <section className="panel">
              <h2>班组交接</h2>
              <div className="form-grid">
                <label>
                  交班班组
                  <select value={handoverForm.fromTeam} onChange={(event) => setHandoverForm({ ...handoverForm, fromTeam: event.target.value })}>
                    {TEAMS.map((team) => <option key={team}>{team}</option>)}
                  </select>
                </label>
                <label>
                  接班班组
                  <select value={handoverForm.toTeam} onChange={(event) => setHandoverForm({ ...handoverForm, toTeam: event.target.value })}>
                    {TEAMS.map((team) => <option key={team}>{team}</option>)}
                  </select>
                </label>
                <label>
                  转入时段
                  <select value={handoverForm.targetSlot} onChange={(event) => setHandoverForm({ ...handoverForm, targetSlot: event.target.value })}>
                    {SLOTS.map((slot) => <option key={slot}>{slot}</option>)}
                  </select>
                </label>
                <button type="button" onClick={handleHandover}>执行交接</button>
                <p className="hint">先释放交班班组的未完成复检，再逐项转入接班班组；超载或设备时段冲突的任务保留原班组并列入冲突。</p>
              </div>

              <div className="load-board">
                <table>
                  <thead>
                    <tr>
                      <th>班组负载</th>
                      {SLOTS.map((slot) => <th key={slot}>{slot.split(" ")[0]}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {TEAMS.map((team) => (
                      <tr key={team}>
                        <td>{team}</td>
                        {SLOTS.map((slot) => {
                          const load = teamSlotLoad(rechecks, team, slot);
                          return (
                            <td key={slot} className={load >= TEAM_SLOT_CAPACITY ? "overload" : ""}>
                              {load}/{TEAM_SLOT_CAPACITY}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {handovers.length > 0 && (
                <div className="handover-history">
                  <h3>交接记录</h3>
                  <ul>
                    {handovers.slice(0, 5).map((item) => (
                      <li key={item.id}>
                        {item.fromTeam} → {item.toTeam} · {item.targetSlot} · 转入 {item.transferred.length} 项 / 冲突 {item.blocked.length} 项 · {formatTime(item.createdAt)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          </div>

          <section className="list-panel">
            <div className="toolbar">
              <h2>{project.entityLabel}列表</h2>
              <select value={filter} onChange={(event) => setFilter(event.target.value)}>
                {project.filters.map((item) => <option key={item}>{item}</option>)}
              </select>
            </div>

            <div className="record-grid">
              {filteredRecords.length === 0 ? <div className="empty">暂无匹配数据</div> : filteredRecords.map((record) => {
                const info = anomalyInfo(record.id, record.status, rechecks);
                const canGenerate = record.status === "异常" && info !== null && !info.activeTask && !info.closedTask;
                return (
                  <article className="record" key={record.id}>
                    <div className="record-head">
                      <p className="record-title">{primaryText(record)}</p>
                      <div className="badges">
                        <span className="status">{record.status}</span>
                        {info && (
                          <span className={`anomaly ${info.state === "已闭环" ? "closed" : "pending"}`}>
                            {info.state}{info.activeTask ? " · 复检中" : ""}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="details">
                      {fields.map((field) => (
                        <span key={field.key}>{field.label}: {record[field.key]}</span>
                      ))}
                    </div>
                    <p className="note">{record.notes}</p>
                    {info?.activeTask && (
                      <p className="bound">
                        复检任务：{info.activeTask.slot} / {info.activeTask.team} / 复查人 {info.activeTask.reviewer}（{info.activeTask.status}）
                      </p>
                    )}
                    {info?.closedTask && (
                      <p className="bound closed">
                        闭环依据：复检通过 · {info.closedTask.team} / {info.closedTask.reviewer} · {info.closedTask.completedAt ? formatTime(info.closedTask.completedAt) : ""}
                      </p>
                    )}
                    <div className="actions">
                      <button type="button" onClick={() => handleFlow(record)}>流转状态</button>
                      {canGenerate && (
                        <button
                          type="button"
                          onClick={() => {
                            setRecheckFormFor(record.id);
                            setRecheckDraft({ slot: SLOTS[0], team: TEAMS[0], reviewer: "" });
                          }}
                        >
                          生成复检
                        </button>
                      )}
                      <button className="secondary" type="button" onClick={() => navigator.clipboard?.writeText(primaryText(record))}>
                        复制摘要
                      </button>
                      <button className="danger" type="button" onClick={() => handleDelete(record)}>
                        删除
                      </button>
                    </div>
                    {recheckFormFor === record.id && (
                      <form
                        className="inline-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          handleCreateRecheck(record);
                        }}
                      >
                        <div className="inline-grid">
                          <label>
                            复检时段
                            <select value={recheckDraft.slot} onChange={(event) => setRecheckDraft({ ...recheckDraft, slot: event.target.value })}>
                              {SLOTS.map((slot) => <option key={slot}>{slot}</option>)}
                            </select>
                          </label>
                          <label>
                            责任班组
                            <select value={recheckDraft.team} onChange={(event) => setRecheckDraft({ ...recheckDraft, team: event.target.value })}>
                              {TEAMS.map((team) => <option key={team}>{team}</option>)}
                            </select>
                          </label>
                          <label>
                            复查人
                            <input
                              required
                              value={recheckDraft.reviewer}
                              onChange={(event) => setRecheckDraft({ ...recheckDraft, reviewer: event.target.value })}
                              placeholder="填写复查人姓名"
                            />
                          </label>
                        </div>
                        <div className="actions">
                          <button type="submit">确认生成复检任务</button>
                          <button className="secondary" type="button" onClick={() => setRecheckFormFor(null)}>取消</button>
                        </div>
                        <p className="hint">规则校验：同一设备同一时段仅一个进行中复检；同一班组同一时段不超过 {TEAM_SLOT_CAPACITY} 项。</p>
                      </form>
                    )}
                  </article>
                );
              })}
            </div>

            <div className="mini-chart">
              {chartRows.map((row) => (
                <div className="bar" key={row.status}>
                  <span>{row.status}</span>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${(row.value / maxChart) * 100}%` }} /></div>
                  <strong>{row.value}</strong>
                </div>
              ))}
            </div>
          </section>
        </section>

        <section className="panel recheck-panel">
          <div className="toolbar">
            <h2>复检任务闭环</h2>
            <span className="hint">异常 → 复检 → 结果绑定原记录；通过后调整须留痕</span>
          </div>
          <div className="record-grid">
            {sortedRechecks.length === 0 ? <div className="empty">暂无复检任务，标记异常后可生成</div> : sortedRechecks.map((task) => {
              const source = records.find((record) => record.id === task.sourceRecordId);
              return (
                <article className={`recheck ${task.status === "已完成" ? "done" : ""}`} key={task.id}>
                  <div className="record-head">
                    <p className="record-title">{task.device} / {task.area}</p>
                    <span className={`status recheck-status-${task.status}`}>
                      {task.status}{task.result ? ` · ${task.result}` : ""}
                    </span>
                  </div>
                  <div className="details">
                    <span>时段: {task.slot}</span>
                    <span>责任班组: {task.team}</span>
                    <span>复查人: {task.reviewer}</span>
                    <span>绑定原记录: {source ? `${source.inspector} · ${source.checkedAt}` : "已缺失"}</span>
                    <span>创建: {formatTime(task.createdAt)}</span>
                    {task.completedAt && <span>完成: {formatTime(task.completedAt)}</span>}
                    {task.releasedFrom && <span>交接释放自: {task.releasedFrom}</span>}
                    {task.versions.length > 0 && <span>历史版本: {task.versions.length}</span>}
                  </div>
                  {task.result && <p className="note">结果：{task.result}{task.resultNotes ? ` — ${task.resultNotes}` : ""}</p>}
                  <div className="actions">
                    {task.status === "待复检" && (
                      <button type="button" onClick={() => updateRechecks(startRecheck(rechecks, task.id))}>开始复检</button>
                    )}
                    {task.status === "复检中" && (
                      <button
                        type="button"
                        onClick={() => {
                          setCompleteFor(task.id);
                          setCompleteDraft({ result: "通过", notes: "" });
                        }}
                      >
                        填写复检结果
                      </button>
                    )}
                    {task.status === "已完成" && (
                      <>
                        <button
                          className="secondary"
                          type="button"
                          onClick={() => {
                            setAdjustFor(task.id);
                            setAdjustDraft({ result: task.result ?? "通过", notes: task.resultNotes, reason: "" });
                          }}
                        >
                          留痕调整
                        </button>
                        {task.versions.length > 0 && (
                          <button
                            className="secondary"
                            type="button"
                            onClick={() => setVersionsFor(versionsFor === task.id ? null : task.id)}
                          >
                            历史版本（{task.versions.length}）
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  {completeFor === task.id && (
                    <form
                      className="inline-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        handleComplete(task);
                      }}
                    >
                      <div className="inline-grid">
                        <label>
                          复检结果
                          <select
                            value={completeDraft.result}
                            onChange={(event) => setCompleteDraft({ ...completeDraft, result: event.target.value as RecheckResult })}
                          >
                            <option>通过</option>
                            <option>未通过</option>
                          </select>
                        </label>
                        <label>
                          结果说明
                          <input
                            value={completeDraft.notes}
                            onChange={(event) => setCompleteDraft({ ...completeDraft, notes: event.target.value })}
                            placeholder="如：已更换密封圈，复测正常"
                          />
                        </label>
                      </div>
                      <div className="actions">
                        <button type="submit">提交结果并绑定原记录</button>
                        <button className="secondary" type="button" onClick={() => setCompleteFor(null)}>取消</button>
                      </div>
                      <p className="hint">提交后结果绑定原异常记录；通过则原异常闭环，未通过则保持待处理，可再次发起复检。</p>
                    </form>
                  )}
                  {adjustFor === task.id && (
                    <form
                      className="inline-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        handleAdjust(task);
                      }}
                    >
                      <div className="inline-grid">
                        <label>
                          调整后结果
                          <select
                            value={adjustDraft.result}
                            onChange={(event) => setAdjustDraft({ ...adjustDraft, result: event.target.value as RecheckResult })}
                          >
                            <option>通过</option>
                            <option>未通过</option>
                          </select>
                        </label>
                        <label>
                          调整后说明
                          <input
                            value={adjustDraft.notes}
                            onChange={(event) => setAdjustDraft({ ...adjustDraft, notes: event.target.value })}
                          />
                        </label>
                        <label>
                          调整原因（必填）
                          <input
                            required
                            value={adjustDraft.reason}
                            onChange={(event) => setAdjustDraft({ ...adjustDraft, reason: event.target.value })}
                            placeholder="如：复测数据补录错误"
                          />
                        </label>
                      </div>
                      <div className="actions">
                        <button type="submit">保存调整并保留旧版</button>
                        <button className="secondary" type="button" onClick={() => setAdjustFor(null)}>取消</button>
                      </div>
                      <p className="hint">通过后不得直接改写：本次调整将记录原因，旧版结果自动归档。</p>
                    </form>
                  )}
                  {versionsFor === task.id && (
                    <ul className="versions">
                      {task.versions.map((version) => (
                        <li key={version.id}>
                          <span>旧版：{version.prevResult} · {version.prevNotes || "无说明"} · 复查人 {version.prevReviewer}</span>
                          <span>调整原因：{version.reason}</span>
                          <time>{formatTime(version.changedAt)}</time>
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
