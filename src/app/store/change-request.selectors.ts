import { createFeatureSelector, createSelector } from '@ngrx/store';
import { ChangeRequest } from '../models/change-request.model';
import { projectLedger } from '../models/execution-ledger';
import { ChangeRequestState } from './change-request.reducer';

export const selectChangeRequestState =
  createFeatureSelector<ChangeRequestState>('changeRequests');

export const selectAllChanges = createSelector(
  selectChangeRequestState,
  (state) => state.changes,
);

export const selectChangesLoading = createSelector(
  selectChangeRequestState,
  (state) => state.loading,
);

export const selectChangesError = createSelector(
  selectChangeRequestState,
  (state) => state.error,
);

export const selectChangeById = (id: string) =>
  createSelector(selectAllChanges, (changes) =>
    changes.find((change) => change.id === id),
  );

/** 写入中断后仍有检查点待重做的变更（工作台提示用） */
export const selectRecoverableChanges = createSelector(selectAllChanges, (changes) =>
  changes.filter(
    (change) =>
      change.ledger?.recovery?.pendingRedo?.length ||
      change.ledger?.conflicts?.length,
  ),
);

export function selectExecutionView(id: string) {
  return createSelector(selectChangeById(id), (change) =>
    change ? projectLedger(change) : null,
  );
}

/** 变更的待重做项数量 */
export function getRedoCount(change: ChangeRequest): number {
  return change.ledger?.recovery?.pendingRedo.length ?? 0;
}

/** 变更未消解的终态冲突数量 */
export function getConflictCount(change: ChangeRequest): number {
  return change.ledger?.conflicts.length ?? 0;
}
