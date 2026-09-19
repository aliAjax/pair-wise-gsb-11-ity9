# 油站设备巡检清单

- 行业：石油
- 技术栈：React、Vite、TypeScript、Zustand、Ant Design
- 启动：`npm install && npm run dev`
- 构建：`npm run build`

设备复检与班组交接闭环前端，数据默认保存在浏览器 localStorage 中，方便后续扩展接口、权限、图表或地图能力。

## 闭环规则

1. **异常生成复检**：异常巡检可生成复检任务，必须绑定责任班组、时段、复查人；复检完成前原异常保持"待处理"并被锁定。
2. **唯一与容量**：同一设备同一时段仅允许一个进行中复检；同一班组同一时段最多承载 3 项，超载即拒绝。
3. **结果绑定原记录**：复检通过/未通过都写回绑定的原记录；通过则闭环，未通过保持待处理。
4. **闭环不改写**：已闭环记录禁止直接流转、删除或改写；调整必须填写原因，旧版快照自动存档可查。
5. **跨班交接**：支持单任务交接与整班交接，先释放原班组、未完成复检转入下一班；接班超载则整批拒绝。
6. **刷新一致**：每次加载自动做一致性校验（孤儿任务取消、重复复检去重、状态对齐），也可手动"重新校验"。

所有被拦截的操作都会进入"冲突与一致性"面板，列出设备、时段、班组与触发规则。

## 目录

- `src/domain.ts`：闭环领域逻辑（纯函数），规则常量见 `RULES`
- `src/App.tsx`：巡检记录 / 复检任务 / 班组负荷与交接 / 冲突面板
- `src/domain.test.ts`：领域规则冒烟测试（构建时随 `tsc -b` 一并类型检查）

手动运行冒烟测试：

```bash
npx tsc src/domain.test.ts --outDir /tmp/smoke --module nodenext --target es2020 --moduleResolution nodenext --skipLibCheck --strict
node /tmp/smoke/domain.test.js
```
