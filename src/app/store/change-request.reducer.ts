import { createReducer, on } from '@ngrx/store';
import {
  ApprovalStage,
  ChangeRequest,
  APPROVAL_ORDER,
  createAudit,
  ExecutionLedger,
  TerminalConflict,
} from '../models/change-request.model';
import {
  buildDeviationDedupeKey,
  createFrozenPlan,
  EXECUTION_START_KEY,
  frozenApprovals,
  materializeLedger,
  nextSeq,
  projectLedger,
  toRedoItem,
} from '../models/execution-ledger';
import { ChangeRequestActions } from './change-request.actions';

export interface ChangeRequestState {
  changes: ChangeRequest[];
  loading: boolean;
  error: string | null;
}

export const initialChangeRequestState: ChangeRequestState = {
  changes: [],
  loading: false,
  error: null,
};

function touch(change: ChangeRequest): ChangeRequest {
  return { ...change, updatedAt: new Date().toISOString() };
}

function nextPendingStage(change: ChangeRequest): ApprovalStage | null {
  return APPROVAL_ORDER.find((stage) =>
    change.approvals.some((approval) => approval.stage === stage && approval.state === 'pending'),
  ) ?? null;
}

function now(): string {
  return new Date().toISOString();
}

function withLedger(change: ChangeRequest, ledger: ExecutionLedger): ChangeRequest {
  return touch(
    materializeLedger({
      ...change,
      ledger,
    }),
  );
}

/** 已存在相同幂等键的检查点，视为重复上报 */
function hasCheckpoint(change: ChangeRequest, dedupeKey: string): boolean {
  return Boolean(change.ledger?.entries.some((entry) => entry.dedupeKey === dedupeKey));
}

