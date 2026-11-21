'use strict';

/**
 * 跨地域存储切换规划器。
 *
 * 输入两地复制位置、最近确认写入、对象版本、见证节点、DNS/路由传播时间、
 * RPO/RTO 与客户端重试窗口，计算可安全切换的最早时间，并输出切换阶段、
 * 数据损失上界、fencing 动作、回切条件与失败分支。
 *
 * 所有存储与 DNS 操作均为本地模拟，不触碰真实基础设施。
 */

const PHASE = {
  DETECT: 'DETECT',
  ASSESS: 'ASSESS',
  FENCE_OLD_PRIMARY: 'FENCE_OLD_PRIMARY',
  WAIT_CATCHUP: 'WAIT_CATCHUP',
  PROMOTE_REPLICA: 'PROMOTE_REPLICA',
  ROUTE_SWITCH: 'ROUTE_SWITCH',
  DRAIN_CLIENTS: 'DRAIN_CLIENTS',
  SERVE: 'SERVE',
};

const DECISION = {
  CUTOVER: 'CUTOVER',
  ABORT_RPO: 'ABORT_RPO',
  ABORT_RTO: 'ABORT_RTO',
  MANUAL_REQUIRED: 'MANUAL_REQUIRED',
};

function diffObjects(primaryObjects, replicaObjects) {
  const missingOnReplica = [];
  const staleOnReplica = [];
  const extraOnReplica = [];
  for (const [key, meta] of Object.entries(primaryObjects || {})) {
    const replicaMeta = (replicaObjects || {})[key];
    if (!replicaMeta) {
      missingOnReplica.push({ key, primaryVersion: meta.version });
    } else if (replicaMeta.version < meta.version) {
      staleOnReplica.push({
        key,
        primaryVersion: meta.version,
        replicaVersion: replicaMeta.version,
      });
    }
  }
  for (const [key, meta] of Object.entries(replicaObjects || {})) {
    if (!(primaryObjects || {})[key]) {
      extraOnReplica.push({ key, replicaVersion: meta.version });
    }
  }
  return { missingOnReplica, staleOnReplica, extraOnReplica };
}

/**
 * 计算复制滞后。
 * lagLsn: 主已确认但副本未应用的日志量。
 * lagMs:  副本最后应用时间与主最后确认写入时间之差。
 */
function computeLag(input) {
  const { primary, replica } = input;
  const lagLsn = Math.max(0, primary.lastAckWrite.lsn - replica.appliedLsn);
  const lagMs = Math.max(0, primary.lastAckWrite.at - replica.appliedAt);
  return { lagLsn, lagMs };
}

/**
 * 生成切换计划。
 *
 * @param {object} input
 * @param {number} input.now                       当前时刻 (ms，相对时间轴)
 * @param {object} input.primary                   旧主地域状态
 * @param {object} input.primary.lastAckWrite      { lsn, at } 最近确认写入
 * @param {object} input.primary.objects           { key: { version } }
 * @param {object} input.replica                   异地副本状态
 * @param {number} input.replica.appliedLsn        已应用日志位点
 * @param {number} input.replica.appliedAt         已应用位点对应的主侧时间
 * @param {number} input.replica.replayRateLsnPerMs 追平速率
 * @param {object} input.replication               { status: 'healthy'|'broken', permanent?: bool }
 * @param {object} input.witness                   { reachable: bool, quorum: bool }
 * @param {object} input.dns                       { propagationMs }
 * @param {object} input.client                    { retryWindowMs }
 * @param {object} input.rpo                       { maxLagMs, maxLagLsn }
 * @param {object} input.rto                       { maxDowntimeMs }
 * @param {number} [input.fenceMs]                 fence 动作耗时（模拟）
 * @param {number} [input.promoteMs]               提升副本耗时（模拟）
 * @param {boolean} [input.allowForcedCutover]     RPO 超标时是否允许强制切换
 */
