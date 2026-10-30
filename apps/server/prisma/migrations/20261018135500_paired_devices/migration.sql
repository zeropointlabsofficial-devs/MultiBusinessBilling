CREATE TYPE "PairedDeviceStatus" AS ENUM ('PENDING', 'APPROVED', 'REVOKED');

CREATE TABLE "PairingInvitation" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "redeemedDeviceId" UUID,

    CONSTRAINT "PairingInvitation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PairedDevice" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "credentialHash" TEXT NOT NULL,
    "pollTokenHash" TEXT NOT NULL,
    "pairingExpiresAt" TIMESTAMP(3) NOT NULL,
    "status" "PairedDeviceStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "approvedById" UUID,
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "PairedDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PairingInvitation_tokenHash_key" ON "PairingInvitation"("tokenHash");
CREATE INDEX "PairingInvitation_businessId_expiresAt_idx" ON "PairingInvitation"("businessId", "expiresAt");
CREATE UNIQUE INDEX "PairedDevice_deviceId_key" ON "PairedDevice"("deviceId");
CREATE UNIQUE INDEX "PairedDevice_credentialHash_key" ON "PairedDevice"("credentialHash");
CREATE INDEX "PairedDevice_businessId_status_createdAt_idx" ON "PairedDevice"("businessId", "status", "createdAt");
CREATE INDEX "PairedDevice_pairingExpiresAt_idx" ON "PairedDevice"("pairingExpiresAt");

ALTER TABLE "PairingInvitation"
ADD CONSTRAINT "PairingInvitation_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PairingInvitation"
ADD CONSTRAINT "PairingInvitation_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PairedDevice"
ADD CONSTRAINT "PairedDevice_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PairedDevice"
ADD CONSTRAINT "PairedDevice_approvedById_fkey"
FOREIGN KEY ("approvedById") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
