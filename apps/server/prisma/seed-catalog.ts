import "dotenv/config";
import { prisma } from "../src/db.js";
import { catalogSeedProducts } from "./catalog-seed-data.js";

async function main() {
  const businessNames = [...new Set(catalogSeedProducts.map((product) => product.businessName))];
  const businesses = await prisma.business.findMany({
    where: { name: { in: businessNames }, isActive: true },
    select: { id: true, name: true },
  });
  const businessIds = new Map(businesses.map(({ id, name }) => [name, id]));
  const missingBusinesses = businessNames.filter((name) => !businessIds.has(name));
  if (missingBusinesses.length > 0) {
    throw new Error(`Catalog import requires existing active businesses: ${missingBusinesses.join(", ")}`);
  }

  const counts = new Map(businessNames.map((name) => [name, { inserted: 0, preserved: 0 }]));
  await prisma.$transaction(async (tx) => {
    for (const businessId of [...businessIds.values()].sort()) {
      await tx.$queryRaw`SELECT "id" FROM "Business" WHERE "id" = ${businessId}::uuid FOR UPDATE`;
    }
    for (const product of catalogSeedProducts) {
      const businessId = businessIds.get(product.businessName)!;
      const where = { businessId_sku: { businessId, sku: product.sku } };
      const existing = await tx.product.findUnique({ where });
      const sameCatalogItem = existing ?? await tx.product.findFirst({
        where: {
          businessId,
          brand: { equals: product.brand, mode: "insensitive" },
          model: { equals: product.model, mode: "insensitive" },
          packSize: product.packSize ?? null,
        },
      });
      if (sameCatalogItem) {
        counts.get(product.businessName)!.preserved += 1;
        continue;
      }
      await tx.product.upsert({
        where,
        create: {
          businessId,
          sku: product.sku,
          name: product.name,
          brand: product.brand,
          model: product.model,
          category: product.category,
          specifications: product.specifications,
          packSize: product.packSize ?? null,
          catalogSourceUrl: product.sourceUrl,
          gstRate: null,
          purchasePrice: null,
          sellingPrice: null,
        },
        update: {},
      });
      await tx.auditLog.create({
        data: {
          actorId: (await tx.userBusinessRole.findFirstOrThrow({
            where: { businessId, role: "SYSTEM_ADMIN", user: { isActive: true } },
            select: { userId: true },
          })).userId,
          businessId,
          action: "product.catalog_seeded",
          entityType: "Product",
          entityId: (await tx.product.findUniqueOrThrow({ where })).id,
          details: { sku: product.sku, sourceUrl: product.sourceUrl },
        },
      });
      counts.get(product.businessName)!.inserted += 1;
    }
  });

  for (const [businessName, count] of counts) {
    console.info(`${businessName}: ${count.inserted} inserted; ${count.preserved} existing products preserved.`);
  }
  console.info("Catalog import does not set prices, GST, barcodes, or inventory balances.");
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Catalog import failed.");
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());