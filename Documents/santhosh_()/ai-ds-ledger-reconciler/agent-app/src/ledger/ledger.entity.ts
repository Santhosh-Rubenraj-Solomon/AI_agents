import { Column, Entity, PrimaryColumn } from 'typeorm';

export type LedgerStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

/**
 * The internal accounting ledger — the system of record for money movement.
 * Lives in shared Postgres, so every replica reads and heals the same rows.
 */
@Entity('ledger_records')
export class LedgerRecord {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  txId!: string;

  // Postgres `numeric` comes back as a string; parse it to a JS number on read.
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    transformer: { to: (v: number) => v, from: (v: string) => parseFloat(v) },
  })
  amount!: number;

  @Column({ type: 'varchar', length: 16 })
  status!: LedgerStatus;

  @Column({ type: 'varchar', length: 64 })
  vendor!: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
