# Phase 4 — Telegram Mini App authentication

This phase secures the existing backend only. It does not add payments, visual
UI, JWT sessions, or deployment operations, and is **not a production-ready
release**.

## Flow and layer boundaries

1. The Mini App obtains Telegram's original `WebApp.initData`, not independently
   supplied user fields or `initDataUnsafe`.
2. HTTP sends `Authorization: tma <initData>`; Socket.IO sends
   `auth: { initData }` on every new connection. The legacy
   `X-Telegram-Init-Data` HTTP header remains supported.
3. The infrastructure verifier rejects oversized/malformed query encoding and
   duplicate fields. It removes `hash`, sorts decoded `key=value` pairs by key,
   joins them with newlines, and computes:

   ```text
   secret_key = HMAC_SHA256(key="WebAppData", data=TELEGRAM_BOT_TOKEN)
   expected   = HMAC_SHA256(key=secret_key, data=data_check_string)
   ```

   The supplied hash must be exactly 64 lowercase hexadecimal characters.
   Equal-length buffers are compared with `crypto.timingSafeEqual`.
4. The signed integer `auth_date` must be within the configured age/skew policy.
   Tests inject the clock. Only the signed, validated `user` JSON establishes
   Telegram identity; other launch fields are signed too.
5. The users repository atomically upserts by unique `telegram_id`, creating a
   `PLAYER` and zero-balance wallet on first login. An allowlisted
   `ADMIN_TELEGRAM_IDS` identity instead receives `ADMIN` only on creation,
   with an audit record. Concurrent launches resolve to one user/wallet.
6. Returning users retain their internal ID, role, status, and balance. Only
   present username/name/language/photo fields and `lastSeenAt` are updated.
   Banned and suspended users cannot authenticate.
7. The inward-facing auth port returns a typed `AuthContext`, attached as
   `request.auth` and `socket.data.auth`. It contains `userId`, `telegramId`,
   `role`, `status`, `authDate` (Unix seconds), and `verifiedAt` (Unix
   milliseconds), never raw launch data or a bot token.
8. HTTP/socket guards authorize server-derived identity and database membership.
   Admin routes inherit a role guard at plugin scope. Socket intents recheck
   account availability against the database. Snapshots, card lookup, and Bingo
   claims use the authenticated owner's internal ID only.

Domain/application code depends on ports, not Fastify, Socket.IO, or Prisma.
The composition root supplies the real adapters; no development authentication
bypass exists.

## Configuration

| Variable | Default / policy |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Required; server-only. Production never accepts the legacy `BOT_TOKEN` alias. |
| `TELEGRAM_INITDATA_MAX_AGE_SECONDS` | `3600`, positive integer seconds |
| `TELEGRAM_INITDATA_CLOCK_SKEW_SECONDS` | `30`, nonnegative integer seconds |
| `TELEGRAM_INITDATA_MAX_BYTES` | `16384`, positive integer UTF-8 bytes |
| `ADMIN_TELEGRAM_IDS` | Empty; comma-separated positive safe integer Telegram IDs |
| `HTTP_RATE_LIMIT_MAX` / `HTTP_RATE_LIMIT_WINDOW_MS` | `100` / `60000`; shared Redis request/authentication budgets |
| `WS_RATE_LIMIT_WINDOW_MS` | `10000`; existing per-user intent budgets |

One hour is intentionally stricter than 24 hours: launch data is a replayable
bearer credential, and this bounds the theft/replay window while permitting a
normal game session. Use HTTPS/WSS, synchronize server clocks, and keep secrets
in runtime environment provisioning, never `VITE_` variables. Changing the
policy affects subsequent verifications; it is not JWT refresh or revocation.
Production configuration requires `TELEGRAM_BOT_TOKEN`; the legacy `BOT_TOKEN`
name is accepted only outside production for compatibility, not as a bypass.

## Threat model and abuse controls

- **Tampering/forgery:** every launch field contributes to the HMAC; changing
  user ID, username, timestamp, or another field invalidates it.
- **Identity substitution:** independently supplied IDs/usernames never
  establish identity. Mismatches are rejected; strict route/intent schemas
  reject unsupported fields. Admin user-management target IDs remain protected
  resources, not caller identity.
