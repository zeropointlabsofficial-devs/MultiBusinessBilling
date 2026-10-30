ALTER TABLE "Product"
    ALTER COLUMN "gstRate" DROP NOT NULL,
    ALTER COLUMN "gstRate" DROP DEFAULT,
    ALTER COLUMN "purchasePrice" DROP NOT NULL,
    ALTER COLUMN "purchasePrice" DROP DEFAULT,
    ALTER COLUMN "sellingPrice" DROP NOT NULL;

ALTER TABLE "Product"
    ADD COLUMN "specifications" TEXT,
    ADD COLUMN "packSize" TEXT,
    ADD COLUMN "catalogSourceUrl" TEXT;

ALTER TABLE "ProductPriceHistory"
    ALTER COLUMN "oldPrice" DROP NOT NULL,
    ALTER COLUMN "newPrice" DROP NOT NULL;