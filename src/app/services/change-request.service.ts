import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, Observable, of, tap } from 'rxjs';
import { ChangeRequest } from '../models/change-request.model';
import { migrateLegacyLedger, repairLedgerAfterLoad } from '../models/execution-ledger';

const STORAGE_KEY = 'pair-wise-gsb-69-changes';
/** 暂存键：先写完整内容到临时键，校验通过后再替换正式键 */
const STAGING_KEY = `${STORAGE_KEY}-staging`;
/** 最近一次完整数据备份：正式键被写坏时据此恢复 */
const BACKUP_KEY = `${STORAGE_KEY}-backup`;

export class CheckpointWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointWriteError';
  }
}

@Injectable({ providedIn: 'root' })
export class ChangeRequestService {
  private readonly http = inject(HttpClient);

  load(): Observable<ChangeRequest[]> {
    const localValue = localStorage.getItem(STORAGE_KEY);
    if (localValue) {
      const parsed = this.parseStore(localValue);
      if (parsed) {
        return of(parsed);
      }
    }

    // 正式键缺失或损坏：尝试用上一个完整备份恢复
    const backup = localStorage.getItem(BACKUP_KEY);
    if (backup) {
      const restored = this.parseStore(backup);
      if (restored) {
        localStorage.setItem(STORAGE_KEY, backup);
        return of(restored);
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

  private parseStore(value: string): ChangeRequest[] | null {
    try {
      const parsed = JSON.parse(value) as ChangeRequest[];
      if (!Array.isArray(parsed)) {
        return null;
      }
      // 清理任何残留暂存键，先迁移旧数据，再修复写入中断的检查点账本
      localStorage.removeItem(STAGING_KEY);
      return parsed.map((change) => repairLedgerAfterLoad(migrateLegacyLedger(change)));
    } catch {
      return null;
    }
  }

  /**
   * 原子化保存：暂存键写入并回读校验通过后，先备份现有正式数据，
   * 再提交正式键。任何一步失败都抛出，正式键仍保留最后完整检查点。
   */
  save(changes: ChangeRequest[]): void {
    let serialized: string;
    try {
      serialized = JSON.stringify(changes);
      // 写入暂存键
      localStorage.setItem(STAGING_KEY, serialized);
      // 回读校验，防止写入截断
      const staged = localStorage.getItem(STAGING_KEY);
      if (!staged || JSON.parse(staged) === undefined) {
        throw new Error('暂存数据回读校验失败');
      }
    } catch (error) {
      throw new CheckpointWriteError(
        `检查点暂存失败：${error instanceof Error ? error.message : '存储不可用或空间不足'}`,
      );
    }

    try {
      const previous = localStorage.getItem(STORAGE_KEY);
      if (previous) {
        localStorage.setItem(BACKUP_KEY, previous);
      }
      localStorage.setItem(STORAGE_KEY, serialized);
      // 提交后再次校验正式键
      const committed = localStorage.getItem(STORAGE_KEY);
      if (!committed || JSON.parse(committed) === undefined) {
        throw new Error('正式数据回读校验失败');
      }
      localStorage.removeItem(STAGING_KEY);
    } catch (error) {
      throw new CheckpointWriteError(
        `检查点提交失败：${error instanceof Error ? error.message : '正式键写入中断'}`,
      );
    }
  }

  exportRetrospective(change: ChangeRequest): string {
    const ledgerLines: string[] = [];
    const ledger = change.ledger;
    if (ledger) {
      ledgerLines.push('', '## 检查点账本');
      ledgerLines.push(
        `- 冻结时间：${ledger.frozen.frozenAt}，冻结步骤 ${ledger.frozen.planStepCount} 项（含回滚 ${ledger.frozen.rollbackSteps.length} 项）`,
      );
      ledgerLines.push(`- 最后完整检查点：#${ledger.lastPersistedSeq}`);
      ledgerLines.push('', '### 检查点流水');
      if (ledger.entries.length) {
        for (const entry of [...ledger.entries].sort((a, b) => a.seq - b.seq)) {
          if (entry.kind === 'freeze') {
            ledgerLines.push(`- #${entry.seq} ${entry.recordedAt} 冻结建账（${entry.actor}）`);
          } else if (entry.kind === 'step') {
            ledgerLines.push(
              `- #${entry.seq} ${entry.recordedAt} 步骤 ${entry.stepId} ${
                entry.completed ? '完成' : '取消完成'
              }（${entry.actor}）`,
            );
          } else if (entry.kind === 'deviation' && entry.deviation) {
            ledgerLines.push(
              `- #${entry.seq} ${entry.recordedAt} 偏离[${entry.deviation.decision}] ${entry.deviation.description}（${entry.actor}）`,
            );
          } else if (entry.kind === 'terminal') {
            ledgerLines.push(
              `- #${entry.seq} ${entry.recordedAt} 终态：${
                entry.terminal === 'completed' ? '执行完成' : '执行回滚'
              }（${entry.actor}）${entry.note ? ' ' + entry.note : ''}`,
            );
          }
        }
      } else {
        ledgerLines.push('- 无');
      }
      ledgerLines.push('', '### 终态冲突');
      if (ledger.conflicts.length) {
        for (const conflict of ledger.conflicts) {
          ledgerLines.push(
            `- ${conflict.recordedAt} 意图“${
              conflict.attempted === 'completed' ? '完成' : '回滚'
            }”与已落账“${
              conflict.established === 'completed' ? '完成' : '回滚'
            }”冲突：${conflict.reason}`,
          );
        }
      } else {
        ledgerLines.push('- 无');
      }
    }

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
      ...ledgerLines,
      '',
      '## 审计轨迹',
      ...change.audit.map(
        (item) => `- ${item.timestamp} ${item.actor} ${item.action}：${item.detail}`,
      ),
    ];
    return lines.join('\n');
  }
}
