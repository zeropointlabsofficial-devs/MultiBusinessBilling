import { Prisma } from "./generated/prisma/client.js";
import { calculatePurchaseReturnAmount, calculateSalesReturnAmount } from "./accounting.js";
import { prisma } from "./db.js";
import { ApiError } from "./errors.js";
import { requestHash } from "./idempotency.js";
import type { purchaseReturnSchema, salesReturnSchema } from "./validation.js";
import type { z } from "zod";

type SalesReturnInput = z.infer<typeof salesReturnSchema>;
type PurchaseReturnInput = z.infer<typeof purchaseReturnSchema>;

export function salesReturnRequestHash(invoiceId: string, input: SalesReturnInput) {
  return requestHash({ invoiceId, reason: input.reason, refundMethod: input.refundMethod, lines: input.lines });
}

export function purchaseReturnRequestHash(purchaseId: string, input: PurchaseReturnInput) {
  return requestHash({ purchaseId, reason: input.reason, refundMethod: input.refundMethod, lines: input.lines });
}

async function lockInvoice(tx: Prisma.TransactionClient, businessId: string, invoiceId: string) {
  await tx.$queryRaw`
    SELECT "id" FROM "Invoice"
    WHERE "id" = ${invoiceId}::uuid AND "businessId" = ${businessId}::uuid
    FOR UPDATE
  `;
}

async function lockPurchase(tx: Prisma.TransactionClient, businessId: string, purchaseId: string) {
  await tx.$queryRaw`
    SELECT "id" FROM "Purchase"
    WHERE "id" = ${purchaseId}::uuid AND "businessId" = ${businessId}::uuid
    FOR UPDATE
  `;
}

export async function returnSale(
  invoiceId: string,
  input: SalesReturnInput,
  businessId: string,
  actorId: string,
) {
  const payloadHash = salesReturnRequestHash(invoiceId, input);
  return prisma.$transaction(async (tx) => {
    const duplicate = await tx.salesReturn.findUnique({
      where: { businessId_idempotencyKey: { businessId, idempotencyKey: input.idempotencyKey } },
      include: { lines: true },
    });
    if (duplicate) {
      if (duplicate.requestHash !== payloadHash) {
        throw new ApiError(409, "This idempotency key was already used for a different sales return.");
      }
      return duplicate;
    }

    await lockInvoice(tx, businessId, invoiceId);
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, businessId },
      include: { lines: true },
    });
    if (!invoice || invoice.status !== "FINALIZED") {
      throw new ApiError(404, "A finalized invoice in this business was not found.");
    }

    const returnedBefore = await tx.salesReturnLine.findMany({
      where: { salesReturn: { invoiceId, businessId } },
      select: { invoiceLineId: true, quantity: true },
    });
    const returnedByLine = new Map<string, Prisma.Decimal>();
    for (const returned of returnedBefore) {
      returnedByLine.set(
        returned.invoiceLineId,
        (returnedByLine.get(returned.invoiceLineId) ?? new Prisma.Decimal(0)).plus(returned.quantity),
      );
    }
    const invoiceLines = new Map(invoice.lines.map((line) => [line.id, line]));
    const prepared = input.lines.map((requested) => {
      const line = invoiceLines.get(requested.invoiceLineId);
      if (!line) throw new ApiError(400, "A return line does not belong to this invoice.");
      const quantity = new Prisma.Decimal(requested.quantity);
      const remaining = line.quantity.minus(returnedByLine.get(line.id) ?? new Prisma.Decimal(0));
      if (quantity.gt(remaining)) {
        throw new ApiError(409, `Return quantity exceeds remaining sold quantity for ${line.productName}.`);
      }
      const refundAmount = calculateSalesReturnAmount(line.lineTotal, line.quantity, quantity);
      return { line, quantity, refundAmount, returnToStock: requested.returnToStock };
    });
    const refundTotal = prepared.reduce((sum, line) => sum.plus(line.refundAmount), new Prisma.Decimal(0))
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

    const salesReturn = await tx.salesReturn.create({
      data: {
        businessId,
        invoiceId,
        actorId,
        idempotencyKey: input.idempotencyKey,
        requestHash: payloadHash,
        reason: input.reason,
        refundMethod: input.refundMethod,
        refundTotal,
        lines: {
          create: prepared.map((line) => ({
            invoiceLineId: line.line.id,
            quantity: line.quantity,
            refundAmount: line.refundAmount,
            returnToStock: line.returnToStock,
          })),
        },
      },
      include: { lines: true },
    });

    const stockReturning = prepared.filter((line) => line.returnToStock);
    for (const returned of stockReturning) {
      await tx.inventoryBalance.upsert({
        where: { businessId_productId: { businessId, productId: returned.line.productId } },
        create: { businessId, productId: returned.line.productId, quantity: returned.quantity },
        update: { quantity: { increment: returned.quantity } },
      });
      await tx.stockMovement.create({
        data: {
          businessId,
          productId: returned.line.productId,
          actorId,
          quantityChange: returned.quantity,
          type: "SALES_RETURN",
          reference: salesReturn.id,
          reason: input.reason,
        },
      });
    }
    await tx.auditLog.create({
      data: {
        actorId,
        businessId,
        action: "sales_return.created",
        entityType: "SalesReturn",
        entityId: salesReturn.id,
        details: { invoiceId, reason: input.reason, refundTotal: refundTotal.toString() },
      },
    });
    return salesReturn;
  });
}

