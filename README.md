# storage-geo-failover-cutover-planner
规划跨地域存储故障切换、回切和数据校验

> **说明：本仓库中所有存储与 DNS 操作均为本地模拟。** 规划器只做纯计算，
> 不连接真实存储集群、不修改真实 DNS/路由，fencing、提升、传播耗时等均以
> 输入参数形式注入，便于离线评估与测试。

## 背景

主地域存储故障后切到异地副本时，异步复制可能仍有未追平写入：
立即切流可能超过 RPO，等待太久又会超过 RTO。本规划器根据当前复制位点、
对象版本、见证节点状态、DNS/路由传播时间、RPO/RTO 与客户端重试窗口，
计算**可安全切换的最早时间**，并输出完整的切换计划。

## 运行环境

- Node.js 24.16.0（仅使用内置模块，无第三方依赖）

## 使用

```js
const { planFailover, planFailback } = require('./src/planner.js');

const plan = planFailover({
  now: 10_000,
  primary:  { lastAckWrite: { lsn: 1000, at: 9900 }, objects: { a: { version: 3 } } },
  replica:  { appliedLsn: 995, appliedAt: 9880, replayRateLsnPerMs: 0.05,
              objects: { a: { version: 3 } } },
  replication: { status: 'healthy' },          // 或 { status: 'broken', permanent: true }
  witness:  { reachable: true, quorum: true },
  dns:      { propagationMs: 2000 },
  client:   { retryWindowMs: 1000 },
  rpo:      { maxLagMs: 500, maxLagLsn: 50 },
  rto:      { maxDowntimeMs: 60_000 },
});
```

## 输出

- `decision`：`CUTOVER` / `ABORT_RPO` / `ABORT_RTO` / `MANUAL_REQUIRED`
- `earliestCutoverAt`：可安全切换的最早时间
  （fence + 追平 + 提升 + DNS 传播 + 客户端重试窗口）
- `phases`：切换阶段时间线
  `DETECT → ASSESS → FENCE_OLD_PRIMARY → WAIT_CATCHUP → PROMOTE_REPLICA → ROUTE_SWITCH → DRAIN_CLIENTS → SERVE`
- `dataLossBound`：数据损失上界（滞后 LSN/毫秒、缺失对象、版本落后对象）
- `fencing`：fencing 动作（存储层拒绝写入 + 撤销客户端凭证），
  切换后旧主保持 fenced，防止恢复后仍接受写入
- `failback`：回切条件（旧主降级、反向复制追平、**双向差异修复完成**、
  见证节点恢复、重新通过 RPO/RTO 评估）与逐对象修复计划
- `failureBranches`：失败分支（复制永久中断、见证节点失联、fence 未确认、
  追平期间复制中断、旧路由晚到写入等）

## 关键行为

- **RPO 判定**：复制永久中断且滞后超 RPO 时默认放弃切换；
  显式 `allowForcedCutover: true` 才允许强制切换并报告损失上界。
- **RTO 判定**：fence + 追平 + 提升 + 路由收敛总耗时超预算则放弃并给出建议。
- **见证节点失联**：禁止自动切换，转为 `MANUAL_REQUIRED`，防止脑裂双主。
- **旧路由晚到**：DNS 传播与客户端重试窗口内，旧主已 fence，
  晚到写入被拒绝并由客户端重试导向新主。
- **旧主恢复**：`planFailback` 要求旧主保持 fenced、降级为副本、
  反向复制追平、双向对象 diff 为空后才允许回切。

## 测试

```sh
node --test
```

覆盖：正常切流、RPO 不允许（含强制切换分支）、RTO 不足、见证节点失联、
旧主恢复与回切、多对象差异修复。
