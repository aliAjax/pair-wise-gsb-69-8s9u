import { DatePipe, NgClass } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { Store } from '@ngrx/store';
import { AuditTrailComponent } from '../../components/audit-trail/audit-trail.component';
import { DependencyGraphComponent } from '../../components/dependency-graph/dependency-graph.component';
import { ValidationPanelComponent } from '../../components/validation-panel/validation-panel.component';
import { WindowGanttComponent } from '../../components/window-gantt/window-gantt.component';
import {
  ApprovalStage,
  ChangeRequest,
  ChangeStep,
  DeviationRecord,
  PHASE_LABELS,
  RESOURCE_LABELS,
  RISK_LABELS,
  STAGE_LABELS,
  STATUS_LABELS,
  validateChange,
} from '../../models/change-request.model';
import {
  ExecutionEntry,
  ExecutionFrozenPlan,
  ExecutionRedoPayload,
  ExecutionTerminalResult,
  ExecutionView,
  buildFrozenPlan,
  createCheckpointToken,
  entryStateLabel,
  foldLedger,
  terminalLabel,
} from '../../models/execution-ledger.model';
import { ChangeRequestService } from '../../services/change-request.service';
import { ChangeRequestActions } from '../../store/change-request.actions';
import { selectAllChanges } from '../../store/change-request.selectors';

type DetailTab = 'overview' | 'dependency' | 'window' | 'execution' | 'approval' | 'audit';

