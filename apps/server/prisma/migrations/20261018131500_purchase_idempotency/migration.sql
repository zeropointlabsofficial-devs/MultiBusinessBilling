ALTER TABLE "Purchase"
ADD COLUMN "idempotencyKey" TEXT;

UPDATE "Purchase"
SET "idempotencyKey" = 'legacy-' || "id"::text
WHERE "idempotencyKey" IS NULL;

ALTER TABLE "Purchase"
ALTER COLUMN "idempotencyKey" SET NOT NULL,
ADD COLUMN "purchaseDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "PurchaseLine"
ADD COLUMN "discountAmount" DECIMAL(12, 2) NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "Purchase_businessId_idempotencyKey_key"
ON "Purchase"("businessId", "idempotencyKey");

CREATE TABLE "PurchaseCounter" (
    "businessId" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseCounter_pkey" PRIMARY KEY ("businessId", "year")
);

ALTER TABLE "PurchaseCounter"
ADD CONSTRAINT "PurchaseCounter_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
