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
| `rooms`        | Stake, player bounds, draw interval, `start_countdown_ms`, `active_patterns`, card pool size, secret `card_pool_seed` |
| `games`        | Status machine, persisted `starting_at`, seed commitment (`seed_hash`, secret `seed_encrypted`), owner, `fencing_token`, `current_seq`, pot |
| `game_players` | Card ownership: `card_number`, 25 `card_cells`; PK/unique `(game_id, user_id)`, unique `(game_id, card_number)` |
| `game_events`  | Authoritative ordered event stream; PK `(game_id, seq)`; append-only                      |
| `claims`       | One Bingo claim per game/player with its verdict (`accepted`, `patterns`, `at_seq`)          |
| `audit_logs`   | Admin/system audit trail with before/after JSON                                          |

The migration `20261007130000_unique_active_game_per_room` adds a partial
unique index on `games(room_id)` for statuses other than `ENDED` and `CANCELLED`.
This closes the race in which concurrent game creation could leave one room with
multiple active games. Product-facing statuses map to the Prisma enum; `SETTLING`
is an internal phase of public `active`.
Migration `20261007140000_lobby_countdown` adds a default 15-second room
countdown and the game's durable `starting_at` timestamp. Countdown work is
recovered by the lobby scheduler and protected by the game ownership lease.

## Which constraint enforces which server-authority rule

| Rule                                   | Enforcement                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| One owner per card in a game           | `UNIQUE (game_id, card_number)`; `reserveCard` uses `INSERT … ON CONFLICT DO NOTHING` and maps conflicts to `card_taken` |
| One card per user per game             | `PRIMARY KEY (game_id, user_id)`; mapped to `already_joined`                                         |
| One claim per player per game          | `UNIQUE (game_id, user_id)`; repeated claims are idempotent or conflict in the application           |
| Cards are exactly 25 cells             | `CHECK (array_length(card_cells,1) = 25)` plus server-side Zod validation; cells are only written by server code |
| Event stream is ordered and gap-free   | `PRIMARY KEY (game_id, seq)`; `append` runs `UPDATE games SET current_seq = current_seq + 1 … RETURNING` (row lock) and the INSERT in one transaction |
| Event stream cannot be rewritten       | `BEFORE UPDATE OR DELETE` trigger on `game_events` raises `restrict_violation`                       |
| Money cannot go negative               | `CHECK (balance_minor >= 0)` and `SELECT … FOR UPDATE` on the wallet before the application check (`INSUFFICIENT_FUNDS`) |
| Ledger is append-only and idempotent   | Trigger blocks UPDATE/DELETE; `UNIQUE (idempotency_key)`; replay returns the original entry, a changed replay is `CONFLICT` |
| Entry signs match their type           | Repository validation: `STAKE < 0`, `REFUND/PRIZE > 0`, `ADMIN_ADJUSTMENT` any non-zero (amount ≠ 0 by CHECK) |
| Stale game owners cannot write         | Redis lease issues strictly increasing fencing tokens; `games.fencing_token` only moves forward (`tryAcquireOwnership`), and `append`/`updateStatus` with a `GameFence` only match the current owner+token |
| Game status only moves forward         | `updateStatus` is a conditional UPDATE from the allowed source states (`GAME_STATUS_TRANSITIONS`)    |
| At most one non-terminal game per room | Partial unique index `games_one_active_per_room` on `room_id` while status is not terminal           |
| A draw index is appended once          | `append` locks the game row and checks the expected draw count before committing `NUMBER_CALLED`     |
| Seed stays secret until the game ends  | `revealSeed` only succeeds for `ENDED`/`CANCELLED`; `seed_encrypted` and `card_pool_seed` are omitted from every entity returned by the repositories |
| No orphan or cascading deletes         | All foreign keys are `ON DELETE RESTRICT` (rooms' `created_by_id` is `SET NULL`)                      |

The frontend never writes any of these tables; clients can only submit intents that server code
validates and persists.

## Redis ownership lease

`game:{<id>}:owner` holds `<instanceId>:<fencingToken>` with a TTL; `game:{<id>}:fence` is an
`INCR` counter. Acquire (atomic Lua: `SET … NX PX` + `INCR`), heartbeat (compare-and-extend) and
release (compare-and-delete) are in `infrastructure/redis/gameOwnershipLease.ts`. The lease selects
an owner; Postgres fencing is what makes stale writers harmless.

## Transactional lobby operations

- `UnitOfWork.withTransaction` creates a transactional repository set. Joining
  locks the game and user rows, reserves the server-generated card, applies the
  idempotent stake debit, updates the pot, appends the lobby event, and records
  audit data atomically. A failed step rolls back all earlier writes.
- Leave and cancellation apply idempotent refunds and update membership/pot in
  the same transaction. Prize ledger writes remain protected by their own
  transaction and idempotency keys.

## Known limits (later phases)

- AES-256-GCM seed encryption is implemented behind `SeedVault`; production key
  provisioning, rotation, backup and KMS integration remain operational work.
- Persistent auth sessions, payment integration, client UI, admin UI, and
  deployment/runbooks remain future work. Socket.IO user and room events use
  Redis pub/sub across API instances.
