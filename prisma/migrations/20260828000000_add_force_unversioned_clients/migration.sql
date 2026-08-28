-- Opt-in: let a force rule reach installs that report no version at all.
--
-- The version guard in VersionEngine suppresses SOFT/FORCE for any client whose
-- reported version cannot be trusted, which includes sending none. That is right
-- for a client reporting a WRONG version (it reports the same wrong version after
-- updating, so the prompt never clears), but it also strands builds whose SDK had
-- no way to read the version at all -- they can never be forced, on any rule.
--
-- Defaults false, so every existing rule keeps behaving exactly as it does today.
ALTER TABLE "VersionRule"
  ADD COLUMN "forceUnversionedClients" BOOLEAN NOT NULL DEFAULT false;
