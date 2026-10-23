import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getMetadataArgsStorage } from 'typeorm';
import { LedgerService } from '../src/ledger/ledger.service';
import { LedgerRecord } from '../src/ledger/ledger.entity';

describe('LedgerService', () => {
  let repo: { count: jest.Mock; insert: jest.Mock; findOne: jest.Mock; update: jest.Mock };
  let svc: LedgerService;

  beforeEach(async () => {
    repo = {
      count: jest.fn().mockResolvedValue(0),
      insert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const mod = await Test.createTestingModule({
      providers: [LedgerService, { provide: getRepositoryToken(LedgerRecord), useValue: repo }],
    }).compile();
    svc = mod.get(LedgerService);
  });

  describe('seeding (onModuleInit)', () => {
    it('inserts the three demo rows when the table is empty', async () => {
      await svc.onModuleInit();
      expect(repo.insert).toHaveBeenCalledTimes(1);
      const rows = repo.insert.mock.calls[0][0];
      expect(rows.map((r: any) => [r.txId, r.amount, r.status, r.vendor])).toEqual([
        ['tx_1001', 100, 'PENDING', 'stripe'],
        ['tx_1002', 250, 'PENDING', 'adyen'],
        ['tx_1003', 999, 'SUCCESS', 'stripe'],
      ]);
      rows.forEach((r: any) => expect(r.updatedAt).toBeInstanceOf(Date));
    });

    it('is idempotent: skips seeding when rows already exist', async () => {
      repo.count.mockResolvedValue(3);
      await svc.onModuleInit();
      expect(repo.insert).not.toHaveBeenCalled();
    });
  });

  it('get() looks up by txId', async () => {
    const row = { txId: 'tx_1001', amount: 100, status: 'PENDING' };
    repo.findOne.mockResolvedValue(row);
    await expect(svc.get('tx_1001')).resolves.toBe(row);
    expect(repo.findOne).toHaveBeenCalledWith({ where: { txId: 'tx_1001' } });
  });

  it('get() returns null for an unknown txId', async () => {
    await expect(svc.get('nope')).resolves.toBeNull();
  });

  it('updateStatus() performs a conditional UPDATE and returns the fresh row', async () => {
    const healed = { txId: 'tx_1001', status: 'SUCCESS' };
    repo.findOne.mockResolvedValue(healed);
    await expect(svc.updateStatus('tx_1001', 'SUCCESS')).resolves.toBe(healed);
    expect(repo.update).toHaveBeenCalledWith(
      { txId: 'tx_1001' },
      { status: 'SUCCESS', updatedAt: expect.any(Date) },
    );
  });

  it.each([{ affected: 0 }, { affected: undefined }])(
    'updateStatus() returns null when no row matched (%o)',
    async (res) => {
      repo.update.mockResolvedValue(res);
      await expect(svc.updateStatus('nope', 'FAILED')).resolves.toBeNull();
      expect(repo.findOne).not.toHaveBeenCalled();
    },
  );
});

describe('LedgerRecord entity', () => {
  const cols = getMetadataArgsStorage().columns.filter((c) => c.target === LedgerRecord);

  it('maps to the ledger_records table with txId as primary key', () => {
    const table = getMetadataArgsStorage().tables.find((t) => t.target === LedgerRecord);
    expect(table?.name).toBe('ledger_records');
    expect(cols.find((c) => c.propertyName === 'txId')?.mode).toBe('regular');
    expect(cols.find((c) => c.propertyName === 'txId')?.options.primary).toBe(true);
  });

  it('parses Postgres numeric strings back into JS numbers', () => {
    const amount = cols.find((c) => c.propertyName === 'amount')!;
    const t = amount.options.transformer as { to: (v: any) => any; from: (v: any) => any };
    expect(amount.options.type).toBe('numeric');
    expect(t.from('100.50')).toBe(100.5);
    expect(t.to(42)).toBe(42);
  });
});