export const changeRequestReducer = createReducer(
  initialChangeRequestState,
  on(ChangeRequestActions.loadChanges, (state) => ({ ...state, loading: true, error: null })),
  on(ChangeRequestActions.loadChangesSuccess, (state, { changes }) => ({
    ...state,
    changes,
    loading: false,
  })),
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
  on(ChangeRequestActions.updateChange, (state, { change }) => ({
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
  })),
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

  // ── 执行检查点账本 ──────────────────────────────────────────────

  on(ChangeRequestActions.startExecution, (state, { id, actor }) => ({
    ...state,
    changes: state.changes.map((change) => {
      if (change.id !== id || change.status !== 'approved' || change.ledger) {
        return change;
      }
      const ledger: ExecutionLedger = {
        frozen: createFrozenPlan(change, now()),
        entries: [
          {
            dedupeKey: EXECUTION_START_KEY,
            kind: 'freeze',
            seq: 1,
            recordedAt: now(),
            actor,
          },
        ],
        conflicts: [],
        lastPersistedSeq: 0,
      };
      return withLedger(
        {
          ...change,
          approvals: frozenApprovals(change.approvals),
          audit: [
            createAudit('开始执行', '方案、会签结论和回滚步骤已冻结，检查点账本建立', actor),
            ...change.audit,
          ],
        },
        ledger,
      );
    }),
  })),

  on(
    ChangeRequestActions.reportStepCheckpoint,
    (state, { id, stepId, completed, dedupeKey, actor }) => ({
      ...state,
      changes: state.changes.map((change) => {
        const ledger = change.ledger;
        if (change.id !== id || change.status !== 'executing' || !ledger) {
          return change;
        }
        // 重复上报只记一次
        if (hasCheckpoint(change, dedupeKey)) {
          return change;
        }
        // 与当前重放状态一致的勾选上报视为重复，不再追加
        const projected = projectLedger(change);
        const current = projected?.steps.find((step) => step.id === stepId);
        if (!current || current.completed === completed) {
          return change;
        }
        const entry = {
          dedupeKey,
          kind: 'step' as const,
          seq: nextSeq(ledger),
          recordedAt: now(),
          stepId,
          completed,
          actor,
        };
        const stepTitle = current.title;
        return withLedger(
          {
            ...change,
            audit: [
              createAudit(
                '追加步骤检查点',
                `${stepTitle} ${completed ? '勾选完成' : '取消完成'}（检查点 #${entry.seq}）`,
                actor,
              ),
              ...change.audit,
            ],
          },
          { ...ledger, entries: [...ledger.entries, entry] },
        );
      }),
    }),
  ),

  on(ChangeRequestActions.recordDeviation, (state, { id, deviation }) => ({
    ...state,
    changes: state.changes.map((change) => {
      const ledger = change.ledger;
      if (change.id !== id || change.status !== 'executing' || !ledger) {
        return change;
      }
      const dedupeKey = buildDeviationDedupeKey(deviation.id);
      // 幂等只以账本条目为准：写入失败回滚后，允许用相同 id 重做
      if (ledger.entries.some((entry) => entry.dedupeKey === dedupeKey)) {
        return change;
      }
      const entry = {
        dedupeKey,
        kind: 'deviation' as const,
        seq: nextSeq(ledger),
        recordedAt: deviation.recordedAt,
        deviation,
        actor: deviation.owner,
      };
      return withLedger(
        {
          ...change,
          audit: [
            createAudit(
              '追加偏离检查点',
              `${deviation.owner} 记录偏离[${deviation.decision}]：${deviation.description}`,
              deviation.owner,
            ),
            ...change.audit,
          ],
        },
        { ...ledger, entries: [...ledger.entries, entry] },
      );
    }),
  })),

  on(ChangeRequestActions.reportTerminal, (state, { id, result, note, actor, dedupeKey }) => ({
    ...state,
    changes: state.changes.map((change) => {
      const ledger = change.ledger;
      // 终态已定时仍接受晚到的相反提交，以便登记冲突（见下方 established 分支）
      if (
        change.id !== id ||
        !ledger ||
        !['executing', 'completed', 'rolled_back'].includes(change.status)
      ) {
        return change;
      }
      // 完全相同的终态重复上报：只记一次
      if (hasCheckpoint(change, dedupeKey)) {
        return change;
      }
      const established = ledger.entries.find((entry) => entry.kind === 'terminal');
      // 终态已落账（当前状态即终态），任何新提交都与它比较
      if (established?.terminal && established.terminal !== result) {
        const conflict: TerminalConflict = {
          dedupeKey,
          attempted: result,
          established: established.terminal,
          recordedAt: now(),
          note,
          actor,
          reason:
            result === 'completed'
              ? `检查点 #${established.seq} 已先记录“执行回滚”，晚到的“执行完成”提交不能覆盖回滚终态；如需恢复请重新发起变更。`
              : `检查点 #${established.seq} 已先记录“执行完成”，晚到的“执行回滚”提交与终态冲突，未覆盖。`,
        };
        return touch({
          ...change,
          ledger: { ...ledger, conflicts: [conflict, ...ledger.conflicts] },
          audit: [
            createAudit(
              '终态冲突',
              `${actor} 的${result === 'completed' ? '完成' : '回滚'}提交与已落账终态（${
                established.terminal === 'completed' ? '已完成' : '已回滚'
              }）冲突，已保留原终态：${conflict.reason}`,
              actor,
            ),
            ...change.audit,
          ],
        });
      }
      const entry = {
        dedupeKey,
        kind: 'terminal' as const,
        seq: nextSeq(ledger),
        recordedAt: now(),
        terminal: result,
        note,
        actor,
      };
      return withLedger(
        {
          ...change,
          audit: [
            createAudit(
              result === 'completed' ? '追加完成检查点' : '追加回滚检查点',
              note,
              actor,
            ),
            ...change.audit,
          ],
        },
        { ...ledger, entries: [...ledger.entries, entry] },
      );
    }),
  })),

  on(ChangeRequestActions.checkpointPersisted, (state, { id, seq }) => ({
    ...state,
    changes: state.changes.map((change) => {
      const ledger = change.ledger;
      if (change.id !== id || !ledger) {
        return change;
      }
      // 已确认落盘：推进水位；已补做的待办和开始执行标记从恢复提示中移除
      const retainedRedo = (ledger.recovery?.pendingRedo ?? []).filter((item) => {
        if (item.dedupeKey === EXECUTION_START_KEY) {
          return false;
        }
        return !ledger.entries.some((entry) => entry.dedupeKey === item.dedupeKey);
      });
      const recovered = retainedRedo.length === 0 ? undefined : ledger.recovery;
      return {
        ...change,
        ledger: {
          ...ledger,
          lastPersistedSeq: Math.max(seq, ledger.lastPersistedSeq),
          recovery: recovered
            ? { ...recovered, restoredSeq: Math.max(seq, ledger.lastPersistedSeq), pendingRedo: retainedRedo }
            : undefined,
        },
      };
    }),
  })),

  on(
    ChangeRequestActions.checkpointPersistFailure,
    (state, { id, dedupeKey, error, starting, actor }) => ({
      ...state,
      changes: state.changes.map((change) => {
        if (change.id !== id || !change.ledger) {
          return change;
        }
        const ledger = change.ledger;

        // 开始执行这一步未能落盘：退回已批准，整笔冻结作废
        if (starting) {
          return touch({
            ...change,
            status: 'approved',
            approvals: ledger.frozen.approvals.map((approval) => ({ ...approval })),
            ledger: undefined,
            audit: [
              createAudit(
                '检查点写入失败',
                `开始执行的冻结检查点未能落盘，已恢复到“已批准”：${error}`,
                actor,
              ),
              ...change.audit,
            ],
          });
        }

        // 剔除所有未确认持久化的检查点（正常只有本次一条），恢复到最后完整检查点。
        // 冻结建账条目始终保留：即使尚未等到冻结落盘回执，也不允许回退为“已批准”。
        const dropped = ledger.entries.filter(
          (entry) => entry.seq > ledger.lastPersistedSeq && entry.kind !== 'freeze',
        );
        const confirmed = ledger.entries.filter(
          (entry) => entry.seq <= ledger.lastPersistedSeq || entry.kind === 'freeze',
        );
        if (dropped.length === 0) {
          // 可能是终态冲突留痕本身未保存成功，回滚对应冲突记录
          const conflicts = ledger.conflicts.filter((item) => item.dedupeKey !== dedupeKey);
          return touch({
            ...change,
            ledger: { ...ledger, conflicts },
            audit: [
              createAudit('检查点写入失败', `检查点未能落盘：${error}`, actor),
              ...change.audit,
            ],
          });
        }

        const previousRedo = ledger.recovery?.pendingRedo ?? [];
        const mergedRedo = [...previousRedo];
        for (const entry of dropped) {
          if (!mergedRedo.some((item) => item.dedupeKey === entry.dedupeKey)) {
            mergedRedo.push(toRedoItem(entry.dedupeKey));
          }
        }
        // 本次冲突留痕也未保存，一并回滚
        const conflicts = ledger.conflicts.filter((item) => item.dedupeKey !== dedupeKey);
        const restored: ChangeRequest = {
          ...change,
          ledger: {
            ...ledger,
            entries: confirmed,
            conflicts,
            recovery: {
              restoredAt: now(),
              restoredSeq: ledger.lastPersistedSeq,
              message: `检查点写入失败，已恢复到最后完整检查点（#${ledger.lastPersistedSeq}），请重做下列事项。原因：${error}`,
              pendingRedo: mergedRedo,
            },
          },
          audit: [
            createAudit(
              '检查点写入失败',
              `已恢复到最后完整检查点 #${ledger.lastPersistedSeq}，${dropped.length} 条检查点待重做：${error}`,
              actor,
            ),
            ...change.audit,
          ],
        };
        return materializeLedger(restored);
      }),
    }),
  ),
);
