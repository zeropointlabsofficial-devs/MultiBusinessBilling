import { describe, expect, it } from "vitest";
import { Prisma } from "../src/generated/prisma/client.js";
import { calculateInvoice } from "../src/billing.js";

const product = {
  id: "battery-1",
  name: "12V Battery",
  sku: "BAT-12",
  unit: "Piece",
  sellingPrice: new Prisma.Decimal("100.00"),
  gstRate: new Prisma.Decimal("18.00"),
};

describe("server invoice calculations", () => {
  it("calculates tax-exclusive amounts with decimal-safe rounding", () => {
    const result = calculateInvoice(new Map([[product.id, product]]), [
      { productId: product.id, quantity: "2" },
    ], false);

    expect(result.subtotal.toString()).toBe("200");
    expect(result.taxTotal.toString()).toBe("36");
    expect(result.grandTotal.toString()).toBe("236");
  });

  it("extracts tax from tax-inclusive prices", () => {
    const result = calculateInvoice(new Map([[product.id, product]]), [
      { productId: product.id, quantity: "1" },
    ], true);

    expect(result.subtotal.toString()).toBe("84.75");
    expect(result.taxTotal.toString()).toBe("15.25");
    expect(result.grandTotal.toString()).toBe("100");
  });

  it("rounds tax per line before summing", () => {
    const fractionalProduct = { ...product, sellingPrice: new Prisma.Decimal("0.05"), gstRate: new Prisma.Decimal("5") };
    const result = calculateInvoice(new Map([[product.id, fractionalProduct]]), [
      { productId: product.id, quantity: "3" },
    ], false);

    expect(result.taxTotal.toString()).toBe("0.01");
    expect(result.grandTotal.toString()).toBe("0.16");
  });

  it("applies line discounts before GST using decimal-safe rounding", () => {
    const result = calculateInvoice(new Map([[product.id, product]]), [
      { productId: product.id, quantity: "2", discountPercent: 10 },
    ], false);

    expect(result.lines[0]!.discountAmount.toString()).toBe("20");
    expect(result.subtotal.toString()).toBe("180");
    expect(result.taxTotal.toString()).toBe("32.4");
    expect(result.grandTotal.toString()).toBe("212.4");
  });

  it("applies discounts to GST-inclusive gross before extracting tax", () => {
    const result = calculateInvoice(new Map([[product.id, product]]), [
      { productId: product.id, quantity: "1", discountPercent: 10 },
    ], true);

    expect(result.lines[0]!.discountAmount.toString()).toBe("10");
    expect(result.subtotal.toString()).toBe("76.27");
    expect(result.taxTotal.toString()).toBe("13.73");
    expect(result.grandTotal.toString()).toBe("90");
  });

  it("rejects quantities that are not positive", () => {
    expect(() => calculateInvoice(new Map([[product.id, product]]), [
      { productId: product.id, quantity: "0" },
    ], false)).toThrow("greater than zero");
  });
});
