import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { LedgerService } from '../ledger/ledger.service';

/**
 * Builds the schema-validated tools (OpenAI function-calling) the agent may
 * invoke. Each tool's `parameters` is a zod schema, so the SDK validates the
 * model's arguments before our `execute` ever runs.
 */
export function buildAgentTools(ledger: LedgerService, logger: Logger) {
  return {
    /** READ: fetch the internal ledger's current view of a transaction. */
    checkInternalLedger: tool({
      description:
        'Look up the current internal ledger record for a transaction id. ' +
        'Returns the stored amount, status (PENDING/SUCCESS/FAILED) and vendor, ' +
        'or found:false if the transaction is unknown.',
      parameters: z.object({
        txId: z.string().describe('The transaction id to look up, e.g. "tx_1001".'),
      }),
      execute: async ({ txId }) => {
        const record = await ledger.get(txId);
        logger.log(`[tool] checkInternalLedger(${txId}) -> ${JSON.stringify(record)}`);
        return record ? { found: true, ...record } : { found: false, txId };
      },
    }),

    /** WRITE: self-heal the ledger once the agent has validated the states. */
    updateInternalLedger: tool({
      description:
        'Update the internal ledger status for a transaction to SUCCESS or FAILED. ' +
        'Call this ONLY after comparing the internal record against the vendor webhook.',
      parameters: z.object({
        txId: z.string().describe('The transaction id to update.'),
        status: z
          .enum(['SUCCESS', 'FAILED'])
          .describe('SUCCESS if internal and vendor states reconcile; FAILED otherwise.'),
        reason: z
          .string()
          .describe('A short justification for the decision (logged for audit).'),
      }),
      execute: async ({ txId, status, reason }) => {
        const updated = await ledger.updateStatus(txId, status);
        logger.log(`[tool] updateInternalLedger(${txId}, ${status}) reason="${reason}"`);
        return updated
          ? { ok: true, record: updated }
          : { ok: false, error: `txId ${txId} not found in ledger` };
      },
    }),
  };
}