@Component({
  selector: 'app-change-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    NgClass,
    FormsModule,
    RouterLink,
    ClarityModule,
    AuditTrailComponent,
    DependencyGraphComponent,
    ValidationPanelComponent,
    WindowGanttComponent,
  ],
  template: `
    @if (change(); as item) {
      <section class="detail-heading">
        <div class="heading-main">
          <a routerLink="/" class="back-link">返回变更队列</a>
          <div class="title-row">
            <div>
              <span class="change-id">{{ item.id }}</span>
              <h1>{{ item.title }}</h1>
            </div>
            <span class="status" [class]="item.status">{{ statusLabel(item.status) }}</span>
          </div>
          <p>{{ item.summary || '尚未填写变更摘要。' }}</p>
        </div>
        <div class="heading-meta">
          <div>
            <span>负责人</span>
            <strong>{{ item.owner }}</strong>
          </div>
          <div>
            <span>风险</span>
            <strong>{{ riskLabel(item.risk) }}</strong>
          </div>
          <div>
            <span>更新</span>
            <strong>{{ item.updatedAt | date: 'MM-dd HH:mm' }}</strong>
          </div>
        </div>
      </section>

      <nav class="tab-nav" aria-label="变更详情">
        @for (tab of tabs; track tab.id) {
          <button
            type="button"
            [class.active]="selectedTab() === tab.id"
            (click)="selectedTab.set(tab.id)"
          >
            {{ tab.label }}
            @if (tab.id === 'approval' && pendingStage(); as stage) {
              <span class="nav-badge">{{ stageLabel(stage) }}</span>
            }
          </button>
        }
      </nav>

      @switch (selectedTab()) {
        @case ('overview') {
          <div class="content-grid">
            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>方案概览</h2>
                  <span>影响范围、值班和执行边界</span>
                </div>
                <button
                  class="btn btn-sm"
                  type="button"
                  (click)="editing() ? cancelEdit() : beginEdit()"
                  [disabled]="!!item.executionLedger"
                >
                  {{ editing() ? '取消编辑' : '编辑方案' }}
                </button>
              </div>

              @if (editing()) {
                <div class="edit-form">
                  <clr-input-container>
                    <label>标题</label>
                    <input
                      clrInput
                      [ngModel]="draft()?.title"
                      (ngModelChange)="updateDraft('title', $event)"
                    />
                  </clr-input-container>
                  <clr-textarea-container>
                    <label>摘要</label>
                    <textarea
                      clrTextarea
                      rows="3"
                      [ngModel]="draft()?.summary"
                      (ngModelChange)="updateDraft('summary', $event)"
                    ></textarea>
                  </clr-textarea-container>
                  <div class="edit-grid">
                    <clr-input-container>
                      <label>窗口开始</label>
                      <input
                        clrInput
                        type="datetime-local"
                        [ngModel]="draft()?.window?.start"
                        (ngModelChange)="updateDraftWindow('start', $event)"
                      />
                    </clr-input-container>
                    <clr-input-container>
                      <label>窗口结束</label>
                      <input
                        clrInput
                        type="datetime-local"
                        [ngModel]="draft()?.window?.end"
                        (ngModelChange)="updateDraftWindow('end', $event)"
                      />
                    </clr-input-container>
                    <clr-input-container>
                      <label>观察窗口（分钟）</label>
                      <input
                        clrNumberInput
                        type="number"
                        [ngModel]="draft()?.window?.observationWindowMinutes"
                        (ngModelChange)="updateObservation($event)"
                      />
                    </clr-input-container>
                  </div>
                  <div class="edit-actions">
                    <button class="btn btn-primary" type="button" (click)="saveEdit()">保存方案</button>
                  </div>
                </div>
              } @else {
                <dl class="facts">
                  <div>
                    <dt>执行窗口</dt>
                    <dd>
                      {{ item.window.start | date: 'yyyy-MM-dd HH:mm' }} 至
                      {{ item.window.end | date: 'yyyy-MM-dd HH:mm' }}
                    </dd>
                  </div>
                  <div>
                    <dt>观察窗口</dt>
                    <dd>{{ item.window.observationWindowMinutes }} 分钟</dd>
                  </div>
                  <div>
                    <dt>值守人员</dt>
                    <dd>{{ item.onCall.join('、') }}</dd>
                  </div>
                  <div>
                    <dt>当前门禁</dt>
                    <dd>{{ pendingStage() ? stageLabel(pendingStage()!) + '待会签' : approvalGate() }}</dd>
                  </div>
                </dl>
              }
            </section>

            <app-validation-panel [change]="item" [allChanges]="changes()" />

            <section class="surface span-2">
              <div class="surface-heading">
                <div>
                  <h2>资源清单</h2>
                  <span>{{ item.resources.length }} 个对象，明确关键资源依赖</span>
                </div>
              </div>
              <div class="resource-table">
                @for (resource of item.resources; track resource.id) {
                  <article>
                    <span class="type">{{ resourceLabel(resource.type) }}</span>
                    <div>
                      <strong>{{ resource.name }}</strong>
                      <small>{{ resource.id }}</small>
                    </div>
                    <span>{{ resource.critical ? '关键资源' : '一般资源' }}</span>
                    <span>依赖 {{ resource.dependencies.length }} 项</span>
                  </article>
                } @empty {
                  <p class="empty">未配置资源。</p>
                }
              </div>
            </section>
          </div>
        }

        @case ('dependency') {
          <section class="surface">
            <div class="surface-heading">
              <div>
                <h2>依赖关系图</h2>
                <span>虚线表示依赖资源未纳入本次影响范围</span>
              </div>
            </div>
            <app-dependency-graph [change]="item" />
          </section>
        }

        @case ('window') {
          <section class="surface">
            <div class="surface-heading">
              <div>
                <h2>窗口与资源冲突</h2>
                <span>按 09-29 至 10-02 展示所有有效窗口</span>
              </div>
            </div>
            <app-window-gantt [changes]="changes()" [selectedId]="item.id" />
            <div class="conflict-notes">
              @for (issue of issues(); track issue.id) {
                @if (issue.code === 'WINDOW_CONFLICT') {
                  <article>
                    <strong>{{ issue.title }}</strong>
                    <p>{{ issue.detail }}</p>
                    <span>{{ issue.suggestedAction }}</span>
                  </article>
                }
              } @empty {
                <p class="empty">当前没有窗口冲突。</p>
              }
            </div>
          </section>
        }

        @case ('execution') {
          <div class="content-grid execution-grid">
            @if (ledger(); as ledgerItem) {
              <section class="surface span-2 freeze-banner">
                <div>
                  <h2>执行检查点账本</h2>
                  <span>
                    方案与会签已于
                    {{ ledgerItem.frozenPlan.frozenAt | date: 'yyyy-MM-dd HH:mm' }}
                    冻结，最后完整检查点
                    #{{ ledgerItem.lastCommittedSeq }}（{{
                      ledgerItem.lastCommittedAt
                        ? (ledgerItem.lastCommittedAt | date: 'MM-dd HH:mm')
                        : '尚无落盘确认'
                    }}）
                  </span>
                </div>
                <label class="fault-toggle" title="开启后下一次检查点保存将失败；刷新页面可复位">
                  <input
                    type="checkbox"
                    [checked]="writeFaultEnabled()"
                    (change)="toggleWriteFault()"
                  />
                  模拟下一次写入失败
                </label>
              </section>
            }

            @if (pendingRedoEntries().length) {
              <section class="surface span-2 redo-panel">
                <div class="surface-heading">
                  <div>
                    <h2>待重做项（{{ pendingRedoEntries().length }}）</h2>
                    <span>写入中断后已恢复到最后完整检查点，以下上报需值班员确认重做</span>
                  </div>
                </div>
                @for (entry of pendingRedoEntries(); track entry.token) {
                  <div class="redo-row">
                    <div>
                      <strong>检查点 #{{ entry.seq }} · {{ entrySummary(entry) }}</strong>
                      <small>{{ entry.occurredAt | date: 'MM-dd HH:mm:ss' }} · {{ entry.actor }}</small>
                    </div>
                    <div class="redo-actions">
                      <button class="btn btn-sm" type="button" (click)="discardRedo(entry)">
                        放弃
                      </button>
                      <button class="btn btn-sm btn-primary" type="button" (click)="retryRedo(entry)">
                        重做此检查点
                      </button>
                    </div>
                  </div>
                }
              </section>
            }

            @if (conflictEntries().length) {
              <section class="surface span-2 conflict-panel">
                <div class="surface-heading">
                  <div>
                    <h2>终态冲突留痕</h2>
                    <span>后到的终态提交不覆盖先到结果，仅记录冲突原因备查</span>
                  </div>
                </div>
                @for (entry of conflictEntries(); track entry.token) {
                  <article class="conflict-row">
                    <strong>{{ entry.result === 'completed' ? '晚到完成提交' : '晚到回滚提交' }}</strong>
                    <p>{{ entry.conflictReason }}</p>
                    <small>{{ entry.occurredAt | date: 'MM-dd HH:mm:ss' }} · {{ entry.actor }}</small>
                  </article>
                }
              </section>
            }

            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>执行步骤</h2>
                  <span>
                    @if (ledger()) {
                      按冻结步骤逐项上报完成，勾选以最后完整检查点为准
                    } @else {
                      执行中可逐项勾选，所有操作保留时间戳
                    }
                  </span>
                </div>
                @if (item.status === 'approved' && !ledger()) {
                  <button class="btn btn-primary" type="button" (click)="startExecution()">
                    开始执行
                  </button>
                }
              </div>
              <div class="step-list">
                @for (step of stepsBy(item); track step.id) {
                  <label
                    class="step-row"
                    [class.completed]="isStepCommitted(step.id)"
                    [class.pending]="isStepPending(step.id)"
                  >
                    <input
                      type="checkbox"
                      [checked]="isStepCommitted(step.id)"
                      [disabled]="!view().executing || isStepCommitted(step.id)"
                      (change)="toggleStep(step)"
                    />
                    <span class="phase">{{ phaseLabel(step.phase) }}</span>
                    <div>
                      <strong>{{ step.title }}</strong>
                      <code>{{ step.command || '未填写命令' }}</code>
                    </div>
                    <span class="step-meta">
                      {{ step.owner || '未指定' }}
                      @if (isStepPending(step.id)) {
                        <em class="state-pending">待落盘</em>
                      }
                    </span>
                  </label>
                } @empty {
                  <p class="empty">没有执行步骤。</p>
                }
              </div>
            </section>

            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>实时执行记录</h2>
                  <span>记录偏离并明确继续、暂停或回滚</span>
                </div>
                <a class="btn btn-sm" href="https://logs.example.internal/change/{{ item.id }}" target="_blank" rel="noopener">
                  打开实时日志
                </a>
              </div>
              @if (view().executing) {
                <div class="deviation-form">
                  <clr-textarea-container>
                    <label>偏离说明</label>
                    <textarea
                      clrTextarea
                      rows="3"
                      [ngModel]="deviationText()"
                      (ngModelChange)="deviationText.set($event)"
                      placeholder="描述实际执行与方案差异"
                    ></textarea>
                  </clr-textarea-container>
                  <div class="deviation-actions">
                    <clr-select-container>
                      <label>处置决定</label>
                      <select
                        clrSelect
                        [ngModel]="deviationDecision()"
                        (ngModelChange)="deviationDecision.set($event)"
                      >
                        <option value="continue">继续观察</option>
                        <option value="pause">暂停执行</option>
                        <option value="rollback">立即回滚</option>
                      </select>
                    </clr-select-container>
                    <button class="btn" type="button" (click)="recordDeviation()">
                      记录偏离检查点
                    </button>
                  </div>
                </div>
                <div class="completion-actions">
                  <button class="btn" type="button" (click)="complete('rolled_back')">
                    判定回滚
                  </button>
                  <button class="btn btn-primary" type="button" (click)="complete('completed')">
                    执行完成
                  </button>
                </div>
              } @else if (view().terminal) {
                <div class="terminal-strip" [class.rollback]="view().terminal === 'rolled_back'">
                  终态已按检查点 #{{ ledger()?.lastCommittedSeq }} 落盘：{{
                    view().terminal === 'rolled_back' ? '已回滚' : '已完成'
                  }}
                  @if (view().terminal === 'rolled_back') {
                    <button class="btn btn-sm" type="button" (click)="reportLateComplete()">
                      模拟晚到的完成提交
                    </button>
                  }
                </div>
              }
              <div class="deviation-list">
                @for (deviation of view().deviations; track deviation.id) {
                  <article>
                    <div>
                      <strong>{{ deviation.owner }}</strong>
                      <time>{{ deviation.recordedAt | date: 'MM-dd HH:mm' }}</time>
                    </div>
                    <p>{{ deviation.description }}</p>
                    <span>{{ decisionLabel(deviation.decision) }}</span>
                  </article>
                } @empty {
                  <p class="empty">
                    {{ ledger() ? '已确认的偏离将在此显示。' : '尚无执行偏离。' }}
                  </p>
                }
              </div>
            </section>

            @if (ledger()) {
              <section class="surface span-2">
                <div class="surface-heading">
                  <div>
                    <h2>检查点流水</h2>
                    <span>同一检查点的开始、步骤、偏离与终态按序号追加，重复上报只记一次</span>
                  </div>
                </div>
                <ol class="ledger-list">
                  @for (entry of ledgerEntries(); track entry.token) {
                    <li [class]="entry.state">
                      <span class="ledger-seq">#{{ entry.seq }}</span>
                      <div>
                        <strong>{{ entrySummary(entry) }}</strong>
                        <small
                          >{{ entry.occurredAt | date: 'MM-dd HH:mm:ss' }} ·
                          {{ entry.actor }}</small
                        >
                      </div>
                      <span class="ledger-state" [class]="entry.state">
                        {{ entryStateLabel(entry.state) }}
                      </span>
                    </li>
                  }
                </ol>
              </section>
            }
          </div>
        }

        @case ('approval') {
          <div class="content-grid approval-grid">
            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>顺序会签</h2>
                  <span>必须按网络、系统、安全、业务顺序完成</span>
                </div>
                @if (item.status === 'draft' || item.status === 'rejected') {
                  <button
                    class="btn btn-primary"
                    type="button"
                    (click)="submitForReview()"
                    [disabled]="hasBlockers()"
                  >
                    提交审批
                  </button>
                }
              </div>
              <ol class="approval-flow">
                @for (approval of item.approvals; track approval.stage) {
                  <li [ngClass]="approval.state">
                    <span class="flow-index">{{ $index + 1 }}</span>
                    <div>
                      <strong>{{ stageLabel(approval.stage) }}</strong>
                      <p>
                        {{ approval.comment || approvalStateText(approval.state) }}
                      </p>
                      @if (approval.approver) {
                        <small>
                          {{ approval.approver }} · {{ approval.decidedAt | date: 'MM-dd HH:mm' }}
                        </small>
                      }
                    </div>
                  </li>
                }
              </ol>
            </section>

            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>会签操作</h2>
                  <span>只有当前顺位负责人可以签署</span>
                </div>
              </div>
              @if (pendingStage(); as stage) {
                @if (item.status === 'submitted' || item.status === 'rejected') {
                  <div class="approval-form">
                    <clr-input-container>
                      <label>审批人</label>
                      <input
                        clrInput
                        [ngModel]="approver()"
                        (ngModelChange)="approver.set($event)"
                      />
                    </clr-input-container>
                    <clr-textarea-container>
                      <label>意见</label>
                      <textarea
                        clrTextarea
                        rows="3"
                        [ngModel]="approvalComment()"
                        (ngModelChange)="approvalComment.set($event)"
                      ></textarea>
                    </clr-textarea-container>
                    <div class="approval-actions">
                      <button class="btn" type="button" (click)="reject(stage)">退回</button>
                      <button class="btn btn-primary" type="button" (click)="approve(stage)">
                        批准 {{ stageLabel(stage) }}
                      </button>
                    </div>
                  </div>
                } @else {
                  <p class="empty">当前状态不允许审批操作。</p>
                }
              } @else {
                <p class="approved-message">
                  会签已完成。开始执行后审批记录自动冻结，不允许修改。
                </p>
              }
            </section>

            <section class="surface span-2">
              <div class="surface-heading">
                <div>
                  <h2>审批冻结快照</h2>
                  <span>执行与复盘以冻结版本为准</span>
                </div>
              </div>
              <div class="freeze-strip">
                @for (approval of item.approvals; track approval.stage) {
                  <div>
                    <span>{{ stageLabel(approval.stage) }}</span>
                    <strong>{{ approvalStateText(approval.state) }}</strong>
                  </div>
                }
              </div>
            </section>
          </div>
        }

        @case ('audit') {
          <div class="content-grid audit-grid">
            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>审计轨迹</h2>
                  <span>创建、编辑、会签、执行和回滚均记录</span>
                </div>
                <button class="btn btn-sm" type="button" (click)="exportRetrospective()">
                  导出复盘记录
                </button>
              </div>
              <app-audit-trail [records]="item.audit" />
            </section>
            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>复盘摘要</h2>
                  <span>进入正式变更档案的事实记录</span>
                </div>
              </div>
              <dl class="facts compact">
                <div>
                  <dt>最终状态</dt>
                  <dd>{{ statusLabel(item.status) }}</dd>
                </div>
                <div>
                  <dt>执行偏离</dt>
                  <dd>{{ item.deviations.length }} 条</dd>
                </div>
                <div>
                  <dt>审计事件</dt>
                  <dd>{{ item.audit.length }} 条</dd>
                </div>
                <div>
                  <dt>完成步骤</dt>
                  <dd>{{ completedSteps(item) }} / {{ displaySteps().length }}</dd>
                </div>
                <div>
                  <dt>最后检查点</dt>
                  <dd>
                    @if (ledger(); as ledgerItem) {
                      #{{ ledgerItem.lastCommittedSeq
                      }}<ng-container
                        >（{{ ledgerItem.entries.filter((e) => e.state === 'needsRedo').length }}
                        项待重做）</ng-container
                      >
                    } @else {
                      未开始
                    }
                  </dd>
                </div>
              </dl>
              <div class="retrospective-note">
                <strong>导出内容</strong>
                <p>包含变更窗口、资源范围、执行偏离、最终状态和完整审计轨迹。</p>
              </div>
            </section>
          </div>
        }
      }
    } @else {
      <section class="not-found">
        <h1>变更不存在</h1>
        <p>该记录可能已被删除，或链接中的编号无效。</p>
        <a class="btn btn-primary" routerLink="/">返回变更队列</a>
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .detail-heading {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 24px;
        padding: 20px 0 24px;
        border-bottom: 1px solid #d7d7d7;
      }

      .back-link {
        display: inline-block;
        margin-bottom: 14px;
        font-size: 12px;
      }

      .title-row {
        display: flex;
        align-items: center;
        gap: 14px;
      }

      .change-id {
        color: #266c91;
        font-size: 12px;
        font-weight: 600;
      }

      h1 {
        margin: 2px 0 0;
        font-size: 28px;
      }

      .heading-main > p {
        max-width: 760px;
        margin: 12px 0 0;
        color: #5e5e5e;
      }

      .heading-meta {
        display: grid;
        grid-template-columns: repeat(3, minmax(90px, 1fr));
        align-self: end;
        border: 1px solid #d7d7d7;
        background: #fff;
      }

      .heading-meta div {
        padding: 12px 16px;
        border-left: 1px solid #e1e1e1;
      }

      .heading-meta div:first-child {
        border-left: 0;
      }

      .heading-meta span,
      .heading-meta strong {
        display: block;
      }

      .heading-meta span {
        color: #6d6d6d;
        font-size: 11px;
      }

      .heading-meta strong {
        margin-top: 4px;
        font-size: 13px;
      }

      .status {
        padding: 3px 9px;
        border: 1px solid #9a9a9a;
        background: #f3f3f3;
        color: #474747;
        font-size: 12px;
      }

      .status.submitted,
      .status.approved {
        border-color: #5688a5;
        background: #eaf4f9;
        color: #1d5877;
      }

      .status.executing,
      .status.completed {
        border-color: #75a489;
        background: #edf7f0;
        color: #245f3d;
      }

      .status.rejected,
      .status.rolled_back {
        border-color: #d58d7e;
        background: #fbece8;
        color: #8e260f;
      }

      .tab-nav {
        display: flex;
        gap: 0;
        margin-bottom: 20px;
        border-bottom: 1px solid #d7d7d7;
        overflow-x: auto;
      }

      .tab-nav button {
        position: relative;
        padding: 13px 18px;
        border: 0;
        border-bottom: 3px solid transparent;
        background: transparent;
        color: #575757;
        cursor: pointer;
        white-space: nowrap;
      }

      .tab-nav button.active {
        border-bottom-color: #266c91;
        color: #174d6a;
        font-weight: 600;
      }

      .nav-badge {
        margin-left: 6px;
        padding: 1px 5px;
        background: #eaf4f9;
        color: #215a78;
        font-size: 10px;
      }

      .content-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }

      .surface {
        padding: 18px;
        border: 1px solid #d7d7d7;
        background: #fff;
      }

      .span-2 {
        grid-column: 1 / -1;
      }

      .surface-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding-bottom: 14px;
        border-bottom: 1px solid #e3e3e3;
      }

      .surface-heading h2 {
        margin: 0;
        font-size: 17px;
      }

      .surface-heading span {
        color: #666;
        font-size: 12px;
      }

      .facts {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 1px;
        margin: 18px 0 0;
        background: #e1e1e1;
      }

      .facts div {
        padding: 14px;
        background: #fafafa;
      }

      .facts dt {
        color: #666;
        font-size: 12px;
      }

      .facts dd {
        margin: 5px 0 0;
        font-weight: 600;
      }

      .facts.compact {
        margin-top: 16px;
      }

      .edit-form {
        padding-top: 18px;
      }

      .edit-grid,
      .deviation-actions {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 14px;
      }

      .edit-actions,
      .completion-actions,
      .approval-actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 16px;
      }

      .resource-table article {
        display: grid;
        grid-template-columns: 80px minmax(180px, 1fr) 100px 120px;
        align-items: center;
        gap: 14px;
        padding: 12px 4px;
        border-bottom: 1px solid #e6e6e6;
      }

      .resource-table article:last-child {
        border-bottom: 0;
      }

      .resource-table article div {
        display: flex;
        flex-direction: column;
      }

      .resource-table small,
      .resource-table article > span:last-child {
        color: #6b6b6b;
        font-size: 11px;
      }

      .type,
      .phase {
        display: inline-block;
        width: fit-content;
        padding: 2px 7px;
        background: #edf3f6;
        color: #205d7e;
        font-size: 11px;
      }

      .conflict-notes {
        margin-top: 16px;
      }

      .conflict-notes article {
        padding: 14px;
        border-left: 3px solid #c21d00;
        background: #fbece8;
      }

      .conflict-notes p {
        margin: 6px 0;
      }

      .conflict-notes span {
        color: #8e260f;
        font-size: 12px;
      }

      .step-row {
        display: grid;
        grid-template-columns: 20px 50px 1fr 90px;
        align-items: center;
        gap: 12px;
        padding: 14px 2px;
        border-bottom: 1px solid #e6e6e6;
      }

      .step-row.completed {
        background: #f5faf6;
      }

      .step-row div {
        display: flex;
        flex-direction: column;
      }

      .step-row code {
        margin-top: 4px;
        color: #666;
        font-size: 11px;
      }

      .deviation-form {
        padding: 16px 0;
        border-bottom: 1px solid #e3e3e3;
      }

      .deviation-actions {
        grid-template-columns: 1fr auto;
        align-items: end;
      }

      .deviation-list article {
        padding: 12px 0;
        border-bottom: 1px solid #e6e6e6;
      }

      .deviation-list article > div {
        display: flex;
        justify-content: space-between;
      }

      .deviation-list p {
        margin: 7px 0;
      }

      .deviation-list span {
        color: #8e260f;
        font-size: 11px;
      }

      .approval-flow {
        margin: 18px 0 0;
        padding: 0;
        list-style: none;
      }

      .approval-flow li {
        display: grid;
        grid-template-columns: 32px 1fr;
        gap: 12px;
        padding: 12px 0;
        border-bottom: 1px solid #e6e6e6;
      }

      .flow-index {
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border: 1px solid #9d9d9d;
        color: #555;
      }

      .approval-flow li.approved .flow-index {
        border-color: #4b8d65;
        background: #e8f5ed;
        color: #245f3d;
      }

      .approval-flow li.rejected .flow-index {
        border-color: #c21d00;
        background: #fbece8;
        color: #8e260f;
      }

      .approval-flow p {
        margin: 5px 0;
        color: #5f5f5f;
      }

      .approval-flow small {
        color: #737373;
      }

      .approval-form {
        padding-top: 16px;
      }

      .approved-message {
        margin: 18px 0 0;
        padding: 16px;
        border-left: 3px solid #4b8d65;
        background: #edf7f0;
        color: #245f3d;
      }

      .freeze-strip {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 1px;
        margin-top: 18px;
        background: #d7d7d7;
      }

      .freeze-strip div {
        display: flex;
        flex-direction: column;
        padding: 14px;
        background: #fafafa;
      }

      .freeze-strip span {
        color: #666;
        font-size: 11px;
      }

      .freeze-strip strong {
        margin-top: 4px;
      }

      .retrospective-note {
        margin-top: 18px;
        padding: 16px;
        background: #f4f6f7;
      }

      .retrospective-note p {
        margin: 6px 0 0;
        color: #5f5f5f;
      }

      .empty {
        color: #737373;
      }

      .freeze-banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        border-left: 4px solid #266c91;
      }

      .freeze-banner h2 {
        margin: 0 0 4px;
        font-size: 16px;
      }

      .fault-toggle {
        display: flex;
        align-items: center;
        gap: 8px;
        white-space: nowrap;
        color: #8e260f;
        font-size: 12px;
        cursor: pointer;
      }

      .redo-panel {
        border-left: 4px solid #c21d00;
      }

      .redo-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        padding: 12px 2px;
        border-bottom: 1px solid #f0d5cf;
      }

      .redo-row:last-child {
        border-bottom: 0;
      }

      .redo-row strong {
        display: block;
        font-size: 13px;
      }

      .redo-row small {
        color: #8e260f;
      }

      .redo-actions {
        display: flex;
        gap: 8px;
      }

      .conflict-panel {
        border-left: 4px solid #d58d7e;
      }

      .conflict-row {
        padding: 12px;
        background: #fbece8;
      }

      .conflict-row p {
        margin: 6px 0;
        color: #8e260f;
      }

      .conflict-row small {
        color: #9b5a4d;
      }

      .step-row.pending {
        outline: 1px dashed #d0a251;
        background: #fff8ec;
      }

      .step-meta {
        display: flex;
        flex-direction: column;
        gap: 4px;
        color: #575757;
        font-size: 12px;
      }

      .state-pending {
        color: #7c5000;
        font-style: normal;
        font-size: 11px;
      }

      .terminal-strip {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin: 14px 0;
        padding: 12px 14px;
        border-left: 3px solid #4b8d65;
        background: #edf7f0;
        color: #245f3d;
        font-size: 13px;
      }

      .terminal-strip.rollback {
        border-left-color: #d58d7e;
        background: #fbece8;
        color: #8e260f;
      }

      .ledger-list {
        margin: 14px 0 0;
        padding: 0;
        list-style: none;
      }

      .ledger-list li {
        display: grid;
        grid-template-columns: 48px 1fr auto;
        align-items: center;
        gap: 12px;
        padding: 10px 4px;
        border-bottom: 1px solid #ececec;
      }

      .ledger-list li:last-child {
        border-bottom: 0;
      }

      .ledger-list li.needsRedo,
      .ledger-list li.conflict {
        background: #fdf3f1;
      }

      .ledger-list li.pending {
        background: #fff8ec;
      }

      .ledger-seq {
        color: #266c91;
        font-size: 12px;
        font-weight: 600;
      }

      .ledger-list strong {
        display: block;
        font-size: 13px;
      }

      .ledger-list small {
        color: #737373;
      }

      .ledger-state {
        padding: 2px 8px;
        font-size: 11px;
        border: 1px solid #b9b9b9;
        color: #555;
        background: #f4f4f4;
        white-space: nowrap;
      }

      .ledger-state.committed {
        border-color: #8fb99f;
        color: #286140;
        background: #edf7f0;
      }

      .ledger-state.pending {
        border-color: #d0a251;
        color: #7c5000;
        background: #fff7e6;
      }

      .ledger-state.needsRedo,
      .ledger-state.conflict {
        border-color: #d58d7e;
        color: #8e260f;
        background: #fbece8;
      }

      .ledger-state.duplicate {
        border-color: #9aa9b5;
        color: #425463;
        background: #eef2f5;
      }

      .not-found {
        margin-top: 50px;
        padding: 48px;
        text-align: center;
        border: 1px solid #d7d7d7;
        background: #fff;
      }

      @media (max-width: 1100px) {
        .detail-heading,
        .content-grid {
          grid-template-columns: 1fr;
        }

        .span-2 {
          grid-column: auto;
        }
      }

      @media (max-width: 700px) {
        .heading-meta,
        .facts,
        .edit-grid,
        .freeze-strip {
          grid-template-columns: 1fr;
        }

        .heading-meta div {
          border-left: 0;
          border-top: 1px solid #e1e1e1;
        }

        .resource-table article,
        .step-row {
          grid-template-columns: 1fr;
        }

        .tab-nav {
          padding-bottom: 4px;
        }
      }
    `,
  ],
})
export class ChangeDetailComponent {
  private readonly store = inject(Store);
  private readonly route = inject(ActivatedRoute);
  private readonly service = inject(ChangeRequestService);
  private readonly changeId = this.route.snapshot.paramMap.get('id') ?? '';

