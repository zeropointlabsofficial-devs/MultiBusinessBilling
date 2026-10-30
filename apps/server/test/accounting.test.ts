import { describe, expect, it } from "vitest";
import { Prisma } from "../src/generated/prisma/client.js";
import {
  calculatePaymentTotal,
  calculatePurchaseLine,
  calculatePurchaseReturnAmount,
  calculateSalesReturnAmount,
} from "../src/accounting.js";

describe("purchase and return accounting", () => {
  it("applies purchase discounts before GST using decimal rounding", () => {
    const line = calculatePurchaseLine(
      { id: "p1", name: "Oil", gstRate: new Prisma.Decimal("18") },
      new Prisma.Decimal("2"),
      new Prisma.Decimal("100"),
      new Prisma.Decimal("10"),
    );
    expect(line.discountAmount.toString()).toBe("20");
    expect(line.taxableValue.toString()).toBe("180");
    expect(line.taxAmount.toString()).toBe("32.4");
    expect(line.lineTotal.toString()).toBe("212.4");
    expect(line.inventoryCost.toString()).toBe("180");
  });

  it("calculates a partial sale refund at the historical invoice line price", () => {
    expect(calculateSalesReturnAmount(
      new Prisma.Decimal("118"),
      new Prisma.Decimal("2"),
      new Prisma.Decimal("1"),
    ).toString()).toBe("59");
  });

  it("returns the proportionate purchase cost, discount, and GST", () => {
    expect(calculatePurchaseReturnAmount(
      new Prisma.Decimal("100"),
      new Prisma.Decimal("20"),
      new Prisma.Decimal("2"),
      new Prisma.Decimal("1"),
      new Prisma.Decimal("18"),
    ).toString()).toBe("106.2");
  });

  it("sums split payments without binary floating point", () => {
    expect(calculatePaymentTotal([
      { amount: new Prisma.Decimal("0.10") },
      { amount: new Prisma.Decimal("0.20") },
    ]).toString()).toBe("0.3");
  });

  it("rejects a return amount greater than the original line quantity", () => {
    expect(() => calculateSalesReturnAmount(
      new Prisma.Decimal("100"),
      new Prisma.Decimal("1"),
      new Prisma.Decimal("2"),
    )).toThrow("cannot exceed the sold quantity");
  });
});
