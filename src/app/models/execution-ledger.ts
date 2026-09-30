import {
  ApprovalRecord,
  ChangeRequest,
  ChangeStatus,
  ChangeStep,
  CheckpointEntry,
  DeviationRecord,
  ExecutionFrozenPlan,
  ExecutionLedger,
  RedoItem,
  TerminalResult,
} from './change-request.model';

/** 步骤上报幂等键：同一目标状态的重复上报只记一次 */
export function buildStepDedupeKey(stepId: string, completed: boolean): string {
  return `step:${stepId}:${completed ? 'on' : 'off'}`;
}

export function buildDeviationDedupeKey(deviationId: string): string {
  return `deviation:${deviationId}`;
}

export function buildTerminalDedupeKey(result: TerminalResult): string {
  return `terminal:${result}`;
}

export const EXECUTION_START_KEY = 'execution:start';

/** 开始执行时冻结方案步骤、会签结论与回滚步骤 */
export function createFrozenPlan(
  change: ChangeRequest,
  frozenAt: string,
): ExecutionFrozenPlan {
  return {
    frozenAt,
    steps: change.steps.map((step) => ({ ...step })),
    approvals: change.approvals.map((approval) => ({ ...approval })),
    rollbackSteps: change.steps
      .filter((step) => step.phase === 'rollback')
      .map((step) => ({ ...step })),
    planStepCount: change.steps.length,
  };
}

export function nextSeq(ledger: ExecutionLedger): number {
  return ledger.entries.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1;
}

export function findEntry(
  ledger: ExecutionLedger,
  dedupeKey: string,
): CheckpointEntry | undefined {
  return ledger.entries.find((entry) => entry.dedupeKey === dedupeKey);
}

export interface ProjectedExecution {
  status: ChangeStatus;
  steps: ChangeStep[];
  deviations: DeviationRecord[];
  terminal?: CheckpointEntry;
}

/**
 * 由冻结方案 + 检查点账本重放执行视图。
 * 步骤、偏离和终态全部可从账本完整重建，写入中断截断后据此恢复。
 */
export function projectLedger(change: ChangeRequest): ProjectedExecution | null {
  const ledger = change.ledger;
  if (!ledger) {
    return null;
  }

  const steps = ledger.frozen.steps.map((step) => ({ ...step }));
  const stepMap = new Map(steps.map((step) => [step.id, step]));
  const deviations: DeviationRecord[] = [];
  let terminal: CheckpointEntry | undefined;

  for (const entry of [...ledger.entries].sort((a, b) => a.seq - b.seq)) {
    if (entry.kind === 'freeze') {
      continue;
    }
    if (entry.kind === 'step' && entry.stepId) {
      const step = stepMap.get(entry.stepId);
      if (step) {
        step.completed = Boolean(entry.completed);
        step.completedAt = entry.completed ? entry.recordedAt : undefined;
      }
    } else if (entry.kind === 'deviation' && entry.deviation) {
      deviations.unshift(entry.deviation);
    } else if (entry.kind === 'terminal') {
      terminal = entry;
    }
  }

  return {
    status: terminal?.terminal ? terminal.terminal : 'executing',
    steps,
    deviations,
    terminal,
  };
}

/** 把账本投影结果应用回变更单（步骤、偏离、状态保持与账本一致） */
export function materializeLedger(change: ChangeRequest): ChangeRequest {
  const projected = projectLedger(change);
  if (!projected) {
    return change;
  }
  return {
    ...change,
    status: projected.status,
    steps: projected.steps,
    deviations: projected.deviations,
  };
}

/** 待重做检查点的可读说明，用于工作台和详情提示 */
export function describeRedoKey(dedupeKey: string): string {
  const [kind, id, flag] = dedupeKey.split(':');
  if (kind === 'step') {
    return `步骤勾选：${id}（${flag === 'on' ? '标记完成' : '取消完成'}）`;
  }
  if (kind === 'deviation') {
    return `执行偏离记录：${id}`;
  }
  if (kind === 'terminal') {
    return id === 'completed' ? '完成提交' : '回滚提交';
  }
  if (kind === 'execution') {
    return '开始执行（冻结方案）';
  }
  return dedupeKey;
}