  readonly changes = this.store.selectSignal(selectAllChanges);
  readonly change = computed(() => this.changes().find((item) => item.id === this.changeId));
  readonly selectedTab = signal<DetailTab>('execution');
  readonly editing = signal(false);
  readonly draft = signal<ChangeRequest | null>(null);
  readonly approver = signal('');
  readonly approvalComment = signal('');
  readonly deviationText = signal('');
  readonly deviationDecision = signal<DeviationRecord['decision']>('continue');

  /** 执行检查点账本：执行开始后以冻结快照为准 */
  readonly ledger = computed(() => this.change()?.executionLedger);
  readonly view = computed<ExecutionView>(() => foldLedger(this.ledger()));
  /** 写入故障注入开关（演示写入中断与恢复） */
  readonly writeFaultEnabled = this.service.writeFaultEnabled;

  /** 执行态展示的步骤：有冻结快照时以冻结版本为准，防止方案被中途改写 */
  readonly displaySteps = computed<ChangeStep[]>(() => {
    const item = this.change();
    if (!item) {
      return [];
    }
    return this.ledger()?.frozenPlan.steps ?? item.steps;
  });

  readonly pendingRedoEntries = computed<ExecutionEntry[]>(
    () => this.ledger()?.entries.filter((entry) => entry.state === 'needsRedo') ?? [],
  );

