-- Path on an app's own backend listing the users it has already deleted, so
-- Nexus can drop their telemetry rows. Nullable: apps without it simply keep
-- their deleted users' rows until someone removes them by hand.
ALTER TABLE "App" ADD COLUMN "backendDeletedUsersPath" TEXT;
