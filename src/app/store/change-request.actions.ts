import { createActionGroup, emptyProps, props } from '@ngrx/store';
import {
  ApprovalStage,
  ChangeRequest,
  DeviationRecord,
} from '../models/change-request.model';
import {
  ExecutionEntry,
  ExecutionFrozenPlan,
  ExecutionRedoPayload,
  ExecutionTerminalResult,
} from '../models/execution-ledger.model';

export const ChangeRequestActions = createActionGroup({
  source: 'Change Request',
  events: {
    'Load Changes': emptyProps(),
    'Load Changes Success': props<{
      changes: ChangeRequest[];
      redo: ExecutionRedoPayload[];
    }>(),
    'Load Changes Failure': props<{ error: string }>(),
    'Create Change': props<{ change: ChangeRequest }>(),
    'Update Change': props<{ change: ChangeRequest }>(),
    'Delete Draft': props<{ id: string }>(),
    'Submit For Review': props<{ id: string }>(),
    'Approve Stage': props<{ id: string; stage: ApprovalStage; approver: string; comment: string }>(),
    'Reject Stage': props<{ id: string; stage: ApprovalStage; approver: string; comment: string }>(),

    // 执行检查点账本：所有上报携带幂等 token，重复上报只记一次
    'Start Execution Report': props<{
      id: string;
      token: string;
      actor: string;
      frozenPlan: ExecutionFrozenPlan;
    }>(),
    'Report Step': props<{
      id: string;
      token: string;
      stepId: string;
      stepTitle: string;
      completed: boolean;
      actor: string;
    }>(),
    'Record Deviation Report': props<{
      id: string;
      token: string;
      deviation: DeviationRecord;
    }>(),
    'Report Terminal': props<{
      id: string;
      token: string;
      result: ExecutionTerminalResult;
      note: string;
      actor: string;
    }>(),

    /** 检查点整包落盘成功：所有 pending 条目确认为 committed */
    'Checkpoint Committed': emptyProps(),
    /** 检查点落盘失败：未确认条目标记为待重做，并保留最后完整检查点 */
    'Checkpoint Failed': emptyProps(),

    'Retry Redo': props<{ payload: ExecutionRedoPayload }>(),
    'Discard Redo': props<{ token: string }>(),
  },
});
