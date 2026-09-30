import {
  ApprovalRecord,
  AuditRecord,
  ChangeResource,
  ChangeStep,
  ChangeWindow,
  DeviationRecord,
} from './change-request.model';

/**
 * 检查点账本条目类型：
 * - start：开始执行时冻结方案、会签和回滚步骤
 * - step：步骤完成上报
 * - deviation：执行偏离上报
 * - terminal：终态判定（完成 / 回滚）
 */
export type ExecutionEntryType = 'start' | 'step' | 'deviation' | 'terminal';

export type ExecutionTerminalResult = 'completed' | 'rolled_back';

/**
 * 条目生命周期状态：
 * - pending：已追加到内存账本，但尚未确认落盘
 * - committed：已随最后完整检查点落盘
 * - needsRedo：写入失败，等待值班员重做
 * - conflict：与先到的终态冲突（回滚先到、完成晚到）
 * - duplicate：重复上报，只记一次
 */
export type ExecutionEntryState =
  | 'pending'
  | 'committed'
  | 'needsRedo'
  | 'conflict'
  | 'duplicate';

export interface ExecutionEntry {
  /** 条目幂等键，同一上报（含晚到重试）只记一次 */
  token: string;
  /** 同一检查点内的条目共享同一序号 */
  seq: number;
  type: ExecutionEntryType;
  state: ExecutionEntryState;
  /** 条目首次追加时间（发生时刻，不随后续重做改变） */
  occurredAt: string;
  /** 最近一次状态变化时间 */
  updatedAt: string;
  actor: string;

  stepId?: string;
  stepTitle?: string;
  completed?: boolean;
  deviation?: DeviationRecord;
  result?: ExecutionTerminalResult;
  note?: string;

  /** conflict 状态下的冲突原因 */
  conflictReason?: string;
}

/** 开始执行时冻结的方案、会签与回滚步骤快照 */
export interface ExecutionFrozenPlan {
  title: string;
  summary: string;
  owner: string;
  onCall: string[];
  risk: string;
  resources: ChangeResource[];
  steps: ChangeStep[];
  window: ChangeWindow;
  approvals: ApprovalRecord[];
  frozenAt: string;
}

export interface ExecutionLedger {
  /** 最后完整检查点序号 */
  lastCommittedSeq: number;
  /** 最后完整检查点落盘时间 */
  lastCommittedAt?: string;
  entries: ExecutionEntry[];
  frozenPlan: ExecutionFrozenPlan;
}

/** 重做载荷：写入中断后可凭它无损恢复一个未确认条目 */
export interface ExecutionRedoPayload {
  changeId: string;
  entry: ExecutionEntry;
  /** start 条目重做时重建账本所需的冻结快照 */
  frozenPlan?: ExecutionFrozenPlan;
}

export interface ExecutionView {
  executing: boolean;
  terminal: ExecutionTerminalResult | null;
  completedStepIds: Set<string>;
  deviations: DeviationRecord[];
  /** 已落盘确认的步骤勾选（中断恢复后以它为准） */
  committedStepIds: Set<string>;
}

export interface PendingRedo {
  payload: ExecutionRedoPayload;
  changeId: string;
  entry: ExecutionEntry;
}

export interface TerminalConflict {
  changeId: string;
  entry: ExecutionEntry;
}

export function createCheckpointToken(): string {
  return `ckpt-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function nextEntrySeq(ledger: ExecutionLedger | undefined): number {
  if (!ledger) {
    return 1;
  }
  return ledger.entries.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1;
}

export function buildFrozenPlan(
  source: {
    title: string;
    summary: string;
    owner: string;
    onCall: string[];
    risk: string;
    resources: ChangeResource[];
    steps: ChangeStep[];
    window: ChangeWindow;
    approvals: ApprovalRecord[];
  },
  frozenAt = new Date().toISOString(),
): ExecutionFrozenPlan {
  return {
    title: source.title,
    summary: source.summary,
    owner: source.owner,
    onCall: [...source.onCall],
    risk: source.risk,
    resources: structuredClone(source.resources),
    steps: structuredClone(source.steps),
    window: structuredClone(source.window),
    approvals: structuredClone(source.approvals),
    frozenAt,
  };
}

/** 以最后完整检查点为准折叠账本，得到当前执行态视图 */
export function foldLedger(ledger: ExecutionLedger | undefined): ExecutionView {
  const view: ExecutionView = {
    executing: false,
    terminal: null,
    completedStepIds: new Set<string>(),
    deviations: [],
    committedStepIds: new Set<string>(),
  };
  if (!ledger) {
    return view;
  }

  const committed = ledger.entries.filter((entry) => entry.state === 'committed');
  view.executing = committed.some((entry) => entry.type === 'start');

  for (const entry of committed) {
    if (entry.type === 'step' && entry.stepId && entry.completed) {
      view.committedStepIds.add(entry.stepId);
      view.completedStepIds.add(entry.stepId);
    }
    if (entry.type === 'deviation' && entry.deviation) {
      view.deviations.push(entry.deviation);
    }
    if (entry.type === 'terminal' && entry.result) {
      view.terminal = entry.result;
    }
  }

  // 终态已落盘后，执行阶段结束
  if (view.terminal) {
    view.executing = false;
  }

  return view;
}

/** 晚到的完成提交遇到先到的回滚（或相反）时的冲突说明 */
export function describeTerminalConflict(
  incoming: ExecutionTerminalResult,
  existing: ExecutionTerminalResult,
): string {
  const label = (result: ExecutionTerminalResult): string =>
    result === 'rolled_back' ? '回滚判定' : '完成判定';
  return `${label(incoming)}晚到：${label(existing)}已先一步写入同一检查点，终态以后到不覆盖原则保留先到结果，本提交仅留冲突备查。`;
}

/** 从审计记录之外补充一条账本检查点审计事件 */
export function ledgerAudit(action: string, detail: string, actor = '当前用户'): AuditRecord {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: new Date().toISOString(),
    actor,
    action,
    detail,
  };
}

export function entryStateLabel(state: ExecutionEntryState): string {
  return (
    {
      pending: '待确认',
      committed: '已确认',
      needsRedo: '待重做',
      conflict: '终态冲突',
      duplicate: '重复忽略',
    } as const
  )[state];
}

export function terminalLabel(result: ExecutionTerminalResult): string {
  return result === 'rolled_back' ? '已回滚' : '已完成';
}