  readonly conflictEntries = computed<ExecutionEntry[]>(
    () => this.ledger()?.entries.filter((entry) => entry.state === 'conflict') ?? [],
  );

  readonly ledgerEntries = computed<ExecutionEntry[]>(() => {
    const entries = this.ledger()?.entries ?? [];
    return [...entries].sort((left, right) =>
      left.seq === right.seq
        ? left.occurredAt.localeCompare(right.occurredAt)
        : right.seq - left.seq,
    );
  });

  readonly tabs: Array<{ id: DetailTab; label: string }> = [
    { id: 'overview', label: '方案概览' },
    { id: 'dependency', label: '依赖关系' },
    { id: 'window', label: '窗口甘特' },
    { id: 'execution', label: '执行记录' },
    { id: 'approval', label: '审批会签' },
    { id: 'audit', label: '审计复盘' },
  ];

  readonly issues = computed(() => {
    const item = this.change();
    return item ? validateChange(item, this.changes()) : [];
  });

  readonly hasBlockers = computed(() =>
    this.issues().some((issue) => issue.severity === 'blocker'),
  );

  readonly pendingStage = computed<ApprovalStage | null>(() => {
    const item = this.change();
    if (!item || !['submitted', 'rejected'].includes(item.status)) {
      return null;
    }
    const rejected = item.approvals.find((approval) => approval.state === 'rejected');
    if (rejected) {
      return rejected.stage;
    }
    return item.approvals.find((approval) => approval.state === 'pending')?.stage ?? null;
  });

