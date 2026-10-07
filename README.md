# Ethiopian Bingo — Telegram Mini App

Server-authoritative 5×5 Bingo backend. It includes deterministic game rules,
Telegram handshake verification, persisted users, authenticated room/game APIs,
transactional stakes and card reservations, lobby countdown, admin authorization,
rate limits, and the Phase 2 draw/claim/settlement services. JWT sessions,
payments, visual UI, admin UI, and deployment hardening are not implemented;
this project is **not yet production-ready**.

## Prerequisites and setup

- Node 20 (`nvm use`), Corepack, pnpm 10.34.5.
- Docker Compose v2 for optional local Postgres 16 / Redis 7.
- A Telegram bot token and HTTPS Mini App URL for testing inside Telegram.

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
# Fill BOT_TOKEN, JWT_SECRET, DATABASE_URL, REDIS_URL, and (for production
# games) a 32-byte hex SEED_ENCRYPTION_KEY. JWT sessions are not issued yet.
# For docker:dev, also set a local POSTGRES_PASSWORD.
pnpm dev
```

Vite serves the web shell on port 5173; the API defaults to port 3001. The root
`.env` is loaded for local development. Only `VITE_` variables enter the browser.
Outside Telegram, the web app displays **Open this app inside Telegram**.
The browser gate is UX, not authentication: only server HMAC verification establishes identity.
Register your HTTPS web URL with BotFather, configure `CORS_ORIGINS` to its exact
origin, and expose the API over HTTPS/WSS in production.

```sh
pnpm docker:dev        # Postgres 16 + Redis 7 (needs POSTGRES_PASSWORD in .env)
# Set DATABASE_URL and REDIS_URL in .env (see .env.example), then:
pnpm db:migrate        # prisma migrate deploy: applies committed migrations
pnpm db:seed           # development rooms only; never run for production
pnpm dev
curl http://127.0.0.1:3001/healthz
curl -i http://127.0.0.1:3001/readyz
```

`/readyz` runs real probes (`SELECT 1` on Postgres, `PING` on Redis) for each configured
URL: `available`, `unavailable`, or `not_configured`. Schema changes during development:
`pnpm db:migrate:dev` (creates a migration), `pnpm db:studio` (browse data). See
[Data model](docs/DATA_MODEL.md).

## Scripts

| Command              | Purpose                                              |
| -------------------- | ---------------------------------------------------- |
| `pnpm dev`           | Build shared packages, watch API, serve web          |
| `pnpm lint`          | ESLint, including engine/layer boundary restrictions |
| `pnpm typecheck`     | Strict TypeScript checks                             |
| `pnpm test`          | All Vitest unit and transport integration tests      |
| `pnpm test:coverage` | V8 coverage reports per tested package               |
| `pnpm build`         | Dependency-ordered production builds                 |
| `pnpm format`        | Prettier                                             |
| `pnpm clean`         | Remove builds, coverage, Turbo caches                |
| `pnpm docker:dev`    | Local Postgres and Redis, loopback ports only        |
| `pnpm db:migrate`    | Apply committed Prisma migrations (`migrate deploy`) |
| `pnpm db:migrate:dev`| Create/apply a development migration                 |
| `pnpm db:generate`   | Generate the Prisma client                           |
| `pnpm db:studio`     | Prisma Studio                                        |
| `pnpm db:seed`       | Seed two development rooms (refuses `NODE_ENV=production`) |
| `pnpm test:integration` | Postgres/Redis Testcontainers suites (needs Docker) |

Tests use synthetic Telegram signatures, Fastify inject, and actual loopback
Socket.IO connections, without needing a bot token, DB, or Redis. Repository, ledger, lease and
probe tests live in `*.int.test.ts` and run with `pnpm --filter @bingo/api test:integration`
against disposable Testcontainers (Docker required; they are skipped with a message if Docker
is unavailable).

## Structure

```text
apps/api          config, domain ports, application services, infrastructure,
                  HTTP/WS interfaces, composition root
apps/web          Telegram-gated React shell, typed clients, server-fed store
packages/shared   Zod schemas, DTOs, constants, errors, socket catalogue
packages/engine   Deterministic card/draw generation and win verification
packages/config   Strict TypeScript, ESLint and Prettier presets
infra/docker      API multi-stage image and local dependency containers
docs              Architecture, game rules, protocol
```

See [Architecture](docs/ARCHITECTURE.md), [Data model](docs/DATA_MODEL.md), [Game rules](docs/GAME_RULES.md), and
[Protocol](docs/PROTOCOL.md).

## Production build

Set public `VITE_API_BASE_URL` and `VITE_SOCKET_URL` before `pnpm build`; deploy
`apps/web/dist` to a static HTTPS host. Never put credentials in these variables.

```sh
docker build -f infra/docker/Dockerfile.api -t bingo-api .
docker run --rm --env-file .env -e NODE_ENV=production -e HOST=0.0.0.0 \
  -p 3001:3001 bingo-api
# Apply migrations (one-off, same image):
docker run --rm --env-file .env bingo-api node_modules/.bin/prisma migrate deploy
```

The API image runs as a non-root user. Supply secrets at runtime, terminate TLS
upstream, and preserve the default non-trusting proxy configuration unless
trusted proxy boundaries are explicitly established.

### Dependency security deviation

The requested Fastify 4 and Vite 5 majors have no patches for current advisories.
This foundation uses Fastify **5.12.5** and Vite **6.4.3**, the compatible patched
replacements, while retaining Node 20, React 18, Socket.IO 4 and TypeScript 5.
Review dependencies regularly; Node 20 and Telegram SDK ecosystem support must
also be reevaluated before production deployment.

## Roadmap

| Phase | Scope                                                                        |
| ----- | ---------------------------------------------------------------------------- |
| 1     | Foundation (this project): engine, shared contracts, API/web shells, tooling |
| 2     | Postgres repositories, Redis fencing, game orchestration services             |
| 2.1   | Lifecycle, claim, concurrency, runner failover and real-service test hardening |
| 3     | Player APIs, room/game lifecycle, transactional stakes, admin RBAC, rate limits |
| 4     | Telegram auth sessions, JWT refresh/revocation, richer profile/history         |
| 5     | Mini App lobby/game/result/profile UI                                          |
| 6     | Payment providers and operational wallet funding                               |
| 7     | Deployment, monitoring, multi-region hardening and runbooks                     |
