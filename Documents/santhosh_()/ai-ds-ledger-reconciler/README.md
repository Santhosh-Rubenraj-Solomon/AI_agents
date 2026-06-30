# AI-DS Ledger Reconciler

> **Distributed Autonomous Ledger Reconciler** — a production-shaped prototype demonstrating
> system design, distributed concurrency control, load balancing, and autonomous AI agents.

A cluster of NestJS API replicas sit behind an Nginx round-robin load balancer. Incoming
payment webhooks are deduplicated across replicas using an atomic **Redis distributed lock**,
then reconciled by an **autonomous AI agent** (OpenAI `gpt-4o-mini` via the Vercel AI SDK) that
reads the internal ledger, reasons about discrepancies, and self-heals the record using
function-calling tools.

---

## Architecture

```
                         :8080
   curl / client  ─────────────────▶  ┌───────────────┐
                                       │     Nginx     │  round-robin LB
                                       │  (resolver)   │  + X-Instance-Name passthrough
                                       └──────┬────────┘
                         ┌────────────────────┼────────────────────┐
                         ▼                     ▼                     ▼
                 ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
                 │ agent-app #1 │     │ agent-app #2 │     │ agent-app #3 │   (NestJS :3000)
                 └──────┬───────┘     └──────┬───────┘     └──────┬───────┘
                        └─────────────┬──────┴──────────────┬─────┘
                                      ▼                      ▼
                              ┌──────────────┐      ┌──────────────┐
                              │    Redis     │      │  PostgreSQL  │
                              │ (dist. lock) │      │  (optional)  │
                              └──────────────┘      └──────────────┘
```

| Concern | Implementation |
|---|---|
| **Load balancing** | Nginx, round-robin over scaled replicas via Docker DNS ([`nginx/nginx.conf`](nginx/nginx.conf)) |
| **Distributed locking** | Redis `SET NX PX` + Lua compare-and-delete ([`lock.service.ts`](agent-app/src/lock/lock.service.ts)) |
| **Concurrency guard** | NestJS guard returning `429` on lock contention ([`distributed-lock.guard.ts`](agent-app/src/lock/distributed-lock.guard.ts)) |
| **AI agent** | Vercel AI SDK `generateText` w/ `maxSteps: 5` + 2 tools ([`reconcile.service.ts`](agent-app/src/reconcile/reconcile.service.ts)) |
| **Ledger store** | In-memory mock seeded with drifted rows ([`ledger.service.ts`](agent-app/src/ledger/ledger.service.ts)) |

---

## Prerequisites

- Docker + Docker Compose
- An OpenAI API key (the reconcile endpoint calls `gpt-4o-mini`)

---

## 1. Configure & spin up the cluster

```bash
# from the repo root
export OPENAI_API_KEY="sk-...your-key..."

# Build images and start the cluster with 3 agent-app replicas behind nginx.
docker compose up --build --scale agent-app=3
```

> The `agent-app` service deliberately has **no** `container_name` and **no** published host
> port, which is what allows `--scale agent-app=3` to launch 3 identical replicas. Nginx
> round-robins across them via Docker's embedded DNS.

You should see three replicas boot, each logging a distinct hostname:

```
agent-app-1  | [Bootstrap] agent-app replica "a1b2c3d4e5f6" listening on :3000
agent-app-2  | [Bootstrap] agent-app replica "f6e5d4c3b2a1" listening on :3000
agent-app-3  | [Bootstrap] agent-app replica "0099aabbccdd" listening on :3000
```

---

## 2. Verify the load balancer (round-robin)

Hit the public port repeatedly and watch the serving `instance` rotate:

```bash
for i in $(seq 1 6); do curl -s http://localhost:8080/ ; echo; done
```

```json
{"service":"ai-ds-ledger-reconciler","instance":"a1b2c3d4e5f6","ts":"..."}
{"service":"ai-ds-ledger-reconciler","instance":"f6e5d4c3b2a1","ts":"..."}
{"service":"ai-ds-ledger-reconciler","instance":"0099aabbccdd","ts":"..."}
{"service":"ai-ds-ledger-reconciler","instance":"a1b2c3d4e5f6","ts":"..."}
...
```

Inspect the routing headers directly:

