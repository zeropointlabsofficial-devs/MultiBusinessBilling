ALTER TABLE "Invoice"
ADD COLUMN "requestHash" TEXT;

UPDATE "Invoice"
SET "requestHash" = 'legacy:' || "id"::text
WHERE "requestHash" IS NULL;

ALTER TABLE "Invoice"
ALTER COLUMN "requestHash" SET NOT NULL;

ALTER TABLE "Purchase"
ADD COLUMN "requestHash" TEXT;

UPDATE "Purchase"
SET "requestHash" = 'legacy:' || "id"::text
WHERE "requestHash" IS NULL;

ALTER TABLE "Purchase"
ALTER COLUMN "requestHash" SET NOT NULL;

ALTER TABLE "SalesReturn"
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "requestHash" TEXT;

UPDATE "SalesReturn"
SET "idempotencyKey" = 'legacy-' || "id"::text,
    "requestHash" = 'legacy:' || "id"::text
WHERE "idempotencyKey" IS NULL OR "requestHash" IS NULL;

ALTER TABLE "SalesReturn"
ALTER COLUMN "idempotencyKey" SET NOT NULL,
ALTER COLUMN "requestHash" SET NOT NULL;

CREATE UNIQUE INDEX "SalesReturn_businessId_idempotencyKey_key"
ON "SalesReturn"("businessId", "idempotencyKey");

ALTER TABLE "PurchaseReturn"
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "requestHash" TEXT;

UPDATE "PurchaseReturn"
SET "idempotencyKey" = 'legacy-' || "id"::text,
    "requestHash" = 'legacy:' || "id"::text
WHERE "idempotencyKey" IS NULL OR "requestHash" IS NULL;

ALTER TABLE "PurchaseReturn"
ALTER COLUMN "idempotencyKey" SET NOT NULL,
ALTER COLUMN "requestHash" SET NOT NULL;
