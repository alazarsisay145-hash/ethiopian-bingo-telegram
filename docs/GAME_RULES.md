# Ethiopian-style 5×5 Bingo rules

Cards use row-major indices `0..24`. Each column draws distinct integers:
B 1–15, I 16–30, N 31–45, G 46–60, O 61–75. Index 12 is the free center,
represented by `0`; all other cells must be nonzero and within their column.
Positive card numbers identify a room's deterministic card pool.

The draw is a seeded Fisher–Yates permutation of integers 1–75 with no repeats.
No random source or timer lives inside the engine. The orchestrator will decide
draw intervals and supply a server-generated secret seed.

The available pattern catalogue has five rows, five columns, both diagonals,
four corners, and full house. A pattern wins exactly when every indexed cell
is free or belongs to the server's called-number set. The engine returns **all**
matching pattern IDs; room configuration selects which patterns are active.
No default rooms or live games are created.

Future orchestration, not the pure engine, must enforce membership, card
ownership, game status, false-claim disqualification and same-draw claim
settlement. The intended hall-style policy is false claim disqualification for
that game and splitting prizes among eligible winners in the same draw tick.
This policy is not implemented as pretend functionality in Phase 1.

Cosmetic marking or auto-highlighting has no bearing on a winning claim.
Rewards and fees must be computed transactionally on the server; this phase
does not move money or define payment-provider/legal policy.
