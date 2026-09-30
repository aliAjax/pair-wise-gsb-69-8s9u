import { createActionGroup, emptyProps, props } from '@ngrx/store';
import {
  ApprovalStage,
  ChangeRequest,
  DeviationRecord,
  TerminalResult,
} from '../models/change-request.model';

export const ChangeRequestActions = createActionGroup({
  source: 'Change Request',
  events: {
    'Load Changes': emptyProps(),
    'Load Changes Success': props<{ changes: ChangeRequest[] }>(),
    'Load Changes Failure': props<{ error: string }>(),
    'Create Change': props<{ change: ChangeRequest }>(),
    'Update Change': props<{ change: ChangeRequest }>(),
    'Delete Draft': props<{ id: string }>(),
    'Submit For Review': props<{ id: string }>(),
    'Approve Stage': props<{ id: string; stage: ApprovalStage; approver: string; comment: string }>(),
    'Reject Stage': props<{ id: string; stage: ApprovalStage; approver: string; comment: string }>(),
    'Start Execution': props<{ id: string; actor: string }>(),
    /** 追加步骤检查点（重复上报由 reducer 按幂等键去重） */
    'Report Step Checkpoint': props<{
      id: string;
      stepId: string;
      completed: boolean;
      dedupeKey: string;
      actor: string;
    }>(),
    'Record Deviation': props<{
      id: string;
      deviation: DeviationRecord;
      dedupeKey: string;
      actor: string;
    }>(),
    /** 追加终态检查点；回滚先到时，晚到的完成提交留冲突不改写 */
    'Report Terminal': props<{
      id: string;
      result: TerminalResult;
      note: string;
      actor: string;
      dedupeKey: string;
    }>(),
    /** 检查点已确认落盘，推进 lastPersistedSeq 并清除恢复提示 */
    'Checkpoint Persisted': props<{ id: string; seq: number }>(),
    /** 检查点写入失败：回滚未确认条目，恢复到最后完整检查点并登记待重做 */
    'Checkpoint Persist Failure': props<{
      id: string;
      /** 本次提交的幂等键；开始执行失败时为 execution:start 标记 */
      dedupeKey: string;
      error: string;
      /** 是否为开始执行（失败后需退回已批准状态） */
      starting: boolean;
      actor: string;
    }>(),
  },
});
