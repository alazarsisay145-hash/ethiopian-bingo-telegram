-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('PLAYER', 'ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'BANNED');

-- CreateEnum
CREATE TYPE "ledger_entry_type" AS ENUM ('STAKE', 'REFUND', 'PRIZE', 'ADMIN_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "room_status" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "game_status" AS ENUM ('LOBBY', 'STARTING', 'RUNNING', 'SETTLING', 'ENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "game_player_status" AS ENUM ('ACTIVE', 'DISQUALIFIED', 'WINNER');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "telegram_id" BIGINT NOT NULL,
    "username" TEXT,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT,
    "photo_url" TEXT,
    "language_code" TEXT,
    "role" "user_role" NOT NULL DEFAULT 'PLAYER',
    "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "user_id" UUID NOT NULL,
    "balance_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'ETB',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "ledger_entry_type" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "balance_after_minor" BIGINT NOT NULL,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "stake_minor" BIGINT NOT NULL,
    "min_players" INTEGER NOT NULL,
    "max_players" INTEGER NOT NULL,
    "draw_interval_ms" INTEGER NOT NULL,
    "active_patterns" TEXT[],
    "card_pool_size" INTEGER NOT NULL,
    "card_pool_seed" TEXT NOT NULL,
    "status" "room_status" NOT NULL DEFAULT 'OPEN',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "status" "game_status" NOT NULL DEFAULT 'LOBBY',
    "seed_hash" TEXT,
    "seed_encrypted" TEXT,
    "seed_revealed_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "owner_instance_id" TEXT,
    "fencing_token" BIGINT NOT NULL DEFAULT 0,
    "current_seq" INTEGER NOT NULL DEFAULT 0,
    "pot_minor" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_players" (
    "game_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "card_number" INTEGER NOT NULL,
    "card_cells" INTEGER[],
    "status" "game_player_status" NOT NULL DEFAULT 'ACTIVE',
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_players_pkey" PRIMARY KEY ("game_id","user_id")
);

-- CreateTable
CREATE TABLE "game_events" (
    "game_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_events_pkey" PRIMARY KEY ("game_id","seq")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "at_seq" INTEGER NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "patterns" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_id_key" ON "users"("telegram_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_idempotency_key_key" ON "ledger_entries"("idempotency_key");

-- CreateIndex
CREATE INDEX "ledger_entries_user_id_created_at_idx" ON "ledger_entries"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "games_room_id_status_idx" ON "games"("room_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "game_players_game_id_card_number_key" ON "game_players"("game_id", "card_number");

-- CreateIndex
CREATE INDEX "claims_game_id_created_at_idx" ON "claims"("game_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_idx" ON "audit_logs"("target_type", "target_id");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_events" ADD CONSTRAINT "game_events_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Invariants that Prisma cannot express declaratively.
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_balance_non_negative" CHECK ("balance_minor" >= 0);
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_version_non_negative" CHECK ("version" >= 0);
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_balance_after_non_negative" CHECK ("balance_after_minor" >= 0);
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_amount_non_zero" CHECK ("amount_minor" <> 0);
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_stake_non_negative" CHECK ("stake_minor" >= 0);
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_players_bounds" CHECK ("min_players" >= 1 AND "max_players" >= "min_players");
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_draw_interval_positive" CHECK ("draw_interval_ms" > 0);
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_card_pool_size_positive" CHECK ("card_pool_size" > 0);
ALTER TABLE "games" ADD CONSTRAINT "games_current_seq_non_negative" CHECK ("current_seq" >= 0);
ALTER TABLE "games" ADD CONSTRAINT "games_fencing_token_non_negative" CHECK ("fencing_token" >= 0);
ALTER TABLE "games" ADD CONSTRAINT "games_pot_non_negative" CHECK ("pot_minor" >= 0);
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_card_cells_length" CHECK (array_length("card_cells", 1) = 25);
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_card_number_positive" CHECK ("card_number" >= 1);
ALTER TABLE "game_events" ADD CONSTRAINT "game_events_seq_positive" CHECK ("seq" >= 1);

-- Append-only tables: the event stream and the ledger can never be rewritten.
CREATE FUNCTION "reject_row_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "game_events_append_only" BEFORE UPDATE OR DELETE ON "game_events"
  FOR EACH ROW EXECUTE FUNCTION "reject_row_mutation"();
CREATE TRIGGER "ledger_entries_append_only" BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "reject_row_mutation"();