  beginEdit(): void {
    const item = this.change();
    if (!item) {
      return;
    }
    this.draft.set(structuredClone(item));
    this.editing.set(true);
  }

  cancelEdit(): void {
    this.editing.set(false);
    this.draft.set(null);
  }

  updateDraft<K extends keyof ChangeRequest>(key: K, value: ChangeRequest[K]): void {
    this.draft.update((draft) => (draft ? { ...draft, [key]: value } : draft));
  }

  updateDraftWindow(key: 'start' | 'end', value: string): void {
    this.draft.update((draft) =>
      draft ? { ...draft, window: { ...draft.window, [key]: value } } : draft,
    );
  }

  updateObservation(value: string | number): void {
    this.draft.update((draft) =>
      draft
        ? {
            ...draft,
            window: { ...draft.window, observationWindowMinutes: Number(value) || 0 },
          }
        : draft,
    );
  }

  saveEdit(): void {
    const draft = this.draft();
    if (!draft) {
      return;
    }
    this.store.dispatch(ChangeRequestActions.updateChange({ change: draft }));
    this.editing.set(false);
    this.draft.set(null);
  }

  submitForReview(): void {
    if (!this.hasBlockers()) {
      this.store.dispatch(ChangeRequestActions.submitForReview({ id: this.changeId }));
    }
  }

