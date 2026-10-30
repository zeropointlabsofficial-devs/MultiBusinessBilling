import { Prisma } from "./generated/prisma/client.js";
import { calculatePaymentTotal } from "./accounting.js";
import { prisma } from "./db.js";
import { calculateInvoice } from "./billing.js";
import { ApiError } from "./errors.js";
import { requestHash } from "./idempotency.js";
import type { invoiceCreateSchema, invoicePreviewSchema } from "./validation.js";
import type { z } from "zod";

type InvoiceInput = z.infer<typeof invoiceCreateSchema>;
type InvoicePreviewInput = z.infer<typeof invoicePreviewSchema>;

export function invoiceRequestHash(input: InvoiceInput) {
  return requestHash({
    customerId: input.customerId ?? null,
    lines: input.lines.map(({ discountPercent, ...line }) => ({
      ...line,
      ...(discountPercent ? { discountPercent } : {}),
    })),
    payments: input.payments,
  });
}

export async function previewInvoice(input: InvoicePreviewInput, businessId: string) {
  const settings = await prisma.businessSettings.findUnique({ where: { businessId } });
  if (!settings || settings.pricesIncludeGst === null) {
    throw new ApiError(409, "Configure the business tax-pricing mode before billing.");
  }
  if (input.customerId) {
    const customer = await prisma.customer.findFirst({
      where: { id: input.customerId, businessId },
      select: { id: true },
    });
    if (!customer) throw new ApiError(400, "The selected customer is not in this business.");
  }
  const productIds = [...new Set(input.lines.map((line) => line.productId))];
  const products = await prisma.product.findMany({
    where: { businessId, isActive: true, id: { in: productIds } },
    include: { inventoryBalance: true },
  });
  if (products.length !== productIds.length) {
    throw new ApiError(400, "One or more products are inactive or not in this business.");
  }
  const productMap = new Map(products.map((product) => {
    const sellingPrice = product.sellingPrice;
    const gstRate = product.gstRate;
    if (sellingPrice === null || gstRate === null) {
      throw new ApiError(409, "Set a selling price and GST rate for every selected product before billing.");
    }
    return [product.id, { ...product, sellingPrice, gstRate }] as const;
  }));
  const totals = calculateInvoice(productMap, input.lines, settings.pricesIncludeGst);
  const requestedByProduct = new Map<string, Prisma.Decimal>();
  for (const line of input.lines) {
    const previous = requestedByProduct.get(line.productId) ?? new Prisma.Decimal(0);
    requestedByProduct.set(line.productId, previous.plus(line.quantity));
  }
  for (const [productId, quantity] of requestedByProduct) {
    const product = productMap.get(productId)!;
    const available = product.inventoryBalance?.quantity ?? new Prisma.Decimal(0);
    if (available.lt(quantity)) {
      throw new ApiError(409, `Insufficient stock for ${product.name}. Available: ${available.toString()}.`);
    }
  }
  return {
    pricesIncludeGst: settings.pricesIncludeGst,
    lines: totals.lines.map((line) => ({
      productId: line.productId,
      productName: line.productName,
      sku: line.sku,
      hsnCode: line.hsnCode,
      unit: line.unit,
      quantity: line.quantity.toString(),
      unitPrice: line.unitPrice.toString(),
      discountPercent: line.discountPercent.toString(),
      discountAmount: line.discountAmount.toString(),
      gstRate: line.gstRate.toString(),
      taxableValue: line.taxableValue.toString(),
      taxAmount: line.taxAmount.toString(),
      lineTotal: line.lineTotal.toString(),
    })),
    subtotal: totals.subtotal.toString(),
    taxTotal: totals.taxTotal.toString(),
    grandTotal: totals.grandTotal.toString(),
  };
}

