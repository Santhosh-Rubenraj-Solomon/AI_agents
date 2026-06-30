import { Injectable, Logger } from '@nestjs/common';

export type LedgerStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

export interface LedgerRecord {
  txId: string;
  amount: number;
  status: LedgerStatus;
  vendor: string;
  updatedAt: string;
}

/**
 * In-memory stand-in for the internal accounting ledger.
 *
 * Seeded with deliberately "drifted" rows so the AI agent has something real to
 * reconcile against incoming vendor webhooks:
 *   - tx_1001: PENDING, amount matches a SUCCESS webhook  -> agent should heal to SUCCESS
 *   - tx_1002: PENDING, but amount will MISMATCH a webhook -> agent should mark FAILED
 *   - tx_1003: already SUCCESS                            -> agent should leave it / no-op
 *
 * In production this is a TypeORM/Prisma repository over the `postgres` service
 * declared in docker-compose.yml.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);
  private readonly store = new Map<string, LedgerRecord>();

  constructor() {
    this.seed();
  }

  private seed(): void {
    const now = new Date().toISOString();
    const rows: LedgerRecord[] = [
      { txId: 'tx_1001', amount: 100.0, status: 'PENDING', vendor: 'stripe', updatedAt: now },
      { txId: 'tx_1002', amount: 250.0, status: 'PENDING', vendor: 'adyen', updatedAt: now },
      { txId: 'tx_1003', amount: 999.0, status: 'SUCCESS', vendor: 'stripe', updatedAt: now },
    ];
    rows.forEach((r) => this.store.set(r.txId, r));
  }

  get(txId: string): LedgerRecord | null {
    return this.store.get(txId) ?? null;
  }

  updateStatus(txId: string, status: LedgerStatus): LedgerRecord | null {
    const record = this.store.get(txId);
    if (!record) {
      return null;
    }
    record.status = status;
    record.updatedAt = new Date().toISOString();
    this.logger.log(`Ledger row ${txId} updated -> ${status}`);
    return record;
  }
}
