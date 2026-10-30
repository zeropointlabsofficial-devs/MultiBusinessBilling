import { describe, expect, it } from "vitest";
import { catalogSeedProducts } from "../prisma/catalog-seed-data.js";

describe("verified catalog seed data", () => {
  it("uses unique stable SKUs within each business", () => {
    const keys = catalogSeedProducts.map((product) => `${product.businessName}\u0000${product.sku}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("contains only supported businesses and manufacturer source URLs", () => {
    const businesses = new Set(catalogSeedProducts.map((product) => product.businessName));
    expect(businesses).toEqual(new Set([
      "ARJUNA AGENCY",
      "SANTHOSH AUTOMOBILES",
      "ARJUNA ENTERPRISES",
    ]));
    expect(catalogSeedProducts.every((product) => product.sourceUrl.startsWith("https://"))).toBe(true);
  });

  it("does not seed commercial amounts, GST, barcodes, or stock", () => {
    expect(catalogSeedProducts.every((product) =>
      !("purchasePrice" in product) &&
      !("sellingPrice" in product) &&
      !("gstRate" in product) &&
      !("barcode" in product) &&
      !("stockQuantity" in product),
    )).toBe(true);
  });
});