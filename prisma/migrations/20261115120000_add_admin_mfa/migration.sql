-- Authenticator (TOTP) step-up for console changes.
ALTER TABLE "Admin" ADD COLUMN "mfaSecret" TEXT;
ALTER TABLE "Admin" ADD COLUMN "mfaEnabledAt" TIMESTAMP(3);
ALTER TABLE "Admin" ADD COLUMN "mfaLastStep" INTEGER;
