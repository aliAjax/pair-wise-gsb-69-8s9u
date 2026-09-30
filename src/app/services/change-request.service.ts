import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { catchError, Observable, of, tap } from 'rxjs';
import { ChangeRequest } from '../models/change-request.model';
import {
  ExecutionLedger,
  ExecutionRedoPayload,
} from '../models/execution-ledger.model';

const STORAGE_KEY = 'pair-wise-gsb-69-changes';
const STAGING_KEY = 'pair-wise-gsb-69-changes-staging';
const REDO_KEY = 'pair-wise-gsb-69-execution-redo';
const FAULT_KEY = 'pair-wise-gsb-69-inject-write-fault';

export class CheckpointWriteError extends Error {
  constructor() {
    super('检查点写入失败：本地账本存储不可用');
    this.name = 'CheckpointWriteError';
  }
}

@Injectable({ providedIn: 'root' })
export class ChangeRequestService {
  private readonly http = inject(HttpClient);

  /** 故障注入开关：开启后下一次保存抛错，用于演示写入中断与恢复 */
  readonly writeFaultEnabled = signal(this.readFaultFlag());

  load(): Observable<ChangeRequest[]> {
    const localValue = localStorage.getItem(STORAGE_KEY);
    if (localValue) {
      try {
        return of(JSON.parse(localValue) as ChangeRequest[]);
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }

    return this.http.get<ChangeRequest[]>('/mock/change-requests.json').pipe(
      tap((changes) => this.save(changes)),
      catchError((error: unknown) => {
        console.error('Failed to load change requests', error);
        return of([]);
      }),
    );
  }

  /** 读取写入中断后保留下来的待重做检查点条目 */
  loadRedoQueue(): ExecutionRedoPayload[] {
    const value = localStorage.getItem(REDO_KEY);
    if (!value) {
      return [];
    }
    try {
      const parsed = JSON.parse(value) as ExecutionRedoPayload[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      localStorage.removeItem(REDO_KEY);
      return [];
    }
  }

  /**
   * 整包快照落盘：先写暂存键再提升为主键。
   * 中断时主键仍保留最后完整检查点，下一次读取自然恢复。
   */
  save(changes: ChangeRequest[]): void {
    if (this.writeFaultEnabled()) {
      throw new CheckpointWriteError();
    }
    const serialized = JSON.stringify(changes);
    localStorage.setItem(STAGING_KEY, serialized);
    localStorage.setItem(STORAGE_KEY, serialized);
    localStorage.removeItem(STAGING_KEY);
  }

  /** 待重做条目独立落盘，体积小、尽力写入，保证中断后仍可恢复 */
  saveRedoQueue(redo: ExecutionRedoPayload[]): void {
    try {
      if (redo.length) {
        localStorage.setItem(REDO_KEY, JSON.stringify(redo));
      } else {
        localStorage.removeItem(REDO_KEY);
      }
    } catch (error) {
      console.error('Failed to persist redo queue', error);
    }
  }

  toggleWriteFault(enabled: boolean): void {
    this.writeFaultEnabled.set(enabled);
    try {
      if (enabled) {
        localStorage.setItem(FAULT_KEY, '1');
      } else {
        localStorage.removeItem(FAULT_KEY);
      }
    } catch {
      // 开关仅用于演示，存储不可用时保留内存值即可
    }
  }

  private readFaultFlag(): boolean {
    try {
      return localStorage.getItem(FAULT_KEY) === '1';
    } catch {
      return false;
    }
  }

  exportRetrospective(change: ChangeRequest): string {
    const ledger: ExecutionLedger | undefined = change.executionLedger;
    const lines = [
      `# ${change.id} ${change.title} 复盘记录`,
      '',
      `状态：${change.status}`,
      `负责人：${change.owner}`,
      `窗口：${change.window.start} - ${change.window.end}`,
      `风险等级：${change.risk}`,
      '',
      '## 执行偏离',
      ...(change.deviations.length
        ? change.deviations.map(
            (item) =>
              `- ${item.recordedAt} ${item.owner} [${item.decision}] ${item.description}`,
          )
        : ['- 无']),
      '',
      '## 检查点账本',
      ...(ledger
        ? [
            `- 最后完整检查点：#${ledger.lastCommittedSeq}${
              ledger.lastCommittedAt ? `（${ledger.lastCommittedAt}）` : ''
            }`,
            `- 冻结时间：${ledger.frozenPlan.frozenAt}`,
            ...ledger.entries.map(
              (entry) =>
                `- #${entry.seq} ${entry.occurredAt} ${entry.actor} ${entry.type} ${entry.state}${
                  entry.conflictReason ? `：${entry.conflictReason}` : ''
                }`,
            ),
          ]
        : ['- 尚未开始执行']),
      '',
      '## 审计轨迹',
      ...change.audit.map(
        (item) => `- ${item.timestamp} ${item.actor} ${item.action}：${item.detail}`,
      ),
    ];
    return lines.join('\n');
  }
}