```bash
curl -si http://localhost:8080/health | grep -i -E 'x-instance-name|x-upstream-addr'
```

---

## 3. Trigger the AI reconciliation agent

```bash
curl -s -X POST http://localhost:8080/webhook/payment-reconcile \
  -H "Content-Type: application/json" \
  -d '{ "txId": "tx_1001", "amount": 100.0, "vendorStatus": "paid" }' | jq
```

Sample response — the agent looked up the ledger, saw `PENDING` with a matching amount and a
settled vendor status, and self-healed it to `SUCCESS`:

```json
{
  "txId": "tx_1001",
  "summary": "Internal ledger showed tx_1001 as PENDING for $100.00. The vendor webhook reports the same $100.00 with status 'paid', so the records reconcile. I updated the internal status to SUCCESS.",
  "stepsUsed": 2,
  "toolInvocations": [
    { "tool": "checkInternalLedger",  "args": { "txId": "tx_1001" } },
    { "tool": "updateInternalLedger", "args": { "txId": "tx_1001", "status": "SUCCESS", "reason": "amount matches and vendor settled" } }
  ],
  "finalLedgerState": { "txId": "tx_1001", "amount": 100, "status": "SUCCESS", "vendor": "stripe", "updatedAt": "..." }
}
```

Try a **mismatch** to watch the agent mark it `FAILED` instead:

```bash
curl -s -X POST http://localhost:8080/webhook/payment-reconcile \
  -H "Content-Type: application/json" \
  -d '{ "txId": "tx_1002", "amount": 9999.0, "vendorStatus": "paid" }' | jq
# internal ledger has tx_1002 at $250 -> amounts mismatch -> agent updates to FAILED
```

**Seeded ledger rows** (in [`ledger.service.ts`](agent-app/src/ledger/ledger.service.ts)):

| txId | internal amount | internal status | good test |
|---|---|---|---|
| `tx_1001` | 100.0 | PENDING | reconciles to SUCCESS |
| `tx_1002` | 250.0 | PENDING | amount mismatch → FAILED |
| `tx_1003` | 999.0 | SUCCESS | already settled → no-op |

---

## 4. Prove the distributed lock (429 on concurrent retries)

Fire the **same** `txId` many times in parallel. Exactly one acquires the Redis lock; the rest
are dropped with `429` because they would be duplicate processing across the 3 replicas:

```bash
# 10 concurrent identical webhooks -> 1x 201/200, 9x 429 (within the 10s TTL window)
seq 1 10 | xargs -P 10 -I{} curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST http://localhost:8080/webhook/payment-reconcile \
  -H "Content-Type: application/json" \
  -d '{ "txId": "tx_1001", "amount": 100.0, "vendorStatus": "paid" }'
```

```
200
429
429
429
429
429
429
429
429
429
```

In the cluster logs you'll see one replica `acquired lock for txId=tx_1001` and the others log
`DROPPED concurrent execution`.

> **Design note — TTL as idempotency window.** The lock is acquired with a 10s TTL and is *not*
> released on success, so a duplicate `txId` within 10s is rejected rather than reprocessed. The
> TTL guarantees no deadlock if a holder crashes. To allow immediate legitimate reprocessing
> instead, call `lock.release(txId, req.lockToken)` in a `finally` block (helper already provided
> in [`LockService`](agent-app/src/lock/lock.service.ts)).

---

## Project layout

```
ai-ds-ledger-reconciler/
├── docker-compose.yml          # nginx + agent-app(xN) + redis + postgres
├── nginx/nginx.conf            # round-robin LB w/ Docker DNS resolver trick
└── agent-app/                  # NestJS service
    ├── Dockerfile
    └── src/
        ├── main.ts             # bootstrap, X-Instance-Name middleware
        ├── app.module.ts
        ├── app.controller.ts   # GET / and /health (LB demo)
        ├── redis/              # shared ioredis client (global module)
        ├── lock/               # LockService + DistributedLockGuard
        ├── ledger/             # in-memory mock ledger
        └── reconcile/          # AI agent: controller, service, tools, DTO
```

## Local dev (without Docker)

```bash
cd agent-app
npm install
REDIS_HOST=localhost OPENAI_API_KEY=sk-... npm run start:dev   # needs a local redis
```