function planFailover(input) {
  const fenceMs = input.fenceMs ?? 50;
  const promoteMs = input.promoteMs ?? 100;
  const now = input.now;
  const lag = computeLag(input);
  const objectDiff = diffObjects(input.primary.objects, input.replica.objects);
  const replicationBroken = input.replication.status === 'broken';
  const replicationPermanent = replicationBroken && input.replication.permanent === true;

  const dataLossBound = {
    lagMs: lag.lagMs,
    lagLsn: lag.lagLsn,
    missingObjects: objectDiff.missingOnReplica,
    staleObjects: objectDiff.staleOnReplica,
  };

  const failureBranches = [];
  const fencing = [];
  const phases = [];

  // ---- 见证节点检查 ----
  if (!input.witness.reachable || !input.witness.quorum) {
    failureBranches.push({
      condition: 'WITNESS_UNREACHABLE',
      branch: DECISION.MANUAL_REQUIRED,
      action:
        '见证节点失联或失去法定人数：无法自动确认旧主已下线，' +
        '禁止自动切换，需人工确认旧主确实不可写后再执行 fence。',
    });
    return {
      decision: DECISION.MANUAL_REQUIRED,
      reason: 'witness unreachable or quorum lost',
      earliestCutoverAt: null,
      phases: [],
      dataLossBound,
      fencing,
      failback: null,
      failureBranches,
    };
  }

  // ---- 追平时间估算 ----
  // fence 旧主后不再有新写入，滞后固定；健康复制按 replayRate 追平。
  const replayRate = input.replica.replayRateLsnPerMs;
  const catchUpMs = lag.lagLsn / Math.max(replayRate, 1e-9);

  // 切换完成 = fence + 追平 + 提升 + DNS 传播 + 客户端重试窗口耗尽
  const routeSettleMs = input.dns.propagationMs + input.client.retryWindowMs;
  const totalMs = fenceMs + catchUpMs + promoteMs + routeSettleMs;
  const earliestCutoverAt = now + totalMs;

  // ---- RPO 判定 ----
  const rpoExceeded =
    lag.lagMs > input.rpo.maxLagMs || lag.lagLsn > input.rpo.maxLagLsn;
  const canMeetRpo = !replicationPermanent; // 永久中断时滞后永远无法追平

  if (rpoExceeded && !canMeetRpo && !input.allowForcedCutover) {
    failureBranches.push({
      condition: 'RPO_EXCEEDED_PERMANENT_REPLICATION_BREAK',
      branch: DECISION.ABORT_RPO,
      action:
        '复制永久中断且当前滞后超过 RPO：切换将造成不可接受的数据损失。' +
        '保持旧主不可写并等待复制修复，或显式 allowForcedCutover 接受损失上界。',
    });
    return {
      decision: DECISION.ABORT_RPO,
      reason: 'replication permanently broken and lag exceeds RPO',
      earliestCutoverAt: null,
      phases: [],
      dataLossBound,
      fencing,
      failback: null,
      failureBranches,
    };
  }

  // ---- RTO 判定 ----
  if (totalMs > input.rto.maxDowntimeMs) {
    failureBranches.push({
      condition: 'RTO_EXCEEDED',
      branch: DECISION.ABORT_RTO,
      action:
        'fence + 追平 + 提升 + 路由收敛总耗时超过 RTO：' +
        '考虑放宽 RPO（跳过完全追平）、预热副本或缩短 DNS TTL 后重试。',
    });
    return {
      decision: DECISION.ABORT_RTO,
      reason: 'projected cutover time exceeds RTO budget',
      earliestCutoverAt,
      phases: [],
      dataLossBound,
      fencing,
      failback: null,
      failureBranches,
    };
  }

  // ---- 构造切换阶段 ----
  let cursor = now;
  const pushPhase = (name, durationMs, actions) => {
    const startAt = cursor;
    const endAt = cursor + durationMs;
    phases.push({ name, startAt, endAt, actions });
    cursor = endAt;
  };

  pushPhase(PHASE.DETECT, 0, [
    '确认主地域故障，见证节点达成法定人数，允许自动切换',
  ]);
  pushPhase(PHASE.ASSESS, 0, [
    `复制滞后 lagLsn=${lag.lagLsn} lagMs=${lag.lagMs}`,
    `对象差异: 缺失 ${objectDiff.missingOnReplica.length} 个, 版本落后 ${objectDiff.staleOnReplica.length} 个`,
  ]);

  fencing.push({
    action: 'FENCE_WRITES',
    target: 'primary',
    reason: '阻止旧主恢复后继续接受写入（存储层拒绝 + 撤销客户端凭证）',
  });
  fencing.push({
    action: 'REVOKE_CLIENT_TOKENS',
    target: 'primary',
    reason: '使晚到的旧路由写入在旧主上被拒绝',
  });
  pushPhase(PHASE.FENCE_OLD_PRIMARY, fenceMs, [
    '存储层 fence 旧主：拒绝一切新写入',
    '撤销旧主客户端写入凭证',
  ]);

  if (catchUpMs > 0 && canMeetRpo) {
    pushPhase(PHASE.WAIT_CATCHUP, catchUpMs, [
      `等待副本追平至 lsn=${input.primary.lastAckWrite.lsn}`,
    ]);
  } else if (!canMeetRpo && lag.lagLsn > 0) {
    pushPhase(PHASE.WAIT_CATCHUP, 0, [
      '复制永久中断，无法追平；按强制切换接受数据损失上界',
    ]);
  }

  pushPhase(PHASE.PROMOTE_REPLICA, promoteMs, [
    '提升异地副本为新主，冻结其复制消费位点',
  ]);
  pushPhase(PHASE.ROUTE_SWITCH, input.dns.propagationMs, [
    `切换 DNS/路由，等待传播 ${input.dns.propagationMs}ms`,
  ]);
  pushPhase(PHASE.DRAIN_CLIENTS, input.client.retryWindowMs, [
    `等待客户端重试窗口 ${input.client.retryWindowMs}ms 耗尽，` +
      '期间旧路由晚到写入一律被 fence 拒绝并重定向',
  ]);
  pushPhase(PHASE.SERVE, 0, ['新主正式对外服务']);

  // ---- 失败分支（切换过程中仍可能发生） ----
  failureBranches.push({
    condition: 'REPLICATION_BREAKS_DURING_CATCHUP',
    branch: 'FORCED_OR_ABORT',
    action:
      '追平期间复制中断：若剩余滞后仍满足 RPO 则继续；' +
      '否则按 allowForcedCutover 决定强制切换或回退计划。',
  });
  failureBranches.push({
    condition: 'FENCE_UNCONFIRMED',
    branch: 'HALT',
    action: 'fence 未获存储层确认前禁止提升副本，防止双主写入。',
  });
  failureBranches.push({
    condition: 'LATE_CLIENT_WRITE',
    branch: 'REJECT_AND_REDIRECT',
    action:
      'DNS 传播 + 重试窗口内晚到的旧路由写入：旧主已 fence 拒绝，' +
      '客户端按重试窗口重试并被导向新主。',
  });

  // ---- 回切条件 ----
  const failback = {
    preconditions: [
      '旧主保持 fenced，直到完成角色降级（降为副本）',
      '建立新主 -> 旧主的反向复制并追平',
      '完成双向差异修复：双向对象 diff 均为空',
      '见证节点恢复可达且达成法定人数',
      '再次通过 RPO/RTO 评估后方可回切',
    ],
    repairPlan: buildRepairPlan(objectDiff),
  };

  return {
    decision: DECISION.CUTOVER,
    reason: rpoExceeded
      ? 'forced cutover accepted within data loss bound'
      : 'lag within RPO and projected downtime within RTO',
    earliestCutoverAt,
    phases,
    dataLossBound,
    fencing,
    failback,
    failureBranches,
  };
}