- **Authorization:** role/status come from Postgres, not signed profile claims.
  Persisted memberships authorize private games/cards/resync. Neither another
  user's cells nor secret game seeds are included in personalized snapshots.
  Existing room card pools are reused across games: prior owners may remember
  their own previous card's cells. Owner-only endpoints prevent new unauthorized
  reads, but cannot erase previously learned cards. Pool rotation is deferred
  because changing engine/card-pool behavior is outside this phase.
- **Abuse:** Redis-backed IP authentication budgets apply before credential
  processing. After HMAC verification and signed user parsing, a shared
  Telegram-ID budget also counts failures from expired proofs and inactive
  accounts before freshness checks or profile writes. These conservative
  budgets count successful attempts too, alongside database-user request
  budgets and existing per-intent limits. Unsigned/invalid-signature failures
  have no trusted identity and consume only IP budgets, never a client-nominated
  user's budget.
- **Information leakage:** stable shared error codes, generic messages, no
  stacks, no raw launch data in contexts. Pino redacts credential/configuration
  fields and strips query strings from request URLs. Request bodies and errors
  are not logged with their untrusted contents.
- **Replay:** valid launch data may be reused within its lifetime. HMAC does not
  prove possession by a particular device. TLS, bounded age, and rate limits
  mitigate but do not eliminate theft. No nonce cache is added: single-use
  launch data would break normal HTTP calls and reconnects without a separate
  session exchange. JWT/session issuance, refresh, revocation, and incident
  response remain future work.
- **Connected sockets:** reconnection requires fresh verification; already
  connected sockets are not durable sessions. Account restrictions are
  rechecked on intents, but a ban does not currently disconnect sockets or stop
  their existing outbound subscriptions. Cross-instance disconnect/revocation
  is deferred session/infrastructure work; do not treat inbound guards as
  immediate stream revocation. Clients must re-open Telegram's Mini App when
  launch data expires, then reconnect and request `state:resync`.

Proxy IP trust is deliberately not enabled globally. Configure trusted proxy
boundaries carefully before deployment; otherwise attackers could forge
forwarded IPs to evade shared counters.

## Stable errors

HTTP returns `{ error: { code, message, requestId } }`; Socket.IO handshake
rejection uses `connect_error.data.code`. Intent errors use the existing
acknowledgement/error-event contract from [Protocol](PROTOCOL.md).

| Code | HTTP | Meaning |
| --- | --- | --- |
| `UNAUTHORIZED` | 401 | Missing, malformed, tampered, invalid-signature, or expired launch data |
| `FORBIDDEN` | 403 | Banned/suspended account, identity mismatch, missing role or membership |
| `NOT_FOUND` | 404 | Unavailable/private resource without leaking another owner's card |
| `RATE_LIMITED` | 429 | Shared authentication/request/intent budget exhausted; back off |
| `VALIDATION_ERROR` | 400 | Authenticated request/intent has unsupported or malformed fields |
| `INTERNAL` | 500 | Generic unexpected server failure, without stack or secrets |

Credential failures deliberately do not reveal which signed field failed.

## Security review and scope

The Phase 4 review covers signature verification, strict parsing/freshness,
identity binding, route/socket authorization and future admin registration,
card/resync leakage, captured Pino output, Redis abuse limits, replay policy,
environment validation, and dependency surface.

Fixed: uppercase/noncanonical hash acceptance, hardcoded launch policy,
non-persisted identity fallback, missing typed auth context, absent last-seen
updates, clearing omitted profile fields, missing suspension handling,
independent identity claims, unrestricted room card-cell previews, and
per-route-only admin protection. Tests exercise signed tampering, expiry
boundaries, HTTP/socket failures, profile preservation, mapping, role bootstrap,
owner-only cards, and authenticated reconnect/resync. Real persistence tests
use the existing disposable Postgres/Redis Testcontainers harness.

No new dependencies are required. Secret scanning and automated code/security
review are part of validation; execution results are reported in the PR.
Deferred deliberately: single-use launch tokens, persistent/revocable sessions,
external security audit, payment/KYC/legal requirements, UI/admin UI, TLS and
secret provisioning, operational alerts/backups, and deployment hardening.
