import { createFeatureSelector, createSelector } from '@ngrx/store';
import {
  ExecutionEntry,
  ExecutionRedoPayload,
} from '../models/execution-ledger.model';
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

export const selectRedoQueue = createSelector(
  selectChangeRequestState,
  (state) => state.redoQueue,
);

export interface PendingRedoView {
  changeId: string;
  changeTitle: string;
  entry: ExecutionEntry;
}

/** 工作台待重做项：以账本内 needsRedo 条目为准（含页面重载恢复的条目） */
export const selectPendingRedo = createSelector(
  selectAllChanges,
  selectRedoQueue,
  (changes, redoQueue): PendingRedoView[] => {
    const queuedTokens = new Set(redoQueue.map((item: ExecutionRedoPayload) => item.entry.token));
    const views: PendingRedoView[] = [];
    for (const change of changes) {
      const ledger = change.executionLedger;
      if (!ledger) {
        continue;
      }
      for (const entry of ledger.entries) {
        if (entry.state === 'needsRedo' || queuedTokens.has(entry.token)) {
          views.push({ changeId: change.id, changeTitle: change.title, entry });
        }
      }
    }
    // 账本尚未建立（开始执行的首检查点即失败）时，队列里也可能有待重做项
    for (const item of redoQueue) {
      if (
        item.entry.type === 'start' &&
        !changes.some(
          (change) =>
            change.id === item.changeId &&
            change.executionLedger?.entries.some((entry) => entry.token === item.entry.token),
        )
      ) {
        const change = changes.find((candidate) => candidate.id === item.changeId);
        views.push({
          changeId: item.changeId,
          changeTitle: change?.title ?? item.changeId,
          entry: item.entry,
        });
      }
    }
    return views;
  },
);

export const selectChangeById = (id: string) =>
  createSelector(selectAllChanges, (changes) =>
    changes.find((change) => change.id === id),
  );
