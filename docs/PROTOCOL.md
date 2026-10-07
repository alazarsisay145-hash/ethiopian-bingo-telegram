# Protocol

Canonical validators and Socket.IO generic interfaces are exported from
`@bingo/shared`. Objects are strict: unknown intent fields are rejected.
Socket IDs are nonempty bounded strings; HTTP resource IDs are UUIDs. Numeric
IDs/counters use safe integers.
Monetary values are integer minor units of ETB, never floating-point amounts.

## HTTP

- Player routes are under `/api/v1` and require `Authorization: tma <initData>`
  containing Telegram's original URL-encoded signed init data. The legacy
  `X-Telegram-Init-Data` header is also supported; conflicting credentials are
  rejected. The server verifies it and resolves the
  persisted user, role, and status; client-supplied identities are never used.
  Missing/invalid data returns 401 `UNAUTHORIZED`; banned accounts return 403
  `FORBIDDEN` (also for suspended accounts). Admin routes additionally require a database `ADMIN` or
  `SUPER_ADMIN` role.
- Player routes: `GET /rooms`, `GET /rooms/:roomId`,
  `GET /rooms/:roomId/cards/:cardNumber`, `POST /rooms/:roomId/games`,
  `GET /games?status=waiting|active`, `GET /games/:gameId`,
  `POST /games/:gameId/join` (`{ cardNumber }`), `POST /games/:gameId/leave`,
  `GET /games/:gameId/card`, `GET /games/:gameId/players`,
  `POST /games/:gameId/claim`, `GET /games/:gameId/results`,
  `GET /me`, `GET /me/wallet`, and `GET /me/games`.
- Admin routes manage rooms and users, and can start or cancel a game. **No HTTP
  route or socket intent draws numbers**; only the fenced server `GameRunner`
  calls the draw service. Request objects are strict Zod schemas; unknown fields
  are rejected.
- HTTP rate limits are applied by authenticated user ID as well as the global
  IP fallback. WebSocket intents have per-user/event limits. Redis stores the
  shared production counters.
- Do not send independent `userId`, `telegramId`, or `username` identity claims
  in headers, query strings, bodies, or handshake auth. They never establish
  identity, and mismatches with the authenticated identity are rejected.
  Admin user-management path IDs are authorized target resources, not the
  administrator's identity.
- Room card-cell access is owner-only, not an unrestricted preview of other
  players' cards. Game/card reads and resync return only the recipient's card.
- `GET /healthz`: liveness.
- `GET /readyz`: dependency statuses. Absent URLs report `not_configured`;
  configured URLs without operational adapters report `unavailable`, not `ok`.
- Errors: `{ error: { code, message, details?, requestId } }`.
  Zod failures return 400 `VALIDATION_ERROR`; unknown errors return 500
  `INTERNAL` with a generic message. No stack traces reach clients.

## Socket handshake

Connect with `auth: { initData }`, where `initData` is Telegram's original signed
query string. HMAC, signed user schema and timestamp checks execute server-side.
Missing, tampered or expired credentials reject connection with `UNAUTHORIZED`.
Never send `initData` in URL query parameters or logs. Phase 4 does not issue JWTs.
Future session authentication implements the same inward-facing auth port.
Telegram's signed launch data cannot be renewed by restoring SDK state. Once it
expires, a reconnect requires reopening the Mini App to get a new launch, until
the future JWT/session flow is implemented. A previously connected socket is
not a durable or revocable session.

The defaults are a 3,600-second maximum age, 30-second future clock skew, and a
16,384-byte UTF-8 limit, configurable with `TELEGRAM_INITDATA_*` environment
variables documented in [Authentication](AUTHENTICATION.md). The exact maximum
age boundary is accepted; later reuse fails even if the original connection
was successful. On reconnect, present the original launch data again; the server
re-verifies it, reloads role/status, and rejoins active persisted room/game
channels. Request `state:resync` after every successful reconnect. On 401 or
`connect_error.data.code === "UNAUTHORIZED"` caused by expiry, reopen the Mini
App to obtain fresh `initData`; do not change `auth_date` or endlessly retry the
expired credential. `FORBIDDEN` requires account/permission resolution,
and `RATE_LIMITED` requires backing off.

## Client → server intents

| Event          | Payload                  |
| -------------- | ------------------------ |
| `room:join`    | `{ roomId }`             |
| `room:leave`   | `{ roomId }`             |
| `card:select`  | `{ roomId, cardNumber }` |
| `card:release` | `{ roomId }`             |
| `game:ready`   | `{ roomId }`             |
| `game:claim`   | `{ gameId }`             |
| `state:resync` | `{ gameId?, lastSeq? }` |

No intent contains a user ID, card cells, called numbers, balance or win result.
Validated intents reach application handlers with the authenticated persisted
identity. `room:join/leave`, `card:select/release`, `game:ready`, `game:claim`,
and resync are implemented. `game:ready` only reports the current countdown; it
never starts a game. A missing `gameId` in resync restores all of the user's
active games. Claims derive the user id from the authenticated socket context.

## Server → client facts

| Event               | Payload                                                        |
| ------------------- | -------------------------------------------------------------- |
| `room:state`        | `{ room, playerIds, takenCardNumbers, seq }`                   |
| `game:started`      | `{ gameId, roomId, seedHash, yourCard?, drawIntervalMs, seq }` |
| `game:starting`     | `{ gameId, startsAt, seq }`                                |
| `game:number`       | `{ gameId, number, calledNumbers, seq }`                       |
| `game:claim_result` | `{ gameId, userId, accepted, patterns, seq }`                  |
| `game:ended`        | `{ gameId, winnerIds, seedRevealed, drawSequence, seq }`       |
| `wallet:update`     | `{ balanceMinor, currency: "ETB", seq }`                       |
| `state:snapshot`    | `{ game, seq }`                                                |
| `error`             | `{ error: { code, message, details?, requestId } }`            |

Game state uses `waiting | starting | active | finished | cancelled`; the
internal `SETTLING` database phase is represented as `active`. State includes
`gameId, roomId, status, seq, calledNumbers`, optional `seedHash`, player
statuses/winner IDs, and only the authenticated recipient's optional card. It
never includes unrevealed seeds,
future draw numbers, or other players' private cards.
The ended event reveals the entire 75-number permutation for fairness checks.
Payout/ledger DTOs will be added with the wallet phase, not fabricated here.

Game sequences increase within a game; room and wallet events use separate scopes.
On a gap, clients stop applying game events and send `state:resync`. An
authorized snapshot replaces their projection at its reported sequence. Resync
requires game membership and replays at most 100 events; gaps or larger ranges
return a personalized snapshot instead.

Stake debit, card reservation, pot update and event append share one database
transaction. Leaving a waiting/starting game and cancellation refund through
idempotent ledger entries in a transaction. Card previews are generated from
the server-only room seed; only a member receives their private card.