  approve(stage: ApprovalStage): void {
    const approver = this.approver().trim() || '当前用户';
    const comment = this.approvalComment().trim() || '同意按方案执行。';
    this.store.dispatch(
      ChangeRequestActions.approveStage({
        id: this.changeId,
        stage,
        approver,
        comment,
      }),
    );
    this.clearApprovalForm();
  }

  reject(stage: ApprovalStage): void {
    const approver = this.approver().trim() || '当前用户';
    const comment = this.approvalComment().trim();
    if (!comment) {
      return;
    }
    this.store.dispatch(
      ChangeRequestActions.rejectStage({
        id: this.changeId,
        stage,
        approver,
        comment,
      }),
    );
    this.clearApprovalForm();
  }

  startExecution(): void {
    const item = this.change();
    if (!item || item.status !== 'approved') {
      return;
    }
    const frozenPlan: ExecutionFrozenPlan = buildFrozenPlan(item);
    this.store.dispatch(
      ChangeRequestActions.startExecutionReport({
        id: this.changeId,
        token: createCheckpointToken(),
        actor: item.owner || '当前用户',
        frozenPlan,
      }),
    );
  }

  toggleStep(step: ChangeStep): void {
    if (this.view().terminal) {
      return;
    }
    // 以显式完成上报替代开关翻转：已确认的步骤不允许取消，重复上报只记一次
    const alreadyCommitted = this.view().committedStepIds.has(step.id);
    this.store.dispatch(
      ChangeRequestActions.reportStep({
        id: this.changeId,
        token: createCheckpointToken(),
        stepId: step.id,
        stepTitle: step.title,
        completed: !alreadyCommitted,
        actor: this.currentActor(),
      }),
    );
  }

