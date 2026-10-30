import { Prisma } from "./generated/prisma/client.js";

type ProductForSale = {
  id: string;
  name: string;
  sku: string;
  unit: string;
  sellingPrice: Prisma.Decimal;
  gstRate: Prisma.Decimal;
  hsnCode?: string | null;
};

export type RequestedLine = { productId: string; quantity: string; discountPercent?: number };

export function calculateInvoice(
  products: Map<string, ProductForSale>,
  requestedLines: RequestedLine[],
  pricesIncludeGst: boolean,
) {
  const lines = requestedLines.map((requested) => {
    const product = products.get(requested.productId);
    if (!product) throw new Error("An invoice product was not found in the selected business.");

    const quantity = new Prisma.Decimal(requested.quantity);
    if (!quantity.isFinite() || quantity.lte(0)) {
      throw new Error("Invoice quantities must be greater than zero.");
    }
    const discountPercent = new Prisma.Decimal(requested.discountPercent ?? 0);
    if (!discountPercent.isFinite() || discountPercent.lt(0) || discountPercent.gt(100)) {
      throw new Error("Invoice discounts must be from zero to one hundred percent.");
    }
    const originalGross = quantity.mul(product.sellingPrice);
    const discountAmount = originalGross.mul(discountPercent).div(100)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const gross = originalGross.minus(discountAmount);
    const rateMultiplier = new Prisma.Decimal(1).plus(product.gstRate.div(100));
    const taxableValue = (pricesIncludeGst
      ? gross.div(rateMultiplier)
      : gross).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const taxAmount = (pricesIncludeGst
      ? gross.minus(taxableValue)
      : taxableValue.mul(product.gstRate).div(100)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const lineTotal = taxableValue.plus(taxAmount).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

    return {
      productId: product.id,
      productName: product.name,
      sku: product.sku,
      hsnCode: product.hsnCode ?? null,
      unit: product.unit,
      quantity,
      unitPrice: product.sellingPrice,
      discountPercent,
      discountAmount,
      gstRate: product.gstRate,
      taxableValue,
      taxAmount,
      lineTotal,
    };
  });

  const subtotal = lines.reduce((total, line) => total.plus(line.taxableValue), new Prisma.Decimal(0))
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const taxTotal = lines.reduce((total, line) => total.plus(line.taxAmount), new Prisma.Decimal(0))
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const grandTotal = subtotal.plus(taxTotal).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return { lines, subtotal, taxTotal, grandTotal };
}
