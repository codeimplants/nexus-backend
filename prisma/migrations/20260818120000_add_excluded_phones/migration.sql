-- Phones to hide from Engagement and Leads (internal test handsets, CI devices,
-- staff accounts). Empty array default so existing apps are unaffected.
ALTER TABLE "App" ADD COLUMN "excludedPhones" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
