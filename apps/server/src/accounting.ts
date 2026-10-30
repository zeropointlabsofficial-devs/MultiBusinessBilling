import { Prisma } from "./generated/prisma/client.js";

export function calculatePurchaseLine(
  product: { id: string; name: string; gstRate: Prisma.Decimal },
  quantity: Prisma.Decimal,
  unitCost: Prisma.Decimal,
  discountPercent: Prisma.Decimal,
) {
  if (quantity.lte(0) || unitCost.lt(0) || discountPercent.lt(0) || discountPercent.gt(100)) {
    throw new Error("Purchase quantities, costs, and discounts are outside the allowed range.");
  }
  const gross = quantity.mul(unitCost).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const discountAmount = gross.mul(discountPercent).div(100)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const taxableValue = gross.minus(discountAmount).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const taxAmount = taxableValue.mul(product.gstRate).div(100)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return {
    productId: product.id,
    productName: product.name,
    quantity,
    unitCost,
    discountAmount,
    gstRate: product.gstRate,
    taxableValue,
    taxAmount,
    lineTotal: taxableValue.plus(taxAmount).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
    inventoryCost: taxableValue,
  };
}

export function calculateSalesReturnAmount(
  lineTotal: Prisma.Decimal,
  soldQuantity: Prisma.Decimal,
  returnQuantity: Prisma.Decimal,
) {
  if (soldQuantity.lte(0) || returnQuantity.lte(0) || returnQuantity.gt(soldQuantity)) {
    throw new Error("Return quantity must be positive and cannot exceed the sold quantity.");
  }
  return lineTotal.mul(returnQuantity).div(soldQuantity)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export function calculatePurchaseReturnAmount(
  unitCost: Prisma.Decimal,
  totalDiscount: Prisma.Decimal,
  purchasedQuantity: Prisma.Decimal,
  returnQuantity: Prisma.Decimal,
  gstRate: Prisma.Decimal,
) {
  if (purchasedQuantity.lte(0) || returnQuantity.lte(0) || returnQuantity.gt(purchasedQuantity)) {
    throw new Error("Return quantity must be positive and cannot exceed the purchased quantity.");
  }
  const amountBeforeTax = unitCost.mul(returnQuantity)
    .minus(totalDiscount.mul(returnQuantity).div(purchasedQuantity))
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return amountBeforeTax
    .plus(amountBeforeTax.mul(gstRate).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP))
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export function calculatePaymentTotal(payments: Array<{ amount: Prisma.Decimal }>) {
  return payments.reduce(
    (total, payment) => total.plus(payment.amount),
    new Prisma.Decimal(0),
  ).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}
