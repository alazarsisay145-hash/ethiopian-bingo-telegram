CREATE UNIQUE INDEX "games_one_active_per_room"
ON "games" ("room_id")
WHERE "status" NOT IN ('ENDED', 'CANCELLED');
