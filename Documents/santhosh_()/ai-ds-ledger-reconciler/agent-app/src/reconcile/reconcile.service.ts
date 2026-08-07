import { Injectable, Logger } from '@nestjs/common';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { LedgerService } from '../ledger/ledger.service';
import { ReconcileDto } from './dto/reconcile.dto';
import { buildAgentTools } from './agent.tools';

const SYSTEM_PROMPT = `You are a Fintech Audit Agent.

Your job is to reconcile differences between the company's INTERNAL DATABASE LEDGER
and an INCOMING VENDOR WEBHOOK for a single payment transaction.

Operating procedure (you may take up to 5 steps):
1. Call checkInternalLedger(txId) to fetch the current internal record.
2. Compare the internal record against the vendor webhook you were given:
   - amounts must match (small rounding within 0.01 is acceptable),
   - the vendor status must indicate the payment actually settled
     (e.g. "paid", "settled", "succeeded", "captured").
3. Decide:
   - If the amounts match AND the vendor reports a settled payment, the records
     reconcile -> call updateInternalLedger(txId, "SUCCESS", reason).
   - If the amounts MISMATCH, or the vendor reports a failure/refund/chargeback,
     the records do NOT reconcile -> call updateInternalLedger(txId, "FAILED", reason).
   - If the internal record is already SUCCESS and matches, no write is needed.
   - If the transaction is unknown internally, do NOT write; report it.
4. Finish with a concise plain-text summary of what you found and what you did.

Be decisive. Always base your decision on the data returned by the tools, never
on assumptions. Keep the final summary to 2-4 sentences.`;

@Injectable()
export class ReconcileService {
  private readonly logger = new Logger(ReconcileService.name);

  constructor(private readonly ledger: LedgerService) {}

  async reconcile(dto: ReconcileDto) {
    const tools = buildAgentTools(this.ledger, this.logger);

    const { text, steps } = await generateText({
      model: openai('gpt-4o-mini'),
      system: SYSTEM_PROMPT,
      // Let the agent loop: read the ledger, reason about the gap, then write.
      maxSteps: 5,
      tools,
      prompt:
        `An incoming vendor webhook reports the following payment:\n` +
        `${JSON.stringify(dto, null, 2)}\n\n` +
        `Reconcile it against the internal ledger and self-heal the record if appropriate.`,
    });

    // Flatten the tool calls the agent made across all reasoning steps so the
    // response is fully auditable (which tools, with which arguments).
    const toolInvocations = steps.flatMap((step) =>
      (step.toolCalls ?? []).map((call) => ({
        tool: call.toolName,
        args: call.args,
      })),
    );

    this.logger.log(
      `Reconciled ${dto.txId} in ${steps.length} step(s), ${toolInvocations.length} tool call(s)`,
    );

    return {
      txId: dto.txId,
      summary: text,
      stepsUsed: steps.length,
      toolInvocations,
      finalLedgerState: await this.ledger.get(dto.txId),
    };
  }
}