  isStepCommitted(stepId: string): boolean {
    return this.view().committedStepIds.has(stepId);
  }

  isStepPending(stepId: string): boolean {
    return this.ledger()?.entries.some(
      (entry) =>
        entry.type === 'step' && entry.stepId === stepId && entry.state === 'pending',
    ) ?? false;
  }

  recordDeviation(): void {
    const description = this.deviationText().trim();
    if (!description) {
      return;
    }
    const deviation: DeviationRecord = {
      id: `dev-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
      recordedAt: new Date().toISOString(),
      owner: this.currentActor(),
      description,
      decision: this.deviationDecision(),
    };
    this.store.dispatch(
      ChangeRequestActions.recordDeviationReport({
        id: this.changeId,
        token: createCheckpointToken(),
        deviation,
      }),
    );
    this.deviationText.set('');
  }

  complete(result: ExecutionTerminalResult): void {
    const note =
      result === 'completed'
        ? '观察窗口内指标稳定，变更完成。'
        : '发现不可接受影响，按方案完成回滚。';
    this.store.dispatch(
      ChangeRequestActions.reportTerminal({
        id: this.changeId,
        token: createCheckpointToken(),
        result,
        note,
        actor: this.currentActor(),
      }),
    );
  }

  /** 模拟晚到的完成提交：回滚先到后，完成提交留冲突且不覆盖 */
  reportLateComplete(): void {
    this.complete('completed');
  }

  retryRedo(entry: ExecutionEntry): void {
    const payload: ExecutionRedoPayload = {
      changeId: this.changeId,
      entry,
      ...(entry.type === 'start' ? { frozenPlan: this.ledger()?.frozenPlan } : {}),
    };
    this.store.dispatch(ChangeRequestActions.retryRedo({ payload }));
  }

  discardRedo(entry: ExecutionEntry): void {
    this.store.dispatch(ChangeRequestActions.discardRedo({ token: entry.token }));
  }

  toggleWriteFault(): void {
    this.service.toggleWriteFault(!this.writeFaultEnabled());
  }

  private currentActor(): string {
    return this.change()?.onCall[0] ?? this.change()?.owner ?? '当前用户';
  }

  exportRetrospective(): void {
    const item = this.change();
    if (!item) {
      return;
    }
    const blob = new Blob([this.service.exportRetrospective(item)], {
      type: 'text/markdown;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${item.id}-retrospective.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  stepsBy(change: ChangeRequest): ChangeStep[] {
    const order: ChangeStep['phase'][] = ['prepare', 'execute', 'verify', 'rollback'];
    const source = change.executionLedger ? change.executionLedger.frozenPlan.steps : change.steps;
    return [...source].sort((left, right) => {
      const phase = order.indexOf(left.phase) - order.indexOf(right.phase);
      return phase || left.id.localeCompare(right.id);
    });
  }

  completedSteps(change: ChangeRequest): number {
    if (change.executionLedger) {
      return this.view().committedStepIds.size;
    }
    return change.steps.filter((step) => step.completed).length;
  }

  entryStateLabel(state: ExecutionEntry['state']): string {
    return entryStateLabel(state);
  }

  entrySummary(entry: ExecutionEntry): string {
    switch (entry.type) {
      case 'start':
        return '开始执行：冻结方案、会签与回滚步骤';
      case 'step':
        return `步骤勾选：${entry.stepTitle ?? entry.stepId}`;
      case 'deviation':
        return `执行偏离：${entry.deviation?.description ?? ''}`;
      case 'terminal':
        return entry.conflictReason
          ? `终态冲突：${entry.conflictReason}`
          : `终态判定：${entry.result ? terminalLabel(entry.result) : ''}`;
    }
  }

  statusLabel(status: ChangeRequest['status']): string {
    return STATUS_LABELS[status];
  }

  riskLabel(risk: ChangeRequest['risk']): string {
    return RISK_LABELS[risk];
  }

  resourceLabel(type: ChangeRequest['resources'][number]['type']): string {
    return RESOURCE_LABELS[type];
  }

  stageLabel(stage: ApprovalStage): string {
    return STAGE_LABELS[stage];
  }

  phaseLabel(phase: ChangeStep['phase']): string {
    return PHASE_LABELS[phase];
  }

  approvalStateText(state: ChangeRequest['approvals'][number]['state']): string {
    return {
      pending: '等待签署',
      approved: '已批准',
      rejected: '已退回',
      frozen: '已冻结',
    }[state];
  }

  approvalGate(): string {
    const item = this.change();
    if (!item) {
      return '-';
    }
    if (item.status === 'approved') {
      return '已批准，等待执行';
    }
    if (['executing', 'completed', 'rolled_back'].includes(item.status)) {
      return '审批已冻结';
    }
    return '方案草稿';
  }

  decisionLabel(decision: DeviationRecord['decision']): string {
    return {
      continue: '继续观察',
      pause: '暂停执行',
      rollback: '立即回滚',
    }[decision];
  }

  private clearApprovalForm(): void {
    this.approver.set('');
    this.approvalComment.set('');
  }
}
