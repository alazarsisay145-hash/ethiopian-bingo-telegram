# Data model

Source of truth: `apps/api/prisma/schema.prisma` and the SQL in
`apps/api/prisma/migrations/` (which also contains CHECK constraints and triggers that Prisma
cannot express). Tables are snake_case, ids are UUIDs, money is integer minor units (`bigint`),
timestamps are `timestamptz`. Apply with `pnpm db:migrate`.

| Table          | Purpose                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------- |
| `users`        | Telegram identity (`telegram_id` unique), role (`PLAYER/ADMIN/SUPER_ADMIN`), status       |
| `wallets`      | One per user; `balance_minor` (CHECK ≥ 0), `currency`, `version` for optimistic locking   |
| `ledger_entries` | Append-only signed money movements; unique `idempotency_key`; index `(user_id, created_at)` |
| `rooms`        | Stake, player bounds, draw interval, `active_patterns`, card pool size, secret `card_pool_seed` |
| `games`        | Status machine, seed commitment (`seed_hash`, secret `seed_encrypted`), owner, `fencing_token`, `current_seq`, pot |
| `game_players` | Card ownership: `card_number`, 25 `card_cells`; PK/unique `(game_id, user_id)`, unique `(game_id, card_number)` |
| `game_events`  | Authoritative ordered event stream; PK `(game_id, seq)`; append-only                      |
| `claims`       | Every Bingo claim with its verdict (`accepted`, `patterns`, `at_seq`)                     |
| `audit_logs`   | Admin/system audit trail with before/after JSON                                          |

## Which constraint enforces which server-authority rule

| Rule                                   | Enforcement                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| One owner per card in a game           | `UNIQUE (game_id, card_number)`; `reserveCard` is a single INSERT and maps the unique violation to `card_taken` (no read-then-write) |
| One card per user per game             | `PRIMARY KEY (game_id, user_id)`; mapped to `already_joined`                                         |
| Cards are exactly 25 cells             | `CHECK (array_length(card_cells,1) = 25)` plus server-side Zod validation; cells are only written by server code |
| Event stream is ordered and gap-free   | `PRIMARY KEY (game_id, seq)`; `append` runs `UPDATE games SET current_seq = current_seq + 1 … RETURNING` (row lock) and the INSERT in one transaction |
| Event stream cannot be rewritten       | `BEFORE UPDATE OR DELETE` trigger on `game_events` raises `restrict_violation`                       |
| Money cannot go negative               | `CHECK (balance_minor >= 0)` and `SELECT … FOR UPDATE` on the wallet before the application check (`INSUFFICIENT_FUNDS`) |
| Ledger is append-only and idempotent   | Trigger blocks UPDATE/DELETE; `UNIQUE (idempotency_key)`; replay returns the original entry, a changed replay is `CONFLICT` |
| Entry signs match their type           | Repository validation: `STAKE < 0`, `REFUND/PRIZE > 0`, `ADMIN_ADJUSTMENT` any non-zero (amount ≠ 0 by CHECK) |
| Stale game owners cannot write         | Redis lease issues strictly increasing fencing tokens; `games.fencing_token` only moves forward (`tryAcquireOwnership`), and `append`/`updateStatus` with a `GameFence` only match the current owner+token |
| Game status only moves forward         | `updateStatus` is a conditional UPDATE from the allowed source states (`GAME_STATUS_TRANSITIONS`)    |
| Seed stays secret until the game ends  | `revealSeed` only succeeds for `ENDED`/`CANCELLED`; `seed_encrypted` and `card_pool_seed` are omitted from every entity returned by the repositories |
| No orphan or cascading deletes         | All foreign keys are `ON DELETE RESTRICT` (rooms' `created_by_id` is `SET NULL`)                      |

The frontend never writes any of these tables; clients can only submit intents that server code
validates and persists.

## Redis ownership lease

`game:{<id>}:owner` holds `<instanceId>:<fencingToken>` with a TTL; `game:{<id>}:fence` is an
`INCR` counter. Acquire (atomic Lua: `SET … NX PX` + `INCR`), heartbeat (compare-and-extend) and
release (compare-and-delete) are in `infrastructure/redis/gameOwnershipLease.ts`. The lease selects
an owner; Postgres fencing is what makes stale writers harmless.

## Known limits (later phases)

- No unit-of-work: composing a stake debit with `reserveCard` in one transaction is deferred to the
  rooms/game services.
- `seed_encrypted` encryption/decryption and key management are not implemented here; the
  repository stores and returns whatever ciphertext the caller supplies.
- `games` has no uniqueness preventing multiple active games per room; the rooms service must
  enforce it.
