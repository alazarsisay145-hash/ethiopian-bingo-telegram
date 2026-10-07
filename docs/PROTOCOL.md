# Protocol

Canonical validators and Socket.IO generic interfaces are exported from
`@bingo/shared`. Objects are strict: unknown intent fields are rejected.
IDs are nonempty bounded strings; numeric IDs/counters use safe integers.
Monetary values are integer minor units of ETB, never floating-point amounts.

## HTTP

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
Never send `initData` in URL query parameters or logs. Phase 1 does not issue JWTs.
Future session authentication implements the same inward-facing auth port.
Telegram's signed launch data cannot be renewed by restoring SDK state. Once it
expires, a reconnect requires reopening the Mini App to get a new launch, until
the future JWT/session flow is implemented. A previously connected socket is
not a durable or revocable session.

## Client → server intents

| Event          | Payload                  |
| -------------- | ------------------------ |
| `room:join`    | `{ roomId }`             |
| `room:leave`   | `{ roomId }`             |
| `card:select`  | `{ roomId, cardNumber }` |
| `card:release` | `{ roomId }`             |
| `game:ready`   | `{ roomId }`             |
| `game:claim`   | `{ gameId }`             |
| `state:resync` | `{ gameId, lastSeq }`    |

No intent contains a user ID, card cells, called numbers, balance or win result.
Validated intents reach typed application handlers with the authenticated
identity. Without a feature handler they receive a structured `NOT_FOUND`;
`game:ready` remains `NOT_FOUND` until the room/lobby service is implemented.
Claims derive the user id from the authenticated socket context.

## Server → client facts

| Event               | Payload                                                        |
| ------------------- | -------------------------------------------------------------- |
| `room:state`        | `{ room, playerIds, takenCardNumbers, seq }`                   |
| `game:started`      | `{ gameId, roomId, seedHash, yourCard?, drawIntervalMs, seq }` |
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

Sequences increase within a game; room and wallet events use separate scopes.
On a gap, clients stop applying game events and send `state:resync`. An
authorized snapshot replaces their projection at its reported sequence. Resync
requires game membership and replays at most 100 events; gaps or larger ranges
return a personalized snapshot instead.