export async function returnPurchase(
  purchaseId: string,
  input: PurchaseReturnInput,
  businessId: string,
  actorId: string,
) {
  const payloadHash = purchaseReturnRequestHash(purchaseId, input);
  return prisma.$transaction(async (tx) => {
    const duplicate = await tx.purchaseReturn.findUnique({
      where: { businessId_idempotencyKey: { businessId, idempotencyKey: input.idempotencyKey } },
      include: { lines: true },
    });
    if (duplicate) {
      if (duplicate.requestHash !== payloadHash) {
        throw new ApiError(409, "This idempotency key was already used for a different purchase return.");
      }
      return duplicate;
    }

    await lockPurchase(tx, businessId, purchaseId);
    const purchase = await tx.purchase.findFirst({
      where: { id: purchaseId, businessId, status: "RECEIVED" },
      include: { lines: true },
    });
    if (!purchase) throw new ApiError(404, "A received purchase in this business was not found.");

    const returnedBefore = await tx.purchaseReturnLine.findMany({
      where: { purchaseReturn: { purchaseId, businessId } },
      select: { purchaseLineId: true, quantity: true },
    });
    const returnedByLine = new Map<string, Prisma.Decimal>();
    for (const returned of returnedBefore) {
      returnedByLine.set(
        returned.purchaseLineId,
        (returnedByLine.get(returned.purchaseLineId) ?? new Prisma.Decimal(0)).plus(returned.quantity),
      );
    }
    const purchaseLines = new Map(purchase.lines.map((line) => [line.id, line]));
    const prepared = input.lines.map((requested) => {
      const line = purchaseLines.get(requested.purchaseLineId);
      if (!line) throw new ApiError(400, "A return line does not belong to this purchase.");
      const quantity = new Prisma.Decimal(requested.quantity);
      const remaining = line.quantity.minus(returnedByLine.get(line.id) ?? new Prisma.Decimal(0));
      if (quantity.gt(remaining)) {
        throw new ApiError(409, `Return quantity exceeds remaining purchased quantity for ${line.productName}.`);
      }
      const refundAmount = calculatePurchaseReturnAmount(
        line.unitCost,
        line.discountAmount,
        line.quantity,
        quantity,
        line.gstRate,
      );
      return { line, quantity, refundAmount };
    });
    const refundTotal = prepared.reduce((sum, line) => sum.plus(line.refundAmount), new Prisma.Decimal(0))
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

    const purchaseReturn = await tx.purchaseReturn.create({
      data: {
        businessId,
        purchaseId,
        actorId,
        idempotencyKey: input.idempotencyKey,
        requestHash: payloadHash,
        reason: input.reason,
        refundMethod: input.refundMethod,
        refundTotal,
        lines: {
          create: prepared.map((line) => ({
            purchaseLineId: line.line.id,
            quantity: line.quantity,
            refundAmount: line.refundAmount,
          })),
        },
      },
      include: { lines: true },
    });

    const quantityByProduct = new Map<string, Prisma.Decimal>();
    for (const line of prepared) {
      quantityByProduct.set(
        line.line.productId,
        (quantityByProduct.get(line.line.productId) ?? new Prisma.Decimal(0)).plus(line.quantity),
      );
    }
    for (const [productId, quantity] of quantityByProduct) {
      const changed = await tx.inventoryBalance.updateMany({
        where: { businessId, productId, quantity: { gte: quantity } },
        data: { quantity: { decrement: quantity } },
      });
      if (changed.count !== 1) {
        throw new ApiError(409, "The purchase return would reduce current stock below zero.");
      }
      await tx.stockMovement.create({
        data: {
          businessId,
          productId,
          actorId,
          quantityChange: quantity.negated(),
          type: "PURCHASE_RETURN",
          reference: purchaseReturn.id,
          reason: input.reason,
        },
      });
    }
    await tx.auditLog.create({
      data: {
        actorId,
        businessId,
        action: "purchase_return.created",
        entityType: "PurchaseReturn",
        entityId: purchaseReturn.id,
        details: { purchaseId, reason: input.reason, refundTotal: refundTotal.toString() },
      },
    });
    return purchaseReturn;
  });
}

export async function cancelInvoice(invoiceId: string, reason: string, businessId: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    await lockInvoice(tx, businessId, invoiceId);
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, businessId },
      include: { lines: true },
    });
    if (!invoice || invoice.status !== "FINALIZED") {
      throw new ApiError(404, "A finalized invoice in this business was not found.");
    }
    const returnCount = await tx.salesReturn.count({ where: { invoiceId, businessId } });
    if (returnCount > 0) {
      throw new ApiError(409, "An invoice with processed returns cannot be cancelled; use a return adjustment instead.");
    }
    const cancelled = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledById: actorId,
        cancellationReason: reason,
      },
    });
    for (const line of invoice.lines) {
      await tx.inventoryBalance.upsert({
        where: { businessId_productId: { businessId, productId: line.productId } },
        create: { businessId, productId: line.productId, quantity: line.quantity },
        update: { quantity: { increment: line.quantity } },
      });
      await tx.stockMovement.create({
        data: {
          businessId,
          productId: line.productId,
          actorId,
          quantityChange: line.quantity,
          type: "SALE_CANCELLATION",
          reference: invoice.invoiceNumber,
          reason,
        },
      });
    }
    await tx.auditLog.create({
      data: {
        actorId,
        businessId,
        action: "invoice.cancelled",
        entityType: "Invoice",
        entityId: invoiceId,
        details: { invoiceNumber: invoice.invoiceNumber, reason },
      },
    });
    return cancelled;
  });
}
