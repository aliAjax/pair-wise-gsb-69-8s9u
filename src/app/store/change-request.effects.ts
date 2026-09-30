import { inject, Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { catchError, concatMap, map, of, switchMap, tap, withLatestFrom } from 'rxjs';
import { ChangeRequestService } from '../services/change-request.service';
import { ChangeRequestActions } from './change-request.actions';
import {
  selectChangeRequestState,
  selectRedoQueue,
} from './change-request.selectors';

@Injectable()
export class ChangeRequestEffects {
  private readonly actions$ = inject(Actions);
  private readonly service = inject(ChangeRequestService);
  private readonly store = inject(Store);

  loadChanges$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ChangeRequestActions.loadChanges),
      // 加载阶段关闭故障注入，避免首次读取被拦截
      tap(() => this.service.toggleWriteFault(false)),
      switchMap(() =>
        this.service.load().pipe(
          map((changes) =>
            ChangeRequestActions.loadChangesSuccess({
              changes,
              redo: this.service.loadRedoQueue(),
            }),
          ),
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

  // 所有执行动作都以整包检查点快照方式落盘，串行保存避免交叉覆盖
  persistCheckpoint$ = createEffect(() =>
    this.actions$.pipe(
      ofType(
        ChangeRequestActions.createChange,
        ChangeRequestActions.updateChange,
        ChangeRequestActions.deleteDraft,
        ChangeRequestActions.submitForReview,
        ChangeRequestActions.approveStage,
        ChangeRequestActions.rejectStage,
        ChangeRequestActions.startExecutionReport,
        ChangeRequestActions.reportStep,
        ChangeRequestActions.recordDeviationReport,
        ChangeRequestActions.reportTerminal,
        ChangeRequestActions.retryRedo,
        ChangeRequestActions.discardRedo,
      ),
      withLatestFrom(this.store.select(selectChangeRequestState)),
      concatMap(([, state]) => {
        try {
          this.service.save(state.changes);
          this.service.saveRedoQueue(state.redoQueue);
          return of(ChangeRequestActions.checkpointCommitted());
        } catch (error) {
          console.error('Checkpoint write failed, keeping last complete checkpoint', error);
          return of(ChangeRequestActions.checkpointFailed());
        }
      }),
    ),
  );

  // 写入失败后把待重做条目独立持久化，保证整包中断后仍可恢复
  persistRedoOnFailure$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(ChangeRequestActions.checkpointFailed),
        withLatestFrom(this.store.select(selectRedoQueue)),
        tap(([, redo]) => this.service.saveRedoQueue(redo)),
      ),
    { dispatch: false },
  );

  // 加载后把接回成功的重做队列回写（顺手裁剪无法接回的孤儿项）
  syncRedoAfterLoad$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(ChangeRequestActions.loadChangesSuccess),
        withLatestFrom(this.store.select(selectRedoQueue)),
        tap(([, redo]) => this.service.saveRedoQueue(redo)),
      ),
    { dispatch: false },
  );
}
