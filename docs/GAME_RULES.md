# Ethiopian-style 5×5 Bingo rules

Cards use row-major indices `0..24`. Each column draws distinct integers:
B 1–15, I 16–30, N 31–45, G 46–60, O 61–75. Index 12 is the free center,
represented by `0`; all other cells must be nonzero and within their column.
Positive card numbers identify a room's deterministic card pool.

The draw is a seeded Fisher–Yates permutation of integers 1–75 with no repeats.
The API generates a 32-byte seed through its secret-source port, publishes its
SHA-256 commitment at game start, and stores the seed with AES-256-GCM encryption.
Only the runner owns the clock; the deterministic engine has no timer.

The available pattern catalogue has five rows, five columns, both diagonals,
four corners, and full house. A pattern wins exactly when every indexed cell
is free or belongs to the server's called-number set. The engine returns **all**
matching pattern IDs; room configuration selects which patterns are active.
No default rooms or live games are created.

Persisted statuses map to product statuses as follows: `LOBBY=waiting`,
`STARTING=starting`, `RUNNING=active`, `SETTLING=active`, `ENDED=finished`, and
`CANCELLED=cancelled`. `SETTLING` is an internal sub-phase of the public `active`
state. Legal persisted transitions are enforced by the repository transition table.

Claims are checked against the player's persisted card, the event-derived called
set, and the room's active patterns. By default, a false claim is recorded and
disqualifies that player for the game. Valid claims at the same draw index remain
eligible until the next draw tick; settlement treats them as simultaneous winners.
The pot is divided in integer minor units, with any remainder assigned to the
first accepted claimant. Stake collection is not implemented, so no pot is invented.

Cosmetic marking or auto-highlighting has no bearing on a winning claim.
Rewards and fees must be computed transactionally on the server. The game engine
can issue idempotent ledger prizes from a persisted non-zero pot, but stake
collection, payment providers, and payment-provider/legal policy remain out of scope.