export async function finalizeInvoice(
  input: InvoiceInput,
  businessId: string,
  actorId: string,
) {
  const payloadHash = invoiceRequestHash(input);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.invoice.findUnique({
      where: { businessId_idempotencyKey: { businessId, idempotencyKey: input.idempotencyKey } },
      include: { lines: true, payments: true },
    });
    if (existing) {
      if (existing.requestHash !== payloadHash) {
        throw new ApiError(409, "This idempotency key was already used for a different invoice request.");
      }
      return existing;
    }

    const settings = await tx.businessSettings.findUnique({ where: { businessId } });
    if (!settings || settings.pricesIncludeGst === null) {
      throw new ApiError(409, "Configure the business tax-pricing mode before billing.");
    }

    if (input.customerId) {
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, businessId },
        select: { id: true },
      });
      if (!customer) throw new ApiError(400, "The selected customer is not in this business.");
    }

    const productIds = [...new Set(input.lines.map((line) => line.productId))];
    const products = await tx.product.findMany({
      where: { businessId, isActive: true, id: { in: productIds } },
    });
    if (products.length !== productIds.length) {
      throw new ApiError(400, "One or more products are inactive or not in this business.");
    }
    const productMap = new Map(products.map((product) => {
      const sellingPrice = product.sellingPrice;
      const gstRate = product.gstRate;
      if (sellingPrice === null || gstRate === null) {
        throw new ApiError(409, "Set a selling price and GST rate for every selected product before billing.");
      }
      return [product.id, { ...product, sellingPrice, gstRate }] as const;
    }));
    for (const line of input.lines) {
      if (line.expectedUnitPrice !== undefined &&
          !productMap.get(line.productId)!.sellingPrice.equals(line.expectedUnitPrice)) {
        throw new ApiError(409, "A product price changed after the bill was reviewed. Refresh the total before finalizing.");
      }
    }
    const totals = calculateInvoice(productMap, input.lines, settings.pricesIncludeGst);

    const requiredByProduct = new Map<string, Prisma.Decimal>();
    for (const line of input.lines) {
      const previous = requiredByProduct.get(line.productId) ?? new Prisma.Decimal(0);
      requiredByProduct.set(line.productId, previous.plus(line.quantity));
    }

    const paymentTotal = calculatePaymentTotal(
      input.payments.map((payment) => ({ amount: new Prisma.Decimal(payment.amount) })),
    );
    if (paymentTotal.gt(totals.grandTotal) || (!settings.allowCredit && !paymentTotal.equals(totals.grandTotal))) {
      throw new ApiError(400, "Payments must equal the invoice total, unless credit sales are enabled.");
    }

    const year = new Date().getUTCFullYear();
    const counter = await tx.invoiceCounter.upsert({
      where: { businessId_year: { businessId, year } },
      create: { businessId, year, lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
    });
    const invoiceNumber = `${settings.invoicePrefix}-${year}-${String(counter.lastNumber).padStart(6, "0")}`;

    for (const productId of [...requiredByProduct.keys()].sort()) {
      const quantity = requiredByProduct.get(productId)!;
      const stockChange = await tx.inventoryBalance.updateMany({
        where: { businessId, productId, quantity: { gte: quantity } },
        data: { quantity: { decrement: quantity } },
      });
      if (stockChange.count !== 1) {
        const balance = await tx.inventoryBalance.findUnique({
          where: { businessId_productId: { businessId, productId } },
          select: { quantity: true },
        });
        const product = productMap.get(productId)!;
        throw new ApiError(
          409,
          `Insufficient stock for ${product.name}. Available: ${balance?.quantity.toString() ?? "0"}.`,
        );
      }
    }

    const invoice = await tx.invoice.create({
      data: {
        businessId,
        invoiceNumber,
        idempotencyKey: input.idempotencyKey,
        requestHash: payloadHash,
        customerId: input.customerId ?? null,
        actorId,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        grandTotal: totals.grandTotal,
        lines: {
          create: totals.lines.map((line) => ({
            productId: line.productId,
            productName: line.productName,
            sku: line.sku,
            hsnCode: line.hsnCode,
            unit: line.unit,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discountPercent: line.discountPercent,
            discountAmount: line.discountAmount,
            gstRate: line.gstRate,
            taxableValue: line.taxableValue,
            taxAmount: line.taxAmount,
            lineTotal: line.lineTotal,
          })),
        },
        payments: {
          create: input.payments.map((payment) => ({
            method: payment.method,
            amount: new Prisma.Decimal(payment.amount),
          })),
        },
      },
      include: { lines: true, payments: true },
    });

    await tx.stockMovement.createMany({
      data: [...requiredByProduct].map(([productId, quantity]) => ({
        businessId,
        productId,
        actorId,
        quantityChange: quantity.negated(),
        type: "SALE",
        reference: invoice.invoiceNumber,
      })),
    });
    await tx.auditLog.create({
      data: {
        actorId,
        businessId,
        action: "invoice.finalized",
        entityType: "Invoice",
        entityId: invoice.id,
        details: {
          invoiceNumber: invoice.invoiceNumber,
          subtotal: totals.subtotal.toString(),
          taxTotal: totals.taxTotal.toString(),
          grandTotal: totals.grandTotal.toString(),
        },
      },
    });
    return invoice;
  });
}

export function invoiceResponse(invoice: Awaited<ReturnType<typeof finalizeInvoice>>) {
  const received = invoice.payments.reduce(
    (total, payment) => total.plus(payment.amount),
    new Prisma.Decimal(0),
  );
  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    cancellationReason: invoice.cancellationReason,
    cancelledAt: invoice.cancelledAt,
    subtotal: invoice.subtotal.toString(),
    taxTotal: invoice.taxTotal.toString(),
    grandTotal: invoice.grandTotal.toString(),
    amountReceived: received.toString(),
    balanceDue: invoice.grandTotal.minus(received).toString(),
    createdAt: invoice.createdAt,
    lines: invoice.lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      productName: line.productName,
      sku: line.sku,
      hsnCode: line.hsnCode,
      unit: line.unit,
      quantity: line.quantity.toString(),
      unitPrice: line.unitPrice.toString(),
      discountPercent: line.discountPercent.toString(),
      discountAmount: line.discountAmount.toString(),
      gstRate: line.gstRate.toString(),
      taxableValue: line.taxableValue.toString(),
      taxAmount: line.taxAmount.toString(),
      lineTotal: line.lineTotal.toString(),
    })),
    payments: invoice.payments.map((payment) => ({
      method: payment.method,
      amount: payment.amount.toString(),
    })),
  };
}
