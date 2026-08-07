import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LedgerRecord, LedgerStatus } from './ledger.entity';

/**
 * The internal ledger, backed by shared Postgres.
 *
 * This is the fix for the original prototype's seam: the ledger used to be a
 * per-replica in-memory Map, so a heal on one replica was invisible to the
 * other two. Now every replica reads and writes the same rows, so after the
 * agent heals a transaction, all replicas agree.
 */
@Injectable()
export class LedgerService implements OnModuleInit {
  private readonly logger = new Logger(LedgerService.name);

  constructor(
    @InjectRepository(LedgerRecord)
    private readonly repo: Repository<LedgerRecord>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seed();
  }

  /**
   * Seed the deliberately "drifted" demo rows once, only if the table is empty
   * (idempotent — safe to run on every replica boot):
   *   - tx_1001: PENDING, amount matches a SUCCESS webhook -> agent heals to SUCCESS
   *   - tx_1002: PENDING, amount will MISMATCH a webhook   -> agent marks FAILED
   *   - tx_1003: already SUCCESS                           -> agent no-ops
   */
  private async seed(): Promise<void> {
    const count = await this.repo.count();
    if (count > 0) return;
    const now = new Date();
    await this.repo.insert([
      { txId: 'tx_1001', amount: 100.0, status: 'PENDING', vendor: 'stripe', updatedAt: now },
      { txId: 'tx_1002', amount: 250.0, status: 'PENDING', vendor: 'adyen', updatedAt: now },
      { txId: 'tx_1003', amount: 999.0, status: 'SUCCESS', vendor: 'stripe', updatedAt: now },
    ]);
    this.logger.log('Seeded ledger with 3 drifted demo rows');
  }

  async get(txId: string): Promise<LedgerRecord | null> {
    return this.repo.findOne({ where: { txId } });
  }

  /**
   * Atomically heal a row's status via a single conditional UPDATE. Because it
   * runs against shared Postgres, the result is visible to every replica.
   * Returns the updated row, or null if the txId is unknown.
   */
  async updateStatus(txId: string, status: LedgerStatus): Promise<LedgerRecord | null> {
    const res = await this.repo.update({ txId }, { status, updatedAt: new Date() });
    if (!res.affected) return null;
    this.logger.log(`Ledger row ${txId} healed -> ${status}`);
    return this.get(txId);
  }
}
