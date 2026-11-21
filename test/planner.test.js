'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  PHASE,
  DECISION,
  planFailover,
  planFailback,
  diffObjects,
} = require('../src/planner.js');

function baseInput(overrides = {}) {
  return {
    now: 10_000,
    primary: {
      region: 'cn-east',
      lastAckWrite: { lsn: 1_000, at: 9_900 },
      objects: { a: { version: 3 }, b: { version: 2 } },
    },
    replica: {
      region: 'cn-north',
      appliedLsn: 995,
      appliedAt: 9_880,
      replayRateLsnPerMs: 0.05, // 5 lsn / 100ms
      objects: { a: { version: 3 }, b: { version: 2 } },
    },
    replication: { status: 'healthy' },
    witness: { reachable: true, quorum: true },
    dns: { propagationMs: 2_000 },
    client: { retryWindowMs: 1_000 },
    rpo: { maxLagMs: 500, maxLagLsn: 50 },
    rto: { maxDowntimeMs: 60_000 },
    ...overrides,
  };
}

test('正常切流：滞后可在 RPO 内追平，阶段有序且时间收敛', () => {
  const plan = planFailover(baseInput());

  assert.equal(plan.decision, DECISION.CUTOVER);

  // 阶段顺序：fence 必须先于 promote，路由收敛后才开始服务
  const names = plan.phases.map((p) => p.name);
  assert.deepEqual(names, [
    PHASE.DETECT,
    PHASE.ASSESS,
    PHASE.FENCE_OLD_PRIMARY,
    PHASE.WAIT_CATCHUP,
    PHASE.PROMOTE_REPLICA,
    PHASE.ROUTE_SWITCH,
    PHASE.DRAIN_CLIENTS,
    PHASE.SERVE,
  ]);
  for (let i = 1; i < plan.phases.length; i++) {
    assert.ok(plan.phases[i].startAt >= plan.phases[i - 1].endAt);
  }

  // 追平耗时 = 5 lsn / 0.05 = 100ms；总耗时 = 50 + 100 + 100 + 2000 + 1000
  assert.equal(plan.earliestCutoverAt, 10_000 + 50 + 100 + 100 + 2_000 + 1_000);

  // fence 动作包含写拒绝与凭证撤销
  const actions = plan.fencing.map((f) => f.action);
  assert.ok(actions.includes('FENCE_WRITES'));
  assert.ok(actions.includes('REVOKE_CLIENT_TOKENS'));

  // 滞后完全追平，数据损失上界仅来自评估时刻的滞后快照
  assert.equal(plan.dataLossBound.lagLsn, 5);
  assert.equal(plan.dataLossBound.missingObjects.length, 0);

  // 回切条件与失败分支齐备
  assert.ok(plan.failback.preconditions.length >= 4);
  assert.ok(plan.failureBranches.some((b) => b.condition === 'LATE_CLIENT_WRITE'));
});

test('RPO 不允许：复制永久中断且滞后超 RPO，放弃切换', () => {
  const plan = planFailover(
    baseInput({
      replica: {
        region: 'cn-north',
        appliedLsn: 400,
        appliedAt: 8_000,
        replayRateLsnPerMs: 0.05,
        objects: { a: { version: 1 } },
      },
      replication: { status: 'broken', permanent: true },
    }),
  );

  assert.equal(plan.decision, DECISION.ABORT_RPO);
  assert.equal(plan.earliestCutoverAt, null);
  assert.equal(plan.phases.length, 0);
  assert.equal(plan.dataLossBound.lagLsn, 600);
  assert.ok(
    plan.failureBranches.some(
      (b) => b.condition === 'RPO_EXCEEDED_PERMANENT_REPLICATION_BREAK',
    ),
  );
});

test('RPO 不允许但显式强制切换：给出损失上界并继续', () => {
  const plan = planFailover(
    baseInput({
      replica: {
        region: 'cn-north',
        appliedLsn: 400,
        appliedAt: 8_000,
        replayRateLsnPerMs: 0.05,
        objects: {},
      },
      replication: { status: 'broken', permanent: true },
      allowForcedCutover: true,
      rto: { maxDowntimeMs: 600_000 },
    }),
  );

  assert.equal(plan.decision, DECISION.CUTOVER);
  assert.match(plan.reason, /forced cutover/);
  assert.equal(plan.dataLossBound.lagLsn, 600);
  assert.equal(plan.dataLossBound.missingObjects.length, 2);
});

