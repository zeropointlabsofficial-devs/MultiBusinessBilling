ALTER TABLE "Customer"
    ADD COLUMN "stateCode" TEXT;

ALTER TABLE "InvoiceLine"
    ADD COLUMN "hsnCode" TEXT,
    ADD COLUMN "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    ADD COLUMN "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE "BusinessSettings"
    ADD COLUMN "logoDataUrl" TEXT,
    ADD COLUMN "termsAndConditions" TEXT,
    ADD COLUMN "warrantyNote" TEXT,
    ADD COLUMN "bankDetails" TEXT,
    ADD COLUMN "authorisedSignatory" TEXT;