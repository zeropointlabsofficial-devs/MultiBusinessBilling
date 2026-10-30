import { Prisma } from "./generated/prisma/client.js";
import { calculatePurchaseLine } from "./accounting.js";
import { prisma } from "./db.js";
import { ApiError } from "./errors.js";
import { requestHash } from "./idempotency.js";
import type { purchaseCreateSchema } from "./validation.js";
import type { z } from "zod";

type PurchaseInput = z.infer<typeof purchaseCreateSchema>;

export function purchaseRequestHash(input: PurchaseInput) {
  return requestHash({
    supplierId: input.supplierId,
    supplierInvoiceNumber: input.supplierInvoiceNumber ?? null,
    purchaseDate: input.purchaseDate ?? null,
    lines: input.lines,
  });
}

export async function finalizePurchase(input: PurchaseInput, businessId: string, actorId: string) {
  const payloadHash = purchaseRequestHash(input);
  return prisma.$transaction(async (tx) => {
    const duplicate = await tx.purchase.findUnique({
      where: { businessId_idempotencyKey: { businessId, idempotencyKey: input.idempotencyKey } },
      include: { lines: true },
    });
    if (duplicate) {
      if (duplicate.requestHash !== payloadHash) {
        throw new ApiError(409, "This idempotency key was already used for a different purchase request.");
      }
      return duplicate;
    }

    const supplier = await tx.supplier.findFirst({
      where: { id: input.supplierId, businessId },
      select: { id: true },
    });
    if (!supplier) throw new ApiError(400, "The selected supplier is not in this business.");

    const productIds = [...new Set(input.lines.map((line) => line.productId))];
    const products = await tx.product.findMany({
      where: { businessId, isActive: true, id: { in: productIds } },
      include: { inventoryBalance: true },
    });
    if (products.length !== productIds.length) {
      throw new ApiError(400, "One or more purchase products are inactive or not in this business.");
    }
    if (products.some((product) => product.gstRate === null)) {
      throw new ApiError(409, "Set a GST rate for every selected product before recording a purchase.");
    }
    for (const productId of [...productIds].sort()) {
      await tx.$queryRaw`
        SELECT "productId" FROM "InventoryBalance"
        WHERE "businessId" = ${businessId}::uuid AND "productId" = ${productId}::uuid
        FOR UPDATE
      `;
    }
    const currentProducts = await tx.product.findMany({
      where: { businessId, isActive: true, id: { in: productIds } },
      include: { inventoryBalance: true },
    });
    const productMap = new Map(currentProducts.map((product) => [product.id, product]));

    const lines = input.lines.map((line) => {
      const product = productMap.get(line.productId)!;
      if (product.gstRate === null) {
        throw new ApiError(409, "Set a GST rate for every selected product before recording a purchase.");
      }
      return calculatePurchaseLine(
        { ...product, gstRate: product.gstRate },
        new Prisma.Decimal(line.quantity),
        new Prisma.Decimal(line.unitCost),
        new Prisma.Decimal(line.discountPercent),
      );
    });
    const subtotal = lines.reduce((sum, line) => sum.plus(line.taxableValue), new Prisma.Decimal(0))
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const taxTotal = lines.reduce((sum, line) => sum.plus(line.taxAmount), new Prisma.Decimal(0))
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const grandTotal = lines.reduce((sum, line) => sum.plus(line.lineTotal), new Prisma.Decimal(0))
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

    const year = (input.purchaseDate ? new Date(input.purchaseDate) : new Date()).getUTCFullYear();
    const counter = await tx.purchaseCounter.upsert({
      where: { businessId_year: { businessId, year } },
      create: { businessId, year, lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
    });
    const purchaseNumber = `PUR-${year}-${String(counter.lastNumber).padStart(6, "0")}`;

    const purchase = await tx.purchase.create({
      data: {
        businessId,
        supplierId: input.supplierId,
        purchaseNumber,
        idempotencyKey: input.idempotencyKey,
        requestHash: payloadHash,
        supplierInvoiceNumber: input.supplierInvoiceNumber || null,
        actorId,
        purchaseDate: input.purchaseDate ? new Date(input.purchaseDate) : new Date(),
        subtotal,
        taxTotal,
        grandTotal,
        lines: {
          create: lines.map(({ inventoryCost: _inventoryCost, ...line }) => line),
        },
      },
      include: { lines: true },
    });

    const receivedByProduct = new Map<string, {
      quantity: Prisma.Decimal;
      cost: Prisma.Decimal;
    }>();
    for (const line of lines) {
      const aggregate = receivedByProduct.get(line.productId) ?? {
        quantity: new Prisma.Decimal(0),
        cost: new Prisma.Decimal(0),
      };
      aggregate.quantity = aggregate.quantity.plus(line.quantity);
      aggregate.cost = aggregate.cost.plus(line.inventoryCost);
      receivedByProduct.set(line.productId, aggregate);
    }

    for (const [productId, receipt] of receivedByProduct) {
      const product = productMap.get(productId)!;
      const previousQuantity = product.inventoryBalance?.quantity ?? new Prisma.Decimal(0);
      const nextQuantity = previousQuantity.plus(receipt.quantity);
      const averageCost = product.purchasePrice === null
        ? previousQuantity.isZero()
          ? receipt.cost.div(nextQuantity).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
          : null
        : previousQuantity.mul(product.purchasePrice).plus(receipt.cost)
          .div(nextQuantity)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      await tx.inventoryBalance.upsert({
        where: { businessId_productId: { businessId, productId } },
        create: { businessId, productId, quantity: receipt.quantity },
        update: { quantity: { increment: receipt.quantity } },
      });
      await tx.product.update({
        where: { id: productId },
        data: { purchasePrice: averageCost },
      });
    }

    await tx.stockMovement.createMany({
      data: [...receivedByProduct].map(([productId, receipt]) => ({
        businessId,
        productId,
        actorId,
        quantityChange: receipt.quantity,
        type: "PURCHASE",
        reference: purchaseNumber,
      })),
    });
    await tx.auditLog.create({
      data: {
        actorId,
        businessId,
        action: "purchase.finalized",
        entityType: "Purchase",
        entityId: purchase.id,
        details: {
          purchaseNumber,
          supplierId: input.supplierId,
          subtotal: subtotal.toString(),
          taxTotal: taxTotal.toString(),
          grandTotal: grandTotal.toString(),
        },
      },
    });
    return purchase;
  });
}

export function purchaseResponse(purchase: Awaited<ReturnType<typeof finalizePurchase>>) {
  return {
    id: purchase.id,
    purchaseNumber: purchase.purchaseNumber,
    supplierInvoiceNumber: purchase.supplierInvoiceNumber,
    status: purchase.status,
    purchaseDate: purchase.purchaseDate,
    subtotal: purchase.subtotal.toString(),
    taxTotal: purchase.taxTotal.toString(),
    grandTotal: purchase.grandTotal.toString(),
    lines: purchase.lines.map((line) => ({
      productId: line.productId,
      productName: line.productName,
      quantity: line.quantity.toString(),
      unitCost: line.unitCost.toString(),
      discountAmount: line.discountAmount.toString(),
      gstRate: line.gstRate.toString(),
      taxableValue: line.taxableValue.toString(),
      taxAmount: line.taxAmount.toString(),
      lineTotal: line.lineTotal.toString(),
    })),
  };
}