test('RTO 不足：追平与路由收敛总耗时超预算，放弃切换', () => {
  const plan = planFailover(
    baseInput({
      replica: {
        region: 'cn-north',
        appliedLsn: 100,
        appliedAt: 9_800,
        replayRateLsnPerMs: 0.001, // 900 lsn -> 900_000ms 追平
        objects: { a: { version: 3 }, b: { version: 2 } },
      },
      rpo: { maxLagMs: 500, maxLagLsn: 1_000 },
      rto: { maxDowntimeMs: 30_000 },
    }),
  );

  assert.equal(plan.decision, DECISION.ABORT_RTO);
  assert.ok(plan.earliestCutoverAt > 10_000 + 30_000);
  assert.ok(plan.failureBranches.some((b) => b.condition === 'RTO_EXCEEDED'));
});

test('见证节点失联：禁止自动切换，要求人工确认', () => {
  const plan = planFailover(
    baseInput({ witness: { reachable: false, quorum: false } }),
  );

  assert.equal(plan.decision, DECISION.MANUAL_REQUIRED);
  assert.ok(plan.failureBranches.some((b) => b.condition === 'WITNESS_UNREACHABLE'));
});

test('旧主恢复：必须保持 fenced，双向差异修复完成后才允许回切', () => {
  // 切换完成后：新主（原副本）多了切换期间的新写入，旧主停在故障时刻
  const oldPrimary = {
    fenced: true,
    objects: { a: { version: 3 }, b: { version: 2 } },
  };
  const newPrimary = {
    objects: {
      a: { version: 3 },
      b: { version: 2 },
      c: { version: 1 }, // 切换期间新写入
    },
  };

  const fb = planFailback({
    oldPrimary,
    newPrimary,
    witness: { reachable: true, quorum: true },
  });

  // 对象 c 需要回传旧主，差异未修复前不允许回切
  assert.equal(fb.ready, false);
  assert.ok(fb.blockers.some((b) => b.includes('双向对象差异')));
  assert.ok(fb.repairPlan.some((r) => r.key === 'c' && r.action === 'COPY_MISSING'));

  // 修复完成后允许回切
  const repaired = planFailback({
    oldPrimary: {
      fenced: true,
      objects: { a: { version: 3 }, b: { version: 2 }, c: { version: 1 } },
    },
    newPrimary,
    witness: { reachable: true, quorum: true },
  });
  assert.equal(repaired.ready, true);
  assert.deepEqual(
    repaired.steps.map((s) => s.step),
    ['FENCE_HOLD', 'DEMOTE', 'BIDIRECTIONAL_REPAIR', 'REVERSE_CATCHUP', 'CUTBACK'],
  );

  // 旧主恢复后未保持 fenced：直接阻断
  const unfenced = planFailback({
    oldPrimary: { fenced: false, objects: newPrimary.objects },
    newPrimary,
    witness: { reachable: true, quorum: true },
  });
  assert.equal(unfenced.ready, false);
  assert.ok(unfenced.blockers.some((b) => b.includes('fenced')));
});

test('多对象差异：缺失、版本落后、副本独有分别生成修复动作', () => {
  const diff = diffObjects(
    {
      keep: { version: 5 },
      stale: { version: 4 },
      gone: { version: 1 },
    },
    {
      keep: { version: 5 },
      stale: { version: 2 },
      extra: { version: 1 },
    },
  );

  assert.deepEqual(diff.missingOnReplica, [{ key: 'gone', primaryVersion: 1 }]);
  assert.deepEqual(diff.staleOnReplica, [
    { key: 'stale', primaryVersion: 4, replicaVersion: 2 },
  ]);
  assert.deepEqual(diff.extraOnReplica, [{ key: 'extra', replicaVersion: 1 }]);

  const plan = planFailover(
    baseInput({
      primary: {
        region: 'cn-east',
        lastAckWrite: { lsn: 1_000, at: 9_900 },
        objects: { keep: { version: 5 }, stale: { version: 4 }, gone: { version: 1 } },
      },
      replica: {
        region: 'cn-north',
        appliedLsn: 995,
        appliedAt: 9_880,
        replayRateLsnPerMs: 0.05,
        objects: { keep: { version: 5 }, stale: { version: 2 }, extra: { version: 1 } },
      },
    }),
  );

  assert.equal(plan.decision, DECISION.CUTOVER);
  const repair = plan.failback.repairPlan;
  assert.ok(repair.some((r) => r.key === 'gone' && r.action === 'COPY_MISSING'));
  assert.ok(repair.some((r) => r.key === 'stale' && r.action === 'REPLAY_DELTA'));
  assert.ok(repair.some((r) => r.key === 'extra' && r.action === 'COPY_BACK'));
  assert.equal(plan.dataLossBound.missingObjects.length, 1);
  assert.equal(plan.dataLossBound.staleObjects.length, 1);
});