export function toRedoItem(dedupeKey: string): RedoItem {
  return { dedupeKey, label: describeRedoKey(dedupeKey) };
}

/**
 * 载入数据后修复：只保留已确认持久化（seq <= lastPersistedSeq）的检查点，
 * 更晚的检查点视为写入中断丢失，登记为待重做项。
 */
export function repairLedgerAfterLoad(change: ChangeRequest): ChangeRequest {
  const ledger = change.ledger;
  if (!ledger) {
    return change;
  }

  // 冻结建账条目始终保留，即使其落盘回执在中断中丢失
  const confirmed = [...ledger.entries]
    .filter((entry) => entry.seq <= ledger.lastPersistedSeq || entry.kind === 'freeze')
    .sort((a, b) => a.seq - b.seq);
  const lost = ledger.entries.filter(
    (entry) => entry.seq > ledger.lastPersistedSeq && entry.kind !== 'freeze',
  );

  let repaired: ChangeRequest = change;
  if (lost.length > 0) {
    const pendingRedo: RedoItem[] = lost.map((entry) => toRedoItem(entry.dedupeKey));
    repaired = {
      ...change,
      ledger: {
        ...ledger,
        entries: confirmed,
        recovery: {
          restoredAt: new Date().toISOString(),
          restoredSeq: ledger.lastPersistedSeq,
          message: '检测到上次会话在检查点写入过程中中断，已恢复到最后完整检查点。',
          pendingRedo,
        },
      },
    };
  }

  return repaired.ledger ? materializeLedger(repaired) : repaired;
}

/** 冻结会签副本（保留签署结论，状态标记为冻结） */
export function frozenApprovals(approvals: ApprovalRecord[]): ApprovalRecord[] {
  return approvals.map((approval) => ({ ...approval, state: 'frozen' as const }));
}

/**
 * 兼容旧数据：无账本的“执行中/已完成/已回滚”记录，
 * 用当前步骤与偏离重建一份账本（视为全部已持久化）。
 */
export function migrateLegacyLedger(change: ChangeRequest): ChangeRequest {
  if (change.ledger || !['executing', 'completed', 'rolled_back'].includes(change.status)) {
    return change;
  }

  const nowIso = new Date().toISOString();
  const entries: CheckpointEntry[] = [
    {
      dedupeKey: EXECUTION_START_KEY,
      kind: 'freeze',
      seq: 1,
      recordedAt: change.updatedAt,
      actor: '历史数据',
    },
  ];
  let seq = 1;

  for (const step of change.steps) {
    if (step.completed) {
      seq += 1;
      entries.push({
        dedupeKey: buildStepDedupeKey(step.id, true),
        kind: 'step',
        seq,
        recordedAt: step.completedAt ?? nowIso,
        stepId: step.id,
        completed: true,
        actor: step.owner || '历史数据',
      });
    }
  }

  for (const deviation of change.deviations) {
    seq += 1;
    entries.push({
      dedupeKey: buildDeviationDedupeKey(deviation.id),
      kind: 'deviation',
      seq,
      recordedAt: deviation.recordedAt,
      deviation,
      actor: deviation.owner,
    });
  }

  if (change.status === 'completed' || change.status === 'rolled_back') {
    seq += 1;
    const terminal = change.status === 'completed' ? 'completed' : 'rolled_back';
    entries.push({
      dedupeKey: buildTerminalDedupeKey(terminal),
      kind: 'terminal',
      seq,
      recordedAt: change.updatedAt,
      terminal,
      note: '历史终态（账本迁移补录）',
      actor: '历史数据',
    });
  }

  const ledger: ExecutionLedger = {
    frozen: createFrozenPlan(change, change.updatedAt),
    entries,
    conflicts: [],
    lastPersistedSeq: seq,
  };

  return { ...change, ledger };
}
