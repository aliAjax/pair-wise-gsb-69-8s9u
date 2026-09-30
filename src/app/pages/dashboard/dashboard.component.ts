import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { Store } from '@ngrx/store';
import { WindowGanttComponent } from '../../components/window-gantt/window-gantt.component';
import {
  ChangeStatus,
  RESOURCE_LABELS,
  RISK_LABELS,
  ResourceType,
  STATUS_LABELS,
  validateChange,
} from '../../models/change-request.model';
import { ChangeRequestService } from '../../services/change-request.service';
import { ChangeRequestActions } from '../../store/change-request.actions';
import {
  selectAllChanges,
  selectChangesError,
  selectChangesLoading,
  selectPendingRedo,
} from '../../store/change-request.selectors';

@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, RouterLink, ClarityModule, WindowGanttComponent],
  template: `
    <section class="page-heading">
      <div>
        <p class="eyebrow">变更控制台</p>
        <h1>变更窗口与回滚审阅</h1>
        <p>集中检查资源依赖、窗口冲突、回滚可执行性和顺序会签状态。</p>
      </div>
      <a class="btn btn-primary" routerLink="/changes/new">
        <cds-icon shape="plus"></cds-icon>
        新建变更
      </a>
    </section>

    <section class="checkpoint-bar" [class.fault]="writeFaultEnabled()">
      <div>
        <strong>检查点账本</strong>
        <span
          >待重做 {{ pendingRedo().length }} 项 · 终态冲突 {{ terminalConflicts().length }} 项 ·
          所有执行上报按同一检查点幂等追加</span
        >
      </div>
      <label class="fault-switch">
        <input
          type="checkbox"
          [checked]="writeFaultEnabled()"
          (change)="toggleWriteFault()"
        />
        模拟写入故障（下一次保存中断，验证可接续恢复）
      </label>
    </section>

    @if (pendingRedo().length) {
      <section class="redo-board">
        <div class="board-heading">
          <h2>待重做检查点</h2>
          <span>写入中断后保留的最后完整检查点之后的未确认上报，需值班员逐项重做或放弃</span>
        </div>
        @for (item of pendingRedo(); track item.entry.token) {
          <div class="board-row">
            <a [routerLink]="['/changes', item.changeId]" class="board-link">
              <strong>{{ item.changeId }} {{ item.changeTitle }}</strong>
              <small>检查点 #{{ item.entry.seq }} · {{ item.entry.occurredAt | date: 'MM-dd HH:mm:ss' }}</small>
            </a>
            <span class="board-desc">{{ redoSummary(item.changeId) }} 等待重做</span>
            <div class="board-actions">
              <button class="btn btn-sm" type="button" (click)="discardRedo(item.entry.token)">
                放弃
              </button>
              <button
                class="btn btn-sm btn-primary"
                type="button"
                (click)="retryRedo(item.changeId, item.entry.token)"
              >
                重做
              </button>
            </div>
          </div>
        }
      </section>
    }

    @if (terminalConflicts().length) {
      <section class="conflict-board">
        <div class="board-heading">
          <h2>终态冲突</h2>
          <span>回滚先到后晚到的完成提交已留冲突，先到终态不被覆盖</span>
        </div>
        @for (item of terminalConflicts(); track item.entry.token) {
          <a [routerLink]="['/changes', item.change.id]" class="conflict-row">
            <strong>{{ item.change.id }} {{ item.change.title }}</strong>
            <span>{{ item.entry.conflictReason }}</span>
          </a>
        }
      </section>
    }

    <section class="stats" aria-label="变更统计">
      <article>
        <span>待会签</span>
        <strong>{{ countByStatus('submitted') }}</strong>
        <small>需负责人顺序处理</small>
      </article>
      <article>
        <span>执行中</span>
        <strong>{{ countByStatus('executing') }}</strong>
        <small>需持续记录偏离</small>
      </article>
      <article class="danger">
        <span>有阻断项</span>
        <strong>{{ blockedCount() }}</strong>
        <small>依赖、冲突或回滚风险</small>
      </article>
      <article>
        <span>今日窗口</span>
        <strong>{{ todayWindowCount() }}</strong>
        <small>基于当前筛选数据</small>
      </article>
    </section>

    @if (error()) {
      <clr-alert clrAlertType="danger" [clrAlertClosable]="false">
        <clr-alert-item>
          <span class="alert-text">{{ error() }}</span>
        </clr-alert-item>
      </clr-alert>
    }

    <section class="work-panel">
      <div class="panel-heading">
        <div>
          <h2>变更队列</h2>
          <span>{{ filteredChanges().length }} / {{ changes().length }} 条</span>
        </div>
        <button class="btn btn-sm" type="button" (click)="reload()" [disabled]="loading()">
          {{ loading() ? '加载中' : '刷新' }}
        </button>
      </div>

      <div class="filters">
        <clr-input-container>
          <label>关键词</label>
          <input
            clrInput
            type="search"
            placeholder="编号、标题、负责人"
            [ngModel]="query()"
            (ngModelChange)="query.set($event)"
          />
        </clr-input-container>
        <clr-select-container>
          <label>状态</label>
          <select clrSelect [ngModel]="status()" (ngModelChange)="status.set($event)">
            <option value="all">全部状态</option>
            @for (item of statuses; track item.value) {
              <option [value]="item.value">{{ item.label }}</option>
            }
          </select>
        </clr-select-container>
        <clr-select-container>
          <label>资源类型</label>
          <select
            clrSelect
            [ngModel]="resourceType()"
            (ngModelChange)="resourceType.set($event)"
          >
            <option value="all">全部资源</option>
            @for (item of resourceTypes; track item.value) {
              <option [value]="item.value">{{ item.label }}</option>
            }
          </select>
        </clr-select-container>
        <clr-select-container>
          <label>风险</label>
          <select clrSelect [ngModel]="risk()" (ngModelChange)="risk.set($event)">
            <option value="all">全部风险</option>
            <option value="critical">严重</option>
            <option value="high">高</option>
            <option value="medium">中</option>
            <option value="low">低</option>
          </select>
        </clr-select-container>
      </div>

      <div class="change-table-wrap">
        <table class="change-table">
          <thead>
            <tr>
              <th>变更</th>
              <th>状态</th>
              <th>风险</th>
              <th>窗口</th>
              <th>负责人</th>
              <th>校验</th>
            </tr>
          </thead>
          <tbody>
            @for (change of filteredChanges(); track change.id) {
              <tr>
                <td>
                  <a [routerLink]="['/changes', change.id]" class="change-link">
                    <span>{{ change.id }}</span>
                    <strong>{{ change.title }}</strong>
                  </a>
                </td>
                <td>
                  <span class="status" [class]="change.status">{{ statusLabel(change.status) }}</span>
                  @if (redoCountFor(change.id); as redoCount) {
                    <a
                      class="redo-badge"
                      [routerLink]="['/changes', change.id]"
                      [title]="redoSummary(change.id) + ' 待重做'"
                    >
                      待重做 {{ redoCount }}
                    </a>
                  }
                </td>
                <td>
                  <span class="risk" [class]="change.risk">{{ riskLabel(change.risk) }}</span>
                </td>
                <td>
                  <div class="date-cell">
                    <span>{{ change.window.start | date: 'MM-dd HH:mm' }}</span>
                    <small>至 {{ change.window.end | date: 'MM-dd HH:mm' }}</small>
                  </div>
                </td>
                <td>{{ change.owner }}</td>
                <td>
                  @if (issueCount(change.id); as count) {
                    <span class="issue-count">{{ count }} 项</span>
                  } @else {
                    <span class="issue-count clear">通过</span>
                  }
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="6" class="empty-row">没有符合条件的变更。</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </section>

    <section class="work-panel">
      <div class="panel-heading">
        <div>
          <h2>窗口甘特视图</h2>
          <span>红色条表示共享资源窗口冲突</span>
        </div>
      </div>
      <app-window-gantt [changes]="filteredChanges()" />
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .page-heading {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        gap: 24px;
        margin-bottom: 22px;
      }

      h1 {
        margin: 4px 0 8px;
        font-size: 28px;
        color: #1b1b1b;
      }

      .eyebrow {
        margin: 0;
        color: #266c91;
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
      }

      .page-heading p:last-child {
        margin: 0;
        color: #5e5e5e;
      }

      .stats {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 1px;
        margin-bottom: 22px;
        border: 1px solid #d7d7d7;
        background: #d7d7d7;
      }

      .stats article {
        display: flex;
        flex-direction: column;
        min-height: 110px;
        padding: 18px;
        background: #ffffff;
        border-top: 3px solid #266c91;
      }

      .stats article.danger {
        border-top-color: #c21d00;
      }

      .stats span,
      .stats small {
        color: #666;
      }

      .stats strong {
        margin: 5px 0;
        color: #1b1b1b;
        font-size: 30px;
      }

      .work-panel {
        margin-bottom: 24px;
        border: 1px solid #d7d7d7;
        background: #ffffff;
      }

      .panel-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 18px;
        border-bottom: 1px solid #d7d7d7;
      }

      .panel-heading h2 {
        margin: 0;
        font-size: 17px;
      }

      .panel-heading span {
        color: #6b6b6b;
        font-size: 12px;
      }

      .filters {
        display: grid;
        grid-template-columns: 1.6fr repeat(3, minmax(150px, 0.7fr));
        gap: 16px;
        padding: 18px 18px 4px;
        border-bottom: 1px solid #d7d7d7;
      }

      .change-link {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .change-table-wrap {
        overflow-x: auto;
      }

      .change-table {
        width: 100%;
        min-width: 900px;
        border-collapse: collapse;
        text-align: left;
      }

      .change-table th {
        padding: 10px 14px;
        border-bottom: 1px solid #d7d7d7;
        background: #f7f8f8;
        color: #666;
        font-size: 11px;
        font-weight: 600;
      }

      .change-table td {
        padding: 13px 14px;
        border-bottom: 1px solid #e4e4e4;
        vertical-align: middle;
      }

      .change-table tbody tr:hover {
        background: #f8fbfc;
      }

      .empty-row {
        padding: 36px 14px !important;
        text-align: center;
        color: #737373;
      }

      .change-link span {
        color: #266c91;
        font-size: 11px;
      }

      .change-link strong {
        color: #1b1b1b;
      }

      .status,
      .risk,
      .issue-count {
        display: inline-block;
        padding: 2px 7px;
        border: 1px solid #a4a4a4;
        color: #414141;
        background: #f2f2f2;
        font-size: 11px;
      }

      .status.executing,
      .status.approved {
        border-color: #4b8d65;
        color: #245f3d;
        background: #e8f5ed;
      }

      .status.submitted {
        border-color: #5688a5;
        color: #215a78;
        background: #eaf4f9;
      }

      .status.rejected,
      .status.rolled_back,
      .risk.critical,
      .risk.high,
      .issue-count {
        border-color: #d58d7e;
        color: #8e260f;
        background: #fbece8;
      }

      .risk.medium {
        border-color: #d0a251;
        color: #7c5000;
        background: #fff7e6;
      }

      .risk.low,
      .issue-count.clear {
        border-color: #8fb99f;
        color: #286140;
        background: #edf7f0;
      }

      .date-cell {
        display: flex;
        flex-direction: column;
      }

      .date-cell small {
        color: #737373;
      }

      .checkpoint-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        margin-bottom: 18px;
        padding: 12px 16px;
        border: 1px solid #bcd2de;
        background: #eef6fa;
      }

      .checkpoint-bar.fault {
        border-color: #d58d7e;
        background: #fbece8;
      }

      .checkpoint-bar strong {
        display: block;
        font-size: 13px;
        color: #1d5877;
      }

      .checkpoint-bar.fault strong {
        color: #8e260f;
      }

      .checkpoint-bar span {
        color: #5f5f5f;
        font-size: 12px;
      }

      .fault-switch {
        display: flex;
        align-items: center;
        gap: 8px;
        white-space: nowrap;
        color: #555;
        font-size: 12px;
        cursor: pointer;
      }

      .checkpoint-bar.fault .fault-switch {
        color: #8e260f;
      }

      .redo-board,
      .conflict-board {
        margin-bottom: 18px;
        border: 1px solid #d58d7e;
        background: #fff;
      }

      .conflict-board {
        border-color: #e0b5ab;
        background: #fdf6f4;
      }

      .board-heading {
        padding: 14px 16px;
        border-bottom: 1px solid #f0d5cf;
      }

      .board-heading h2 {
        margin: 0 0 3px;
        font-size: 15px;
        color: #8e260f;
      }

      .board-heading span {
        color: #8a6a62;
        font-size: 12px;
      }

      .board-row {
        display: grid;
        grid-template-columns: minmax(220px, 1.4fr) 1fr auto;
        align-items: center;
        gap: 14px;
        padding: 12px 16px;
        border-bottom: 1px solid #f5e4df;
      }

      .board-row:last-child {
        border-bottom: 0;
      }

      .board-link {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .board-link small,
      .board-desc {
        color: #9b5a4d;
        font-size: 12px;
      }

      .board-actions {
        display: flex;
        gap: 8px;
      }

      .conflict-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 12px 16px;
        border-bottom: 1px solid #f5e4df;
      }

      .conflict-row:last-child {
        border-bottom: 0;
      }

      .conflict-row span {
        color: #8e260f;
        font-size: 12px;
      }

      .redo-badge {
        display: inline-block;
        margin-left: 6px;
        padding: 2px 7px;
        border: 1px solid #d58d7e;
        background: #fbece8;
        color: #8e260f;
        font-size: 11px;
      }

      @media (max-width: 980px) {
        .stats {
          grid-template-columns: repeat(2, 1fr);
        }

        .filters {
          grid-template-columns: 1fr 1fr;
        }
      }

      @media (max-width: 640px) {
        .page-heading {
          align-items: flex-start;
          flex-direction: column;
        }

        .stats,
        .filters {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class DashboardComponent {
  private readonly store = inject(Store);
  private readonly service = inject(ChangeRequestService);

  readonly changes = this.store.selectSignal(selectAllChanges);
  readonly loading = this.store.selectSignal(selectChangesLoading);
  readonly error = this.store.selectSignal(selectChangesError);
  readonly pendingRedo = this.store.selectSignal(selectPendingRedo);
  readonly writeFaultEnabled = this.service.writeFaultEnabled;

  readonly query = signal('');
  readonly status = signal<ChangeStatus | 'all'>('all');
  readonly resourceType = signal<ResourceType | 'all'>('all');
  readonly risk = signal('all');

  readonly statuses = Object.entries(STATUS_LABELS).map(([value, label]) => ({
    value: value as ChangeStatus,
    label,
  }));
  readonly resourceTypes = Object.entries(RESOURCE_LABELS).map(([value, label]) => ({
    value: value as ResourceType,
    label,
  }));

  readonly filteredChanges = computed(() => {
    const query = this.query().trim().toLowerCase();
    const status = this.status();
    const resourceType = this.resourceType();
    const risk = this.risk();

    return this.changes().filter((change) => {
      const searchable = `${change.id} ${change.title} ${change.owner}`.toLowerCase();
      const matchesQuery = !query || searchable.includes(query);
      const matchesStatus = status === 'all' || change.status === status;
      const matchesResource =
        resourceType === 'all' ||
        change.resources.some((resource) => resource.type === resourceType);
      const matchesRisk = risk === 'all' || change.risk === risk;
      return matchesQuery && matchesStatus && matchesResource && matchesRisk;
    });
  });

  readonly blockedCount = computed(
    () =>
      this.changes().filter((change) =>
        validateChange(change, this.changes()).some((issue) => issue.severity === 'blocker'),
      ).length,
  );

  /** 所有变更中尚未消解的终态冲突留痕 */
  readonly terminalConflicts = computed(() =>
    this.changes().flatMap((change) =>
      (change.executionLedger?.entries ?? [])
        .filter((entry) => entry.state === 'conflict')
        .map((entry) => ({ change, entry })),
    ),
  );

  readonly todayWindowCount = computed(() =>
    this.filteredChanges().filter((change) => change.window.start.startsWith('2026-09-29')).length,
  );

  redoCountFor(changeId: string): number {
    return this.pendingRedo().filter((item) => item.changeId === changeId).length;
  }

  redoSummary(changeId: string): string {
    const items = this.pendingRedo().filter((item) => item.changeId === changeId);
    return items
      .map((item) =>
        item.entry.type === 'start'
          ? '开始执行'
          : item.entry.type === 'step'
            ? '步骤勾选'
            : item.entry.type === 'deviation'
              ? '偏离记录'
              : '终态判定',
      )
      .join('、');
  }

  retryRedo(changeId: string, token: string): void {
    const target = this.pendingRedo().find((item) => item.entry.token === token);
    const change = this.changes().find((item) => item.id === changeId);
    if (!target || !change) {
      return;
    }
    this.store.dispatch(
      ChangeRequestActions.retryRedo({
        payload: {
          changeId,
          entry: target.entry,
          ...(target.entry.type === 'start'
            ? { frozenPlan: change.executionLedger?.frozenPlan }
            : {}),
        },
      }),
    );
  }

  discardRedo(token: string): void {
    this.store.dispatch(ChangeRequestActions.discardRedo({ token }));
  }

  toggleWriteFault(): void {
    this.service.toggleWriteFault(!this.writeFaultEnabled());
  }

  reload(): void {
    this.store.dispatch(ChangeRequestActions.loadChanges());
  }

  countByStatus(status: ChangeStatus): number {
    return this.changes().filter((change) => change.status === status).length;
  }

  issueCount(changeId: string): number {
    const change = this.changes().find((item) => item.id === changeId);
    return change ? validateChange(change, this.changes()).length : 0;
  }

  statusLabel(status: ChangeStatus): string {
    return STATUS_LABELS[status];
  }

  riskLabel(risk: 'low' | 'medium' | 'high' | 'critical'): string {
    return RISK_LABELS[risk];
  }
}
