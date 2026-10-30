ALTER TYPE "StockMovementType"
ADD VALUE 'SALE_CANCELLATION';

ALTER TABLE "Invoice"
ADD COLUMN "cancelledById" UUID,
ADD COLUMN "cancelledAt" TIMESTAMP(3),
ADD COLUMN "cancellationReason" TEXT;

ALTER TABLE "Invoice"
ADD CONSTRAINT "Invoice_cancelledById_fkey"
FOREIGN KEY ("cancelledById") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SalesReturn"
ADD COLUMN "refundMethod" TEXT NOT NULL DEFAULT 'Unknown',
ADD COLUMN "refundTotal" DECIMAL(14, 2) NOT NULL DEFAULT 0;

ALTER TABLE "SalesReturn"
ALTER COLUMN "refundMethod" DROP DEFAULT,
ALTER COLUMN "refundTotal" DROP DEFAULT;

ALTER TABLE "PurchaseReturn"
ADD COLUMN "businessId" UUID,
ADD COLUMN "refundMethod" TEXT NOT NULL DEFAULT 'Unknown',
ADD COLUMN "refundTotal" DECIMAL(14, 2) NOT NULL DEFAULT 0;

UPDATE "PurchaseReturn" AS "returned"
SET "businessId" = "purchase"."businessId"
FROM "Purchase" AS "purchase"
WHERE "returned"."purchaseId" = "purchase"."id"
  AND "returned"."businessId" IS NULL;

ALTER TABLE "PurchaseReturn"
ALTER COLUMN "businessId" SET NOT NULL,
ALTER COLUMN "refundMethod" DROP DEFAULT,
ALTER COLUMN "refundTotal" DROP DEFAULT;

CREATE UNIQUE INDEX "PurchaseReturn_businessId_idempotencyKey_key"
ON "PurchaseReturn"("businessId", "idempotencyKey");

CREATE INDEX "PurchaseReturn_businessId_createdAt_idx"
ON "PurchaseReturn"("businessId", "createdAt");

ALTER TABLE "PurchaseReturn"
ADD CONSTRAINT "PurchaseReturn_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseReturn"
ADD CONSTRAINT "PurchaseReturn_actorId_fkey"
FOREIGN KEY ("actorId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
