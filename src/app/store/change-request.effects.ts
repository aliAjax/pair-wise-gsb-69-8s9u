import { inject, Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { catchError, map, of, switchMap, tap, withLatestFrom } from 'rxjs';
import { ChangeRequestService, CheckpointWriteError } from '../services/change-request.service';
import { ChangeRequestActions } from './change-request.actions';
import { selectAllChanges } from './change-request.selectors';

const CHECKPOINT_ACTIONS = [
  ChangeRequestActions.startExecution,
  ChangeRequestActions.reportStepCheckpoint,
  ChangeRequestActions.recordDeviation,
  ChangeRequestActions.reportTerminal,
] as const;

const OTHER_PERSIST_ACTIONS = [
  ChangeRequestActions.createChange,
  ChangeRequestActions.updateChange,
  ChangeRequestActions.deleteDraft,
  ChangeRequestActions.submitForReview,
  ChangeRequestActions.approveStage,
  ChangeRequestActions.rejectStage,
] as const;

@Injectable()
export class ChangeRequestEffects {
  private readonly actions$ = inject(Actions);
  private readonly service = inject(ChangeRequestService);
  private readonly store = inject(Store);

  loadChanges$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ChangeRequestActions.loadChanges),
      switchMap(() =>
        this.service.load().pipe(
          map((changes) => ChangeRequestActions.loadChangesSuccess({ changes })),
          catchError((error: unknown) =>
            of(
              ChangeRequestActions.loadChangesFailure({
                error: error instanceof Error ? error.message : '变更数据加载失败',
              }),
            ),
          ),
        ),
      ),
    ),
  );

  /**
   * 执行检查点：保存成功后推进持久化水位；保存失败派发失败回执，
   * reducer 回滚未确认条目并恢复到最后完整检查点。
   */
  persistCheckpoint$ = createEffect(() =>
    this.actions$.pipe(
      ofType(...CHECKPOINT_ACTIONS),
      withLatestFrom(this.store.select(selectAllChanges)),
      switchMap(([action, changes]) => {
        const id = action.id;
        const starting = action.type === ChangeRequestActions.startExecution.type;
        try {
          this.service.save(changes);
          const target = changes.find((change) => change.id === id);
          // 水位推进到当前最后一条检查点（开始执行含冻结条目 #1）
          const seq =
            target?.ledger?.entries.reduce((max, entry) => Math.max(max, entry.seq), 0) ?? 0;
          return of(ChangeRequestActions.checkpointPersisted({ id, seq }));
        } catch (error) {
          const message =
            error instanceof CheckpointWriteError
              ? error.message
              : error instanceof Error
                ? error.message
                : '检查点写入失败';
          return of(
            ChangeRequestActions.checkpointPersistFailure({
              id,
              dedupeKey:
                'dedupeKey' in action && typeof action.dedupeKey === 'string'
                  ? action.dedupeKey
                  : 'execution:start',
              error: message,
              starting,
              actor: action.actor,
            }),
          );
        }
      }),
    ),
  );

  /** 非执行期动作：尽力持久化，失败仅记录（不影响已批准/会签流程） */
  persistOtherChanges$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(...OTHER_PERSIST_ACTIONS),
        withLatestFrom(this.store.select(selectAllChanges)),
        tap(([, changes]) => {
          try {
            this.service.save(changes);
          } catch (error) {
            console.error('变更数据保存失败', error);
          }
        }),
      ),
    { dispatch: false },
  );
}
