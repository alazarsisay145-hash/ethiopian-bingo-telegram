ALTER TABLE "rooms"
  ADD COLUMN "start_countdown_ms" INTEGER NOT NULL DEFAULT 15000;

ALTER TABLE "games"
  ADD COLUMN "starting_at" TIMESTAMPTZ(3);

ALTER TABLE "rooms"
  ADD CONSTRAINT "rooms_start_countdown_range"
  CHECK ("start_countdown_ms" BETWEEN 1000 AND 60000);
