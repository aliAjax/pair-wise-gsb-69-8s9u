import { createReducer, on } from '@ngrx/store';
import {
  ApprovalStage,
  ChangeRequest,
  APPROVAL_ORDER,
  createAudit,
} from '../models/change-request.model';
import {
  ExecutionEntry,
  ExecutionEntryType,
  ExecutionLedger,
  ExecutionRedoPayload,
  buildFrozenPlan,
  describeTerminalConflict,
  foldLedger,
  ledgerAudit,
  nextEntrySeq,
} from '../models/execution-ledger.model';
import { ChangeRequestActions } from './change-request.actions';

export interface ChangeRequestState {
  changes: ChangeRequest[];
  loading: boolean;
  error: string | null;
  /** 写入中断后等待重做的检查点条目（同时持久化在独立存储中） */
  redoQueue: ExecutionRedoPayload[];
}

export const initialChangeRequestState: ChangeRequestState = {
  changes: [],
  loading: false,
  error: null,
  redoQueue: [],
};

function touch(change: ChangeRequest): ChangeRequest {
  return { ...change, updatedAt: new Date().toISOString() };
}

function nextPendingStage(change: ChangeRequest): ApprovalStage | null {
  return APPROVAL_ORDER.find((stage) =>
    change.approvals.some((approval) => approval.stage === stage && approval.state === 'pending'),
  ) ?? null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function withLedger(change: ChangeRequest, ledger: ExecutionLedger): ChangeRequest {
  const view = foldLedger(ledger);
  return touch({
    ...change,
    status: view.terminal ?? (view.executing ? 'executing' : change.status),
    steps: change.steps.map((step) =>
      view.completedStepIds.has(step.id) && !step.completed
        ? { ...step, completed: true, completedAt: ledger.lastCommittedAt }
        : step,
    ),
    deviations: view.deviations,
    executionLedger: ledger,
  });
}

/** 向账本追加一个检查点条目；重复 token 只记一次，终态冲突留痕 */
function appendEntry(
  change: ChangeRequest,
  seed: Omit<ExecutionEntry, 'seq' | 'state' | 'occurredAt' | 'updatedAt'>,
  frozenPlanForStart?: ExecutionLedger['frozenPlan'],
): ChangeRequest {
  const ledger = change.executionLedger;

  // 开始执行必须有账本；其余上报必须已有账本，否则无法按检查点接续
  if (seed.type !== 'start' && !ledger) {
    return change;
  }

  // 同一上报（含重试、晚到重发）只记一次
  if (ledger?.entries.some((entry) => entry.token === seed.token)) {
    return change;
  }

  const occurredAt = nowIso();
  const seq = nextEntrySeq(ledger);
  const entry: ExecutionEntry = {
    ...seed,
    seq,
    state: 'pending',
    occurredAt,
    updatedAt: occurredAt,
  };

  if (seed.type === 'start') {
    const fresh: ExecutionLedger = {
      lastCommittedSeq: 0,
      entries: [entry],
      frozenPlan: frozenPlanForStart ?? buildFrozenPlan(change),
    };
    // 冻结时刻已完成的步骤作为同一起始检查点的事实补记（只记一次，非新上报）
    fresh.frozenPlan.steps
      .filter((step) => step.completed)
      .forEach((step) => {
        fresh.entries.push({
          token: `${seed.token}:precomplete:${step.id}`,
          seq,
          type: 'step',
          state: 'pending',
          occurredAt,
          updatedAt: occurredAt,
          actor: seed.actor,
          stepId: step.id,
          stepTitle: step.title,
          completed: true,
        });
      });
    return touch({
      ...change,
      status: 'executing',
      approvals: change.approvals.map((approval) => ({ ...approval, state: 'frozen' })),
      executionLedger: fresh,
    });
  }

  const currentLedger = ledger!;
  const view = foldLedger(currentLedger);

  // 幂等：相同步骤/偏离/终态事实已确认时，不重复记账
  if (entry.type === 'step' && entry.stepId && entry.completed) {
    if (view.committedStepIds.has(entry.stepId)) {
      return change;
    }
  }

  if (entry.type === 'terminal' && view.terminal) {
    if (entry.result === view.terminal) {
      // 同一终态结论的重复上报只记一次
      return change;
    }
    // 回滚先到、完成晚到（或反之）：留冲突并说明原因，不覆盖先到终态
    entry.state = 'conflict';
    entry.conflictReason = describeTerminalConflict(entry.result!, view.terminal);
  }

  const nextLedger: ExecutionLedger = {
    ...currentLedger,
    entries: [...currentLedger.entries, entry],
  };

  // 终态冲突只追加留痕，状态与审计在检查点落盘确认时统一结算
  return withLedger(change, nextLedger);
}

/** 检查点落盘结果应用：整包快照内所有 pending/conflict 条目统一结算 */
function settleEntries(change: ChangeRequest, committed: boolean): ChangeRequest {
  const ledger = change.executionLedger;
  if (!ledger) {
    return change;
  }
  const unsettled = ledger.entries.filter(
    (entry) => entry.state === 'pending' || entry.state === 'conflict',
  );
  if (unsettled.length === 0) {
    return change;
  }

  // 提交确认前，先找出已落盘的终态，用于给重做后的晚到终态重新归类冲突
  const existingTerminal = ledger.entries.find(
    (entry) =>
      !unsettled.some((item) => item.token === entry.token) &&
      entry.type === 'terminal' &&
      (entry.state === 'committed' || entry.state === 'conflict'),
  );
  const pendingTokens = new Set(
    unsettled.filter((entry) => entry.state === 'pending').map((entry) => entry.token),
  );

  const entries = ledger.entries.map((entry) => {
    if (entry.state !== 'pending' && entry.state !== 'conflict') {
      return entry;
    }
    if (committed) {
      // 重做后重新确认的晚到终态：若已有不同终态先落盘，重新归为冲突
      if (
        entry.type === 'terminal' &&
        existingTerminal?.result &&
        existingTerminal.result !== entry.result
      ) {
        return {
          ...entry,
          state: 'conflict' as const,
          conflictReason: describeTerminalConflict(entry.result!, existingTerminal.result!),
          updatedAt: nowIso(),
        };
      }
      // 已归类的终态冲突保留 conflict 留痕，其余未确认条目确认为 committed
      return entry.state === 'conflict'
        ? { ...entry, updatedAt: nowIso() }
        : { ...entry, state: 'committed' as const, updatedAt: nowIso() };
    }
    // 整包写入失败：未确认（含冲突留痕尚未落盘）条目全部转待重做
    return { ...entry, state: 'needsRedo' as const, updatedAt: nowIso() };
  });

  const settledAt = nowIso();
  const nextLedger: ExecutionLedger = {
    ...ledger,
    entries,
    ...(committed
      ? {
          lastCommittedSeq: entries
            .filter((entry) => entry.state === 'committed' || entry.state === 'conflict')
            .reduce((max, entry) => Math.max(max, entry.seq), ledger.lastCommittedSeq),
          lastCommittedAt: settledAt,
        }
      : {}),
  };

  if (!committed) {
    // 回滚到最后完整检查点：折叠视图后，未确认勾选/偏离/终态自然消失
    const rolledBack = withLedger(change, nextLedger);
    const seqs = [...new Set(unsettled.map((entry) => `#${entry.seq}`))].join('、');
    return {
      ...rolledBack,
      audit: [
        ledgerAudit(
          '检查点写入失败',
          `检查点 ${seqs} 未能落盘，已恢复到最后完整检查点（#${nextLedger.lastCommittedSeq}），待重做项保留。`,
        ),
        ...rolledBack.audit,
      ],
    };
  }

  const newlyCommitted = entries.filter(
    (entry) => pendingTokens.has(entry.token) && entry.state === 'committed',
  );
  const confirmed = withLedger(change, nextLedger);
  const audits = newlyCommitted.flatMap((entry): ReturnType<typeof ledgerAudit>[] => {
    if (entry.type === 'start') {
      return [ledgerAudit('检查点确认', `开始执行检查点 #${entry.seq} 已落盘，方案与会签已冻结`, entry.actor)];
    }
    if (entry.type === 'step') {
      return [ledgerAudit('检查点确认', `步骤“${entry.stepTitle}”勾选已落盘（检查点 #${entry.seq}）`, entry.actor)];
    }
    if (entry.type === 'deviation') {
      return [ledgerAudit('检查点确认', `偏离记录已落盘（检查点 #${entry.seq}）`, entry.actor)];
    }
    if (entry.type === 'terminal') {
      return [
        ledgerAudit(
          entry.result === 'rolled_back' ? '执行回滚' : '执行完成',
          `${entry.note}（终态检查点 #${entry.seq} 已落盘）`,
          entry.actor,
        ),
      ];
    }
    return [];
  });

  // 本次新落盘的冲突留痕补一条审计
  const conflicts = entries.filter(
    (entry) => pendingTokens.has(entry.token) && entry.state === 'conflict',
  );
  for (const entry of conflicts) {
    audits.push(
      ledgerAudit('终态冲突留痕', entry.conflictReason ?? '晚到终态与先到终态冲突。', entry.actor),
    );
  }

  return audits.length
    ? { ...confirmed, audit: [...audits, ...confirmed.audit] }
    : confirmed;
}

/** 把重做队列中的未确认条目接回账本（页面重载或重试时） */
function mergeRedo(change: ChangeRequest, entry: ExecutionEntry): ChangeRequest {
  const ledger = change.executionLedger;
  if (!ledger) {
    return change;
  }
  if (ledger.entries.some((item) => item.token === entry.token)) {
    return change;
  }
  // 接续到当前账本序号之后，保持同一追加链
  const replayed: ExecutionEntry = {
    ...entry,
    seq: nextEntrySeq(ledger),
    state: 'needsRedo',
    updatedAt: nowIso(),
  };
  const nextLedger: ExecutionLedger = {
    ...ledger,
    entries: [...ledger.entries, replayed],
  };
  const result = withLedger(change, nextLedger);
  return {
    ...result,
    audit: [
      ledgerAudit(
        '恢复待重做检查点',
        `写入中断的${entryTypeText(replayed.type)}检查点已恢复，请值班员确认重做（#${replayed.seq}）。`,
        replayed.actor,
      ),
      ...result.audit,
    ],
  };
}

function entryTypeText(type: ExecutionEntryType): string {
  return (
    { start: '开始执行', step: '步骤勾选', deviation: '偏离记录', terminal: '终态判定' } as const
  )[type];
}

export const changeRequestReducer = createReducer(
  initialChangeRequestState,
  on(ChangeRequestActions.loadChanges, (state) => ({ ...state, loading: true, error: null })),
  on(ChangeRequestActions.loadChangesSuccess, (state, { changes, redo }) => {
    // 将独立存储中的待重做条目接回对应变更；start 之外的孤儿条目直接丢弃
    const validTokens = new Set<string>();
    const merged = changes.map((change) => {
      let current = change;
      for (const item of redo) {
        if (item.changeId !== change.id) {
          continue;
        }
        if (item.entry.type === 'start' && !current.executionLedger) {
          const ledger: ExecutionLedger = {
            lastCommittedSeq: 0,
            entries: [],
            frozenPlan: item.frozenPlan ?? buildFrozenPlan(change),
          };
          current = { ...current, executionLedger: ledger };
          // 账本尚未建立的 start 也是有效待重做项，必须保留在队列中
          validTokens.add(item.entry.token);
        }
        if (current.executionLedger) {
          const before = current.executionLedger.entries.length;
          current = mergeRedo(current, item.entry);
          if (current.executionLedger!.entries.length > before) {
            validTokens.add(item.entry.token);
          }
        }
      }
      return current;
    });

    return {
      ...state,
      changes: merged,
      redoQueue: redo.filter((item) => validTokens.has(item.entry.token)),
      loading: false,
    };
  }),
  on(ChangeRequestActions.loadChangesFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),
  on(ChangeRequestActions.createChange, (state, { change }) => ({
    ...state,
    changes: [
      {
        ...change,
        audit: [createAudit('创建草稿', `创建变更 ${change.id}`), ...change.audit],
      },
      ...state.changes,
    ],
  })),
  on(ChangeRequestActions.updateChange, (state, { change }) => {
    const existing = state.changes.find((item) => item.id === change.id);
    // 执行开始后方案已冻结，编辑保存不得覆盖冻结快照
    if (existing?.executionLedger) {
      return state;
    }
    return {
      ...state,
      changes: state.changes.map((item) =>
        item.id === change.id
          ? touch({
              ...change,
              audit: [
                createAudit('保存变更方案', '更新资源、步骤或窗口信息'),
                ...change.audit,
              ],
            })
          : item,
      ),
    };
  }),
  on(ChangeRequestActions.deleteDraft, (state, { id }) => ({
    ...state,
    changes: state.changes.filter((change) => change.id !== id || change.status !== 'draft'),
  })),
  on(ChangeRequestActions.submitForReview, (state, { id }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id && ['draft', 'rejected'].includes(change.status)
        ? touch({
            ...change,
            status: 'submitted',
            approvals: change.approvals.map((approval) =>
              approval.stage === 'network'
                ? { ...approval, state: 'pending' }
                : { ...approval, state: 'pending' },
            ),
            audit: [createAudit('提交审批', '方案冻结后进入网络、系统、安全、业务顺序会签'), ...change.audit],
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.approveStage, (state, { id, stage, approver, comment }) => ({
    ...state,
    changes: state.changes.map((change) => {
      if (change.id !== id || nextPendingStage(change) !== stage) {
        return change;
      }

      const approvals = change.approvals.map((approval) =>
        approval.stage === stage
          ? {
              ...approval,
              state: 'approved' as const,
              approver,
              comment,
              decidedAt: new Date().toISOString(),
            }
          : approval,
      );
      const allApproved = approvals.every((approval) =>
        approval.stage === stage ? true : approval.state === 'approved',
      );

      return touch({
        ...change,
        status: allApproved ? 'approved' : 'submitted',
        approvals,
        audit: [createAudit('阶段会签', `${stage} 已由 ${approver} 批准：${comment}`), ...change.audit],
      });
    }),
  })),
  on(ChangeRequestActions.rejectStage, (state, { id, stage, approver, comment }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id
        ? touch({
            ...change,
            status: 'rejected',
            approvals: change.approvals.map((approval) =>
              approval.stage === stage
                ? {
                    ...approval,
                    state: 'rejected',
                    approver,
                    comment,
                    decidedAt: new Date().toISOString(),
                  }
                : approval,
            ),
            audit: [createAudit('审批退回', `${stage} 由 ${approver} 退回：${comment}`), ...change.audit],
          })
        : change,
    ),
  })),

  // ── 执行检查点账本 ─────────────────────────────────────────────
  on(ChangeRequestActions.startExecutionReport, (state, { id, token, actor, frozenPlan }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id && change.status === 'approved'
        ? appendEntry(
            change,
            { token, type: 'start', actor },
            frozenPlan,
          )
        : change,
    ),
  })),
  on(ChangeRequestActions.reportStep, (state, { id, token, stepId, stepTitle, completed, actor }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id
        ? appendEntry(change, { token, type: 'step', actor, stepId, stepTitle, completed })
        : change,
    ),
  })),
  on(ChangeRequestActions.recordDeviationReport, (state, { id, token, deviation }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id
        ? appendEntry(change, {
            token,
            type: 'deviation',
            actor: deviation.owner,
            deviation,
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.reportTerminal, (state, { id, token, result, note, actor }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id
        ? appendEntry(change, { token, type: 'terminal', actor, result, note })
        : change,
    ),
  })),

  on(ChangeRequestActions.checkpointCommitted, (state) => {
    const changes = state.changes.map((change) => settleEntries(change, true));
    // 仅移除已接回账本且不再处于待重做的队列项，保留其他检查点的待重做条目
    const liveTokens = new Set<string>();
    for (const change of changes) {
      for (const entry of change.executionLedger?.entries ?? []) {
        if (entry.state === 'needsRedo') {
          liveTokens.add(entry.token);
        }
      }
    }
    return {
      ...state,
      changes,
      redoQueue: state.redoQueue.filter((item) => liveTokens.has(item.entry.token)),
    };
  }),
  on(ChangeRequestActions.checkpointFailed, (state) => {
    const additions: ExecutionRedoPayload[] = [];
    const queuedTokens = new Set(state.redoQueue.map((item) => item.entry.token));
    const changes = state.changes.map((change) => {
      const ledger = change.executionLedger;
      if (!ledger) {
        return change;
      }
      for (const entry of ledger.entries) {
        if (
          (entry.state === 'pending' || entry.state === 'conflict') &&
          !queuedTokens.has(entry.token)
        ) {
          additions.push({
            changeId: change.id,
            entry: { ...entry, state: 'needsRedo', updatedAt: nowIso() },
            ...(entry.type === 'start' ? { frozenPlan: ledger.frozenPlan } : {}),
          });
          queuedTokens.add(entry.token);
        }
      }
      return settleEntries(change, false);
    });
    return {
      ...state,
      changes,
      redoQueue: [...state.redoQueue, ...additions],
    };
  }),

  on(ChangeRequestActions.retryRedo, (state, { payload }) => {
    const targetToken = payload.entry.token;
    return {
      ...state,
      changes: state.changes.map((change) => {
        if (change.id !== payload.changeId) {
          return change;
        }
        const ledger = change.executionLedger;
        if (!ledger) {
          return change;
        }
        const entries = ledger.entries.map((entry) =>
          entry.token === targetToken && entry.state === 'needsRedo'
            ? { ...entry, state: 'pending' as const, updatedAt: nowIso() }
            : entry,
        );
        return withLedger(change, { ...ledger, entries });
      }),
    };
  }),
  on(ChangeRequestActions.discardRedo, (state, { token }) => {
    const target =
      state.redoQueue.find((item) => item.entry.token === token) ??
      state.changes
        .flatMap((change) =>
          (change.executionLedger?.entries ?? [])
            .filter((entry) => entry.token === token)
            .map((entry) => ({ changeId: change.id, entry })),
        )
        .find((item) => item.entry.state === 'needsRedo');
    const changes = target
      ? state.changes.map((change) => {
          if (change.id !== target.changeId || !change.executionLedger) {
            return change;
          }
          const ledger = change.executionLedger;
          const entries = ledger.entries.map((entry) =>
            entry.token === token && entry.state === 'needsRedo'
              ? { ...entry, state: 'duplicate' as const, updatedAt: nowIso() }
              : entry,
          );
          const next = withLedger(change, { ...ledger, entries });
          return {
            ...next,
            audit: [
              ledgerAudit('放弃待重做检查点', '值班员确认放弃该未确认上报，回滚到最后完整检查点。'),
              ...next.audit,
            ],
          };
        })
      : state.changes;
    return {
      ...state,
      changes,
      redoQueue: state.redoQueue.filter((item) => item.entry.token !== token),
    };
  }),
);
