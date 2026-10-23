jest.mock('ai', () => ({ ...jest.requireActual('ai'), generateText: jest.fn() }));
jest.mock('@ai-sdk/openai', () => ({ openai: jest.fn((id: string) => ({ __model: id })) }));

import { Logger } from '@nestjs/common';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { ReconcileService } from '../src/reconcile/reconcile.service';
import { buildAgentTools } from '../src/reconcile/agent.tools';
import { LedgerService } from '../src/ledger/ledger.service';

const mockedGenerateText = generateText as jest.MockedFunction<typeof generateText>;

function makeLedger() {
  return {
    get: jest.fn(),
    updateStatus: jest.fn(),
  } as unknown as jest.Mocked<LedgerService>;
}

const silentLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;

describe('buildAgentTools', () => {
  let ledger: jest.Mocked<LedgerService>;
  let tools: ReturnType<typeof buildAgentTools>;
  beforeEach(() => {
    ledger = makeLedger();
    tools = buildAgentTools(ledger, silentLogger);
  });

  it('exposes exactly the read and write tools', () => {
    expect(Object.keys(tools).sort()).toEqual(['checkInternalLedger', 'updateInternalLedger']);
  });

  it('checkInternalLedger returns found:true with the record', async () => {
    ledger.get.mockResolvedValue({ txId: 'tx_1001', amount: 100, status: 'PENDING', vendor: 'stripe' } as any);
    const out = await tools.checkInternalLedger.execute!({ txId: 'tx_1001' }, {} as any);
    expect(out).toEqual({ found: true, txId: 'tx_1001', amount: 100, status: 'PENDING', vendor: 'stripe' });
  });

  it('checkInternalLedger returns found:false for unknown tx', async () => {
    ledger.get.mockResolvedValue(null);
    await expect(tools.checkInternalLedger.execute!({ txId: 'zzz' }, {} as any)).resolves.toEqual({
      found: false,
      txId: 'zzz',
    });
  });

  it('updateInternalLedger heals the row and returns it', async () => {
    const row = { txId: 'tx_1001', status: 'SUCCESS' } as any;
    ledger.updateStatus.mockResolvedValue(row);
    const out = await tools.updateInternalLedger.execute!(
      { txId: 'tx_1001', status: 'SUCCESS', reason: 'match' },
      {} as any,
    );
    expect(ledger.updateStatus).toHaveBeenCalledWith('tx_1001', 'SUCCESS');
    expect(out).toEqual({ ok: true, record: row });
  });

  it('updateInternalLedger reports unknown tx without throwing', async () => {
    ledger.updateStatus.mockResolvedValue(null);
    await expect(
      tools.updateInternalLedger.execute!({ txId: 'nope', status: 'FAILED', reason: 'x' }, {} as any),
    ).resolves.toEqual({ ok: false, error: 'txId nope not found in ledger' });
  });

  it('zod schema only allows SUCCESS/FAILED and requires reason', () => {
    const schema = tools.updateInternalLedger.parameters as any;
    expect(schema.safeParse({ txId: 'a', status: 'SUCCESS', reason: 'r' }).success).toBe(true);
    expect(schema.safeParse({ txId: 'a', status: 'PENDING', reason: 'r' }).success).toBe(false);
    expect(schema.safeParse({ txId: 'a', status: 'FAILED' }).success).toBe(false);
    const read = tools.checkInternalLedger.parameters as any;
    expect(read.safeParse({}).success).toBe(false);
  });
});

describe('ReconcileService', () => {
  let ledger: jest.Mocked<LedgerService>;
  let svc: ReconcileService;
  const dto = { txId: 'tx_1001', amount: 100, vendorStatus: 'paid' };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    mockedGenerateText.mockReset();
    ledger = makeLedger();
    svc = new ReconcileService(ledger);
  });

  afterEach(() => jest.restoreAllMocks());

  it('drives gpt-4o-mini with tools + maxSteps 5 and returns an auditable result', async () => {
    const finalRow = { txId: 'tx_1001', amount: 100, status: 'SUCCESS', vendor: 'stripe' };
    ledger.get.mockResolvedValue(finalRow as any);
    mockedGenerateText.mockResolvedValue({
      text: 'Reconciled; marked SUCCESS.',
      steps: [
        { toolCalls: [{ toolName: 'checkInternalLedger', args: { txId: 'tx_1001' } }] },
        {
          toolCalls: [
            { toolName: 'updateInternalLedger', args: { txId: 'tx_1001', status: 'SUCCESS', reason: 'ok' } },
          ],
        },
        { toolCalls: undefined },
      ],
    } as any);

    const res = await svc.reconcile(dto);

    expect(openai).toHaveBeenCalledWith('gpt-4o-mini');
    const call = mockedGenerateText.mock.calls[0][0] as any;
    expect(call.maxSteps).toBe(5);
    expect(call.model).toEqual({ __model: 'gpt-4o-mini' });
    expect(Object.keys(call.tools).sort()).toEqual(['checkInternalLedger', 'updateInternalLedger']);
    expect(call.system).toContain('Fintech Audit Agent');
    expect(call.prompt).toContain('"txId": "tx_1001"');
    expect(call.prompt).toContain('"vendorStatus": "paid"');

    expect(res).toEqual({
      txId: 'tx_1001',
      summary: 'Reconciled; marked SUCCESS.',
      stepsUsed: 3,
      toolInvocations: [
        { tool: 'checkInternalLedger', args: { txId: 'tx_1001' } },
        { tool: 'updateInternalLedger', args: { txId: 'tx_1001', status: 'SUCCESS', reason: 'ok' } },
      ],
      finalLedgerState: finalRow,
    });
    expect(ledger.get).toHaveBeenCalledWith('tx_1001');
  });

  it('tools passed to the model are wired to the real ledger', async () => {
    ledger.updateStatus.mockResolvedValue({ txId: 'tx_1002', status: 'FAILED' } as any);
    mockedGenerateText.mockImplementation(async (args: any) => {
      await args.tools.updateInternalLedger.execute(
        { txId: 'tx_1002', status: 'FAILED', reason: 'amount mismatch' },
        {},
      );
      return { text: 'failed', steps: [] } as any;
    });
    await svc.reconcile({ txId: 'tx_1002', amount: 9999, vendorStatus: 'paid' });
    expect(ledger.updateStatus).toHaveBeenCalledWith('tx_1002', 'FAILED');
  });

  it('handles an unknown transaction (no tool writes, null final state)', async () => {
    ledger.get.mockResolvedValue(null);
    mockedGenerateText.mockResolvedValue({ text: 'Unknown tx', steps: [{ toolCalls: [] }] } as any);
    const res = await svc.reconcile({ txId: 'tx_x', amount: 1, vendorStatus: 'paid' });
    expect(res.toolInvocations).toEqual([]);
    expect(res.finalLedgerState).toBeNull();
    expect(ledger.updateStatus).not.toHaveBeenCalled();
  });

  it('propagates LLM/provider errors', async () => {
    mockedGenerateText.mockRejectedValue(new Error('401 invalid api key'));
    await expect(svc.reconcile(dto)).rejects.toThrow('401 invalid api key');
  });
});
