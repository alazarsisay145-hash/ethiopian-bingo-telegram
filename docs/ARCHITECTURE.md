# Architecture

## Backend foundation and Phase 2 game services

The pure engine, Telegram HMAC verifier, persistence, and Phase 2 game lifecycle,
draw, claim, projection, settlement, and runner services are implemented behind
ports. These services are dependency-injected and do not yet make the entire
product production-ready: rooms/lobby, sessions, funded pots, admin, UI, and
deployment operations remain extension points.

## Server authority and clean layers

The web app renders facts and submits intents. It imports shared contracts, never
the engine. The API composition root connects:

1. **Domain**: authenticated identity, persistence, lease and application ports.
2. **Application**: game lifecycle, claims, draws, settlement, state projection,
   and runner coordination.
3. **Infrastructure**: Telegram verification, AES-GCM seed vault, Redis locks,
   Postgres repositories and Pino logging.
4. **Interfaces**: Fastify HTTP and Socket.IO, validation, error translation.

Imports point inward; domain/application must not import infrastructure or
transport implementations. The composition root may import all layers.
The shared package is transport-independent. The Node-only engine has no timers,
environment, database, network, or random global calls. SHA-256 via Node crypto
and a seeded PRNG make card and draw generation reproducible.

## Never trust the client

| Client input/display      | Server-owned truth and future enforcement                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| Identity                  | Verify Telegram HMAC and age; derive user ID from signed data, later issue/revoke sessions |
| Card selection number     | Authenticate membership and atomically reserve a server-generated card                     |
| Called numbers            | Single game owner advances a persisted draw sequence                                       |
| Bingo claim               | Load the owned card and called set; run engine against configured patterns                 |
| Game state/status         | State machine plus durable ordered events, never client snapshots                          |
| Cosmetic marks            | No effect on authoritative winning logic                                                   |
| Balance or payout display | Transactional ledger, server-computed amounts, idempotency keys                            |
| Admin controls            | Server RBAC and audit trail, never UI visibility                                           |
| Sequence/resync request   | Bound and authorize replay access; client cursor is only a hint                            |

Phase 1 handshakes use signed `initData` directly (five-minute validity), not
client-supplied IDs. They do not create persistent users or issue JWTs.
JWT secret configuration is reserved for the session adapter. An admin allowlist
alone does not confer implemented privileges. CORS limits browser access but is
not an identity check. HTTP rate limiting is process-local; distributed limits,
per-identity WS quotas and session revocation are later requirements.

## Persistence and single-owner orchestration

**Implemented (backend foundation):** Prisma/Postgres schema and migration
(`apps/api/prisma`), repository ports in `domain/repositories.ts`, Prisma adapters in
`infrastructure/db`, a Redis `GameOwnershipLease` with fencing tokens in
`infrastructure/redis`, and real Postgres/Redis readiness probes. Postgres is durable truth for
users, card ownership, game events and the ledger; constraints, not application checks, enforce
uniqueness, append-only history and non-negative balances. See [Data model](DATA_MODEL.md).

**Phase 2 services:** lifecycle and claim/draw operations depend on repository
and secret/lock ports; the runner acquires and heartbeats the fenced lease; the
projector folds persisted events; socket handlers enforce membership and bounded
resync. The room-level ready handler remains `NOT_FOUND` pending the room service.

**Still future:** no stake collection/unit-of-work exists, so the pot is not
automatically funded. Sessions, the rooms service, persistent profile management,
admin, UI, payments, multi-region operations, and deployment are not implemented.
These omissions prevent a production-ready release.

Only one process advances a game. The Redis lease (heartbeat + fencing token) selects the owner;
writes carrying a stale fencing token are rejected by Postgres. Persist each meaningful event
with unique `(gameId, seq)` before publishing; transactions and idempotency
keys protect reservations and payouts. Recovery replays durable events. A Redis
Socket.IO adapter and appropriate load-balancer routing are needed before
horizontal scaling; attaching Socket.IO alone is not a distributed game lock.

## Fairness

Infrastructure will generate a cryptographically strong secret seed (not a
human guessable value). Publish `SHA256(seed)` before the first draw, retain the
seed and permutation on the server, and reveal them only after settlement.
Anyone can regenerate the deterministic sequence and compare the commitment.
Commit-reveal detects changed seeds, not selective cancellation or biased seed
selection; audit retention and operating controls are also necessary.
Fixed room cards derive from an unambiguous combination of room seed and card
number; identical inputs produce identical cards.

## Reconnection and sequence discipline

Every game fact has a nonnegative safe integer `seq`, increasing monotonically
within its game stream. Room and wallet streams have their own counters.
Snapshot sequence equals its game sequence. Ignore duplicates/older events;
on gaps, stop applying partial game facts and request `state:resync`.
Snapshots may jump forward and are the only authoritative rehydration source.
On reconnect request a fresh snapshot even when there was no detected gap.
The application adapter must check membership, return a bounded replay or full
snapshot, and never expose another player's private card.

The client store is an ephemeral server-fed projection, not durable truth.
An absent wallet is unknown, never an initialized zero balance. A new game
starts a new sequence scope; stale messages from other games cannot overwrite
an active projection.

## Runtime boundaries

HTTP uses Helmet, explicit origin CORS, rate limits, request IDs and structured
errors. Unhandled errors return generic `INTERNAL`; sensitive headers and
credentials are redacted in logs. WS validates every intent after HMAC
authentication and exposes typed application handler injection.
`/healthz` is liveness; `/readyz` reports dependency status honestly.
Shutdown closes sockets and HTTP listeners. Future game owners must additionally
persist state and release leases through lifecycle adapters.