/**
 * 双向差异修复计划：切换后新主可能收到旧主没有的新写入，
 * 回切前需双向对齐。
 */
function buildRepairPlan(diff) {
  const plan = [];
  for (const item of diff.missingOnReplica) {
    plan.push({
      key: item.key,
      direction: 'primary->replica',
      action: 'COPY_MISSING',
      detail: `对象在副本缺失，从主侧版本 v${item.primaryVersion} 全量复制`,
    });
  }
  for (const item of diff.staleOnReplica) {
    plan.push({
      key: item.key,
      direction: 'primary->replica',
      action: 'REPLAY_DELTA',
      detail: `副本版本 v${item.replicaVersion} 落后主侧 v${item.primaryVersion}，回放差异版本`,
    });
  }
  for (const item of diff.extraOnReplica) {
    plan.push({
      key: item.key,
      direction: 'replica->primary',
      action: 'COPY_BACK',
      detail: '对象仅存在于副本（切换期间新写入），回传旧主',
    });
  }
  return plan;
}

/**
 * 旧主恢复后的回切规划。
 *
 * @param {object} input
 * @param {object} input.oldPrimary  恢复后的旧主（必须仍处于 fenced 状态）
 * @param {object} input.newPrimary  当前服务的新主（原副本）
 * @param {object} input.witness
 */
function planFailback(input) {
  const { oldPrimary, newPrimary, witness } = input;
  const steps = [];
  const blockers = [];

  if (!oldPrimary.fenced) {
    blockers.push(
      '旧主恢复后未保持 fenced：存在双主写入风险，必须先 fence 再降级',
    );
  }
  if (!witness.reachable || !witness.quorum) {
    blockers.push('见证节点不可达：回切前必须恢复仲裁能力');
  }

  steps.push({
    step: 'FENCE_HOLD',
    detail: '确认旧主 fenced，拒绝任何直接写入',
  });
  steps.push({
    step: 'DEMOTE',
    detail: '旧主降级为副本，建立新主 -> 旧主反向复制',
  });

  const forwardDiff = diffObjects(newPrimary.objects, oldPrimary.objects);
  const reverseDiff = diffObjects(oldPrimary.objects, newPrimary.objects);
  const repairPlan = [
    ...buildRepairPlan(forwardDiff),
    ...buildRepairPlan(reverseDiff).map((item) => ({
      ...item,
      direction: 'oldPrimary->newPrimary',
    })),
  ];

  steps.push({
    step: 'BIDIRECTIONAL_REPAIR',
    detail: `双向差异修复：${repairPlan.length} 个对象待对齐`,
    repairPlan,
  });

  const diffsEmpty =
    forwardDiff.missingOnReplica.length === 0 &&
    forwardDiff.staleOnReplica.length === 0 &&
    reverseDiff.missingOnReplica.length === 0 &&
    reverseDiff.staleOnReplica.length === 0;

  if (!diffsEmpty) {
    blockers.push('双向对象差异未修复完成，禁止回切');
  }

  steps.push({
    step: 'REVERSE_CATCHUP',
    detail: '反向复制追平至新主最新确认位点，满足 RPO 后冻结新主写入',
  });
  steps.push({
    step: 'CUTBACK',
    detail: 'fence 新主 -> 提升旧主 -> 切回 DNS/路由 -> 等待传播与重试窗口',
  });

  return {
    ready: blockers.length === 0,
    blockers,
    steps,
    repairPlan,
  };
}

module.exports = {
  PHASE,
  DECISION,
  planFailover,
  planFailback,
  diffObjects,
  computeLag,
  buildRepairPlan,
};
