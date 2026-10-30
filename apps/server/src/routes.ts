import { Router } from "express";
import argon2 from "argon2";
import { Prisma } from "./generated/prisma/client.js";
import { Role } from "./generated/prisma/enums.js";
import {
  authenticate,
  authenticateSessionOnly,
  login,
  logout,
  requireRole,
  requireTrustedPairingAdministrator,
} from "./auth.js";
import { prisma } from "./db.js";
import { ApiError } from "./errors.js";
import { logger } from "./logging.js";
import { finalizePurchase, purchaseRequestHash, purchaseResponse } from "./purchases.js";
import {
  cancelInvoice,
  purchaseReturnRequestHash,
  returnPurchase,
  returnSale,
  salesReturnRequestHash,
} from "./returns.js";
import { finalizeInvoice, invoiceRequestHash, invoiceResponse, previewInvoice } from "./sales.js";
import {
  approvePairedDevice,
  createPairingInvitation,
  listPairedDevices,
  pollDevicePairing,
  requestDevicePairing,
  revokePairedDevice,
} from "./pairing.js";
import {
  businessSettingsSchema,
  cancellationSchema,
  contactCreateSchema,
  invoiceCreateSchema,
  invoicePreviewSchema,
  loginSchema,
  pairingApprovalSchema,
  pairingInvitationSchema,
  pairingPollSchema,
  pairingRequestSchema,
  passwordResetSchema,
  productCreateSchema,
  productIdSchema,
  productUpdateSchema,
  purchaseCreateSchema,
  purchaseReturnSchema,
  salesReturnSchema,
  stockAdjustmentSchema,
  userCreateSchema,
  userRoleUpdateSchema,
} from "./validation.js";

export const router = Router();

async function lockBusinessMemberships(tx: Prisma.TransactionClient, businessId: string) {
  await tx.$queryRaw`
    SELECT "id" FROM "Business" WHERE "id" = ${businessId}::uuid FOR UPDATE
  `;
}

router.get("/health/live", (_req, res) => {
  res.json({ status: "ok", apiVersion: 1 });
});

router.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", database: "ok", apiVersion: 1 });
  } catch (error) {
    logger.warn({ err: error }, "Database readiness check failed");
    res.status(503).json({ status: "unavailable", database: "unavailable", apiVersion: 1 });
  }
});

router.get("/businesses", async (_req, res) => {
  const businesses = await prisma.business.findMany({
    where: { isActive: true },
    select: { id: true, name: true, category: true },
    orderBy: { name: "asc" },
  });
  res.json({ businesses });
});

router.post("/auth/login", async (req, res) => {
  const input = loginSchema.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: "Invalid login request." });
    return;
  }
  const result = await login(
    input.data.username,
    input.data.password,
    input.data.businessId,
    Number(req.app.locals.sessionTtlHours),
  );
  if (!result) {
    res.status(401).json({ error: "Invalid username, password, or business access." });
    return;
  }
  res.json(result);
});

router.post("/pairing/request", async (req, res) => {
  const input = pairingRequestSchema.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: "Invalid pairing request." });
    return;
  }
  const result = await requestDevicePairing(input.data);
  res.status(202).json(result);
});

router.get("/pairing/:deviceId/status", async (req, res) => {
  const input = pairingPollSchema.safeParse({
    deviceId: req.params.deviceId,
    pollToken: req.header("x-pairing-poll-token"),
  });
  if (!input.success) {
    res.status(400).json({ error: "Invalid pairing status request." });
    return;
  }
  res.json(await pollDevicePairing(input.data.deviceId, input.data.pollToken));
});

router.post(
  "/pairing/invitations",
  authenticateSessionOnly,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  requireTrustedPairingAdministrator,
  async (req, res) => {
    if (!pairingInvitationSchema.safeParse(req.body).success) {
      res.status(400).json({ error: "Invalid invitation request." });
      return;
    }
    const invitation = await createPairingInvitation(req.auth!.businessId, req.auth!.actorId);
    res.status(201).json(invitation);
  },
);

router.get(
  "/pairing/devices",
  authenticateSessionOnly,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  requireTrustedPairingAdministrator,
  async (req, res) => {
    res.json({ devices: await listPairedDevices(req.auth!.businessId) });
  },
);

router.post(
  "/pairing/devices/:deviceId/approve",
  authenticateSessionOnly,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  requireTrustedPairingAdministrator,
  async (req, res) => {
    const input = pairingApprovalSchema.safeParse({ deviceId: req.params.deviceId });
    if (!input.success) {
      res.status(400).json({ error: "Invalid device identifier." });
      return;
    }
    res.json(await approvePairedDevice(input.data.deviceId, req.auth!.businessId, req.auth!.actorId));
  },
);

router.post(
  "/pairing/devices/:deviceId/revoke",
  authenticateSessionOnly,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  requireTrustedPairingAdministrator,
  async (req, res) => {
    const input = pairingApprovalSchema.safeParse({ deviceId: req.params.deviceId });
    if (!input.success) {
      res.status(400).json({ error: "Invalid device identifier." });
      return;
    }
    res.json(await revokePairedDevice(input.data.deviceId, req.auth!.businessId, req.auth!.actorId));
  },
);

router.post("/auth/logout", authenticateSessionOnly, async (req, res) => {
  await logout(req);
  res.status(204).end();
});

router.get("/products", authenticate, async (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
  const products = await prisma.product.findMany({
    where: {
      businessId: req.auth!.businessId,
      isActive: true,
      ...(category ? { category: { equals: category, mode: "insensitive" as const } } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" as const } },
              { sku: { contains: search, mode: "insensitive" as const } },
              { barcode: { contains: search, mode: "insensitive" as const } },
              { brand: { contains: search, mode: "insensitive" as const } },
              { model: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      name: true,
      sku: true,
      category: true,
      brand: true,
      model: true,
      specifications: true,
      packSize: true,
      catalogSourceUrl: true,
      unit: true,
      gstRate: true,
      purchasePrice: true,
      sellingPrice: true,
      minimumStock: true,
      inventoryBalance: { select: { quantity: true } },
    },
    orderBy: { name: "asc" },
    take: 100,
  });
  res.json({
    products: products.map((product) => ({
      ...product,
      gstRate: product.gstRate?.toString() ?? null,
      purchasePrice: product.purchasePrice?.toString() ?? null,
      sellingPrice: product.sellingPrice?.toString() ?? null,
      minimumStock: product.minimumStock.toString(),
      stockQuantity: product.inventoryBalance?.quantity.toString() ?? "0",
    })),
  });
});

router.get("/customers", authenticate, async (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const customers = await prisma.customer.findMany({
    where: {
      businessId: req.auth!.businessId,
      ...(search ? {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { phone: { contains: search, mode: "insensitive" } },
        ],
      } : {}),
    },
    orderBy: { name: "asc" },
    take: 100,
  });
  res.json({ customers });
});

router.post(
  "/customers",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN, Role.BILLING_OPERATOR),
  async (req, res) => {
    const input = contactCreateSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Invalid customer data.", details: input.error.flatten().fieldErrors });
      return;
    }
    const customer = await prisma.$transaction(async (tx) => {
      const created = await tx.customer.create({
        data: {
          ...input.data,
          phone: input.data.phone || null,
          address: input.data.address || null,
          gstin: input.data.gstin || null,
          notes: input.data.notes || null,
          businessId: req.auth!.businessId,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: req.auth!.actorId,
          businessId: req.auth!.businessId,
          action: "customer.created",
          entityType: "Customer",
          entityId: created.id,
        },
      });
      return created;
    });
    res.status(201).json({ customer });
  },
);

router.get("/suppliers", authenticate, requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN), async (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const suppliers = await prisma.supplier.findMany({
    where: {
      businessId: req.auth!.businessId,
      ...(search ? {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { phone: { contains: search, mode: "insensitive" } },
        ],
      } : {}),
    },
    orderBy: { name: "asc" },
    take: 100,
  });
  res.json({ suppliers });
});

router.post(
  "/suppliers",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  async (req, res) => {
    const input = contactCreateSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Invalid supplier data.", details: input.error.flatten().fieldErrors });
      return;
    }
    const supplier = await prisma.$transaction(async (tx) => {
      const created = await tx.supplier.create({
        data: {
          name: input.data.name,
          phone: input.data.phone || null,
          address: input.data.address || null,
          gstin: input.data.gstin || null,
          businessId: req.auth!.businessId,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: req.auth!.actorId,
          businessId: req.auth!.businessId,
          action: "supplier.created",
          entityType: "Supplier",
          entityId: created.id,
        },
      });
      return created;
    });
    res.status(201).json({ supplier });
  },
);

router.post(
  "/products",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  async (req, res) => {
    const input = productCreateSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Invalid product data.", details: input.error.flatten().fieldErrors });
      return;
    }
    const data = input.data;
    try {
      const product = await prisma.$transaction(async (tx) => {
        const created = await tx.product.create({
          data: {
            ...data,
            barcode: data.barcode || null,
            category: data.category || null,
            brand: data.brand || null,
            model: data.model || null,
            variant: data.variant || null,
            specifications: data.specifications || null,
            packSize: data.packSize || null,
            catalogSourceUrl: data.catalogSourceUrl || null,
            hsnCode: data.hsnCode || null,
            warrantyMonths: data.warrantyMonths ?? null,
            businessId: req.auth!.businessId,
            gstRate: data.gstRate == null ? null : new Prisma.Decimal(data.gstRate),
            purchasePrice: data.purchasePrice == null ? null : new Prisma.Decimal(data.purchasePrice),
            sellingPrice: data.sellingPrice == null ? null : new Prisma.Decimal(data.sellingPrice),
            minimumStock: new Prisma.Decimal(data.minimumStock),
          },
        });
        await tx.inventoryBalance.create({
          data: { businessId: req.auth!.businessId, productId: created.id, quantity: 0 },
        });
        await tx.auditLog.create({
          data: {
            actorId: req.auth!.actorId,
            businessId: req.auth!.businessId,
            action: "product.created",
            entityType: "Product",
            entityId: created.id,
            details: { sku: created.sku },
          },
        });
        return created;
      });
      res.status(201).json({ product: { id: product.id, name: product.name, sku: product.sku } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        res.status(409).json({ error: "A product with that SKU or barcode already exists in this business." });
        return;
      }
      throw error;
    }
  },
);

router.get("/settings", authenticate, async (req, res) => {
  const settings = await prisma.businessSettings.findUnique({
    where: { businessId: req.auth!.businessId },
  });
  res.json({ settings });
});

router.put(
  "/settings",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  async (req, res) => {
    const input = businessSettingsSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Invalid business settings.", details: input.error.flatten().fieldErrors });
      return;
    }
    const settings = await prisma.$transaction(async (tx) => {
      const updated = await tx.businessSettings.upsert({
        where: { businessId: req.auth!.businessId },
        create: { ...input.data, businessId: req.auth!.businessId },
        update: input.data,
      });
      await tx.auditLog.create({
        data: {
          actorId: req.auth!.actorId,
          businessId: req.auth!.businessId,
          action: "business.settings_updated",
          entityType: "BusinessSettings",
          entityId: req.auth!.businessId,
          details: {
            ...input.data,
            logoDataUrl: input.data.logoDataUrl ? "[configured]" : null,
            bankDetails: input.data.bankDetails ? "[configured]" : null,
          },
        },
      });
      return updated;
    });
    res.json({ settings });
  },
);

router.post(
  "/inventory/adjustments",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  async (req, res) => {
    const input = stockAdjustmentSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Invalid stock adjustment.", details: input.error.flatten().fieldErrors });
      return;
    }
    const quantityChange = new Prisma.Decimal(input.data.quantityChange);
    const result = await prisma.$transaction(async (tx) => {
      const product = await tx.product.findFirst({
        where: { id: input.data.productId, businessId: req.auth!.businessId, isActive: true },
        select: { id: true, name: true },
      });
      if (!product) throw new ApiError(404, "Product not found in this business.");

      if (quantityChange.gt(0)) {
        await tx.inventoryBalance.upsert({
          where: { businessId_productId: { businessId: req.auth!.businessId, productId: product.id } },
          create: { businessId: req.auth!.businessId, productId: product.id, quantity: quantityChange },
          update: { quantity: { increment: quantityChange } },
        });
      } else {
        const changed = await tx.inventoryBalance.updateMany({
          where: {
            businessId: req.auth!.businessId,
            productId: product.id,
            quantity: { gte: quantityChange.abs() },
          },
          data: { quantity: { decrement: quantityChange.abs() } },
        });
        if (changed.count !== 1) throw new ApiError(409, "Stock adjustment would make available stock negative.");
      }
      const balance = await tx.inventoryBalance.findUniqueOrThrow({
        where: { businessId_productId: { businessId: req.auth!.businessId, productId: product.id } },
      });
      await tx.stockMovement.create({
        data: {
          businessId: req.auth!.businessId,
          productId: product.id,
          actorId: req.auth!.actorId,
          quantityChange,
          type: "ADJUSTMENT",
          reason: input.data.reason,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: req.auth!.actorId,
          businessId: req.auth!.businessId,
          action: "inventory.adjusted",
          entityType: "Product",
          entityId: product.id,
          details: { quantityChange: quantityChange.toString(), reason: input.data.reason },
        },
      });
      return { product, balance };
    });
    res.status(201).json({
      productId: result.product.id,
      productName: result.product.name,
      stockQuantity: result.balance.quantity.toString(),
    });
  },
);

router.get("/inventory", authenticate, async (req, res) => {
  const lowStockOnly = req.query.lowStock === "true";
  const balances = await prisma.inventoryBalance.findMany({
    where: { businessId: req.auth!.businessId },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          sku: true,
          unit: true,
          minimumStock: true,
          isActive: true,
        },
      },
    },
    orderBy: { product: { name: "asc" } },
    take: 500,
  });
  const inventory = balances
    .filter(({ product, quantity }) => product.isActive && (!lowStockOnly || quantity.lte(product.minimumStock)))
    .map(({ product, quantity }) => ({
      ...product,
      minimumStock: product.minimumStock.toString(),
      quantity: quantity.toString(),
      isLowStock: quantity.lte(product.minimumStock),
      isOutOfStock: quantity.lte(0),
    }));
  res.json({ inventory });
});

router.get("/inventory/movements", authenticate, async (req, res) => {
  const page = Math.max(1, Math.min(10_000, Number.parseInt(String(req.query.page ?? "1"), 10) || 1));
  const productId = typeof req.query.productId === "string" ? productIdSchema.safeParse(req.query.productId) : null;
  if (productId && !productId.success) {
    res.status(400).json({ error: "Invalid product identifier." });
    return;
  }
  const movements = await prisma.stockMovement.findMany({
    where: {
      businessId: req.auth!.businessId,
      ...(productId?.success ? { productId: productId.data } : {}),
    },
    include: {
      product: { select: { name: true, sku: true, unit: true } },
      actor: { select: { username: true, displayName: true } },
    },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * 100,
    take: 100,
  });
  res.json({
    movements: movements.map((movement) => ({
      id: movement.id,
      product: movement.product,
      quantityChange: movement.quantityChange.toString(),
      type: movement.type,
      reference: movement.reference,
      reason: movement.reason,
      actor: movement.actor,
      createdAt: movement.createdAt,
    })),
    page,
    pageSize: 100,
  });
});

router.get("/reports/sales", authenticate, async (req, res) => {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const fromText = typeof req.query.from === "string" ? req.query.from : "";
  const toText = typeof req.query.to === "string" ? req.query.to : "";
  if (!datePattern.test(fromText) || !datePattern.test(toText)) {
    res.status(400).json({ error: "Provide date filters in YYYY-MM-DD format." });
    return;
  }
  const from = new Date(`${fromText}T00:00:00.000Z`);
  const to = new Date(`${toText}T00:00:00.000Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) ||
      from.toISOString().slice(0, 10) !== fromText || to.toISOString().slice(0, 10) !== toText) {
    res.status(400).json({ error: "Invalid sales report date range." });
    return;
  }
  const toExclusive = new Date(to);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  if (!Number.isFinite(toExclusive.getTime()) || from > to) {
    res.status(400).json({ error: "Invalid sales report date range." });
    return;
  }
  const invoiceWhere = {
    businessId: req.auth!.businessId,
    status: "FINALIZED" as const,
    createdAt: { gte: from, lt: toExclusive },
  };
  const [invoices, invoiceTotals, salesReturnTotals] = await Promise.all([
    prisma.invoice.findMany({
      where: invoiceWhere,
      select: { id: true, invoiceNumber: true, subtotal: true, taxTotal: true, grandTotal: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 1000,
    }),
    prisma.invoice.aggregate({
      where: invoiceWhere,
      _count: { id: true },
      _sum: { subtotal: true, taxTotal: true, grandTotal: true },
    }),
    prisma.salesReturn.aggregate({
      where: {
        businessId: req.auth!.businessId,
        createdAt: { gte: from, lt: toExclusive },
      },
      _sum: { refundTotal: true },
    }),
  ]);
  const returnedAmount = salesReturnTotals._sum.refundTotal ?? new Prisma.Decimal(0);
  const grossRevenue = invoiceTotals._sum.grandTotal ?? new Prisma.Decimal(0);
  res.json({
    from: fromText,
    to: toText,
    invoices: invoices.map((invoice) => ({
      ...invoice,
      subtotal: invoice.subtotal.toString(),
      taxTotal: invoice.taxTotal.toString(),
      grandTotal: invoice.grandTotal.toString(),
    })),
    totals: {
      invoiceCount: invoiceTotals._count.id,
      subtotal: (invoiceTotals._sum.subtotal ?? new Prisma.Decimal(0)).toString(),
      taxTotal: (invoiceTotals._sum.taxTotal ?? new Prisma.Decimal(0)).toString(),
      grossRevenueIncludingTax: grossRevenue.toString(),
      salesReturnsIncludingTax: returnedAmount.toString(),
      netRevenueIncludingTax: grossRevenue.minus(returnedAmount).toString(),
    },
    truncated: invoiceTotals._count.id > invoices.length,
  });
});

router.post(
  "/users",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  async (req, res) => {
    const input = userCreateSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Invalid user data.", details: input.error.flatten().fieldErrors });
      return;
    }
    if (input.data.role === Role.SYSTEM_ADMIN && req.auth!.role !== Role.SYSTEM_ADMIN) {
      res.status(403).json({ error: "Only a system administrator can assign system administrator access." });
      return;
    }
    const passwordHash = await argon2.hash(input.data.password, { type: argon2.argon2id });
    try {
      const user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            username: input.data.username,
            displayName: input.data.displayName,
            passwordHash,
            memberships: {
              create: { businessId: req.auth!.businessId, role: input.data.role },
            },
          },
          select: { id: true, username: true, displayName: true, isActive: true },
        });
        await tx.auditLog.create({
          data: {
            actorId: req.auth!.actorId,
            businessId: req.auth!.businessId,
            action: "user.created",
            entityType: "User",
            entityId: created.id,
            details: { username: created.username, role: input.data.role },
          },
        });
        return created;
      });
      res.status(201).json({ user, role: input.data.role });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        res.status(409).json({ error: "That username is already in use." });
        return;
      }
      throw error;
    }
  },
);

router.get(
  "/users",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  async (req, res) => {
    const memberships = await prisma.userBusinessRole.findMany({
      where: { businessId: req.auth!.businessId },
      include: { user: { select: { id: true, username: true, displayName: true, isActive: true } } },
      orderBy: { user: { username: "asc" } },
    });
    res.json({
      users: memberships.map(({ user, role, createdAt }) => ({ ...user, role, assignedAt: createdAt })),
    });
  },
);

router.patch(
  "/users/:userId/role",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  async (req, res) => {
    const userId = productIdSchema.safeParse(req.params.userId);
    const input = userRoleUpdateSchema.safeParse(req.body);
    if (!userId.success || !input.success) {
      res.status(400).json({
        error: "Invalid role assignment.",
        ...(!input.success ? { details: input.error.flatten().fieldErrors } : {}),
      });
      return;
    }
    if (input.data.role === Role.SYSTEM_ADMIN && req.auth!.role !== Role.SYSTEM_ADMIN) {
      res.status(403).json({ error: "Only a system administrator can assign system administrator access." });
      return;
    }
    const membership = await prisma.$transaction(async (tx) => {
      await lockBusinessMemberships(tx, req.auth!.businessId);
      const existing = await tx.userBusinessRole.findUnique({
        where: { userId_businessId: { userId: userId.data, businessId: req.auth!.businessId } },
      });
      if (!existing) throw new ApiError(404, "User is not assigned to this business.");
      if (existing.role === Role.SYSTEM_ADMIN && req.auth!.role !== Role.SYSTEM_ADMIN) {
        throw new ApiError(403, "Only a system administrator can change a system administrator's role.");
      }
      if (
        (existing.role === Role.BUSINESS_ADMIN || existing.role === Role.SYSTEM_ADMIN) &&
        input.data.role !== Role.BUSINESS_ADMIN &&
        input.data.role !== Role.SYSTEM_ADMIN
      ) {
        const adminCount = await tx.userBusinessRole.count({
          where: {
            businessId: req.auth!.businessId,
            role: { in: [Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN] },
          },
        });
        if (adminCount <= 1) throw new ApiError(409, "Cannot demote the last business administrator.");
      }
      const updated = await tx.userBusinessRole.update({
        where: { userId_businessId: { userId: userId.data, businessId: req.auth!.businessId } },
        data: { role: input.data.role },
      });
      await tx.auditLog.create({
        data: {
          actorId: req.auth!.actorId,
          businessId: req.auth!.businessId,
          action: "user.role_changed",
          entityType: "UserBusinessRole",
          entityId: userId.data,
          details: { previousRole: existing.role, newRole: updated.role },
        },
      });
      return updated;
    });
    res.json({ userId: membership.userId, role: membership.role });
  },
);

router.post(
  "/users/:userId/assignment",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  async (req, res) => {
    const userId = productIdSchema.safeParse(req.params.userId);
    const input = userRoleUpdateSchema.safeParse(req.body);
    if (!userId.success || !input.success) {
      res.status(400).json({
        error: "Invalid business assignment.",
        ...(!input.success ? { details: input.error.flatten().fieldErrors } : {}),
      });
      return;
    }
    if (input.data.role === Role.SYSTEM_ADMIN && req.auth!.role !== Role.SYSTEM_ADMIN) {
      res.status(403).json({ error: "Only a system administrator can assign system administrator access." });
      return;
    }
    try {
      const membership = await prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId.data }, select: { id: true } });
        if (!user) throw new ApiError(404, "User account was not found.");
        const created = await tx.userBusinessRole.create({
          data: {
            userId: user.id,
            businessId: req.auth!.businessId,
            role: input.data.role,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: req.auth!.actorId,
            businessId: req.auth!.businessId,
            action: "user.business_access_granted",
            entityType: "UserBusinessRole",
            entityId: user.id,
            details: { role: created.role },
          },
        });
        return created;
      });
      res.status(201).json({ userId: membership.userId, businessId: membership.businessId, role: membership.role });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        res.status(409).json({ error: "This user already has an assignment in this business." });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/users/:userId/password-reset",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  async (req, res) => {
    const userId = productIdSchema.safeParse(req.params.userId);
    const input = passwordResetSchema.safeParse(req.body);
    if (!userId.success || !input.success) {
      res.status(400).json({
        error: "Invalid password reset request.",
        ...(!input.success ? { details: input.error.flatten().fieldErrors } : {}),
      });
      return;
    }
    const passwordHash = await argon2.hash(input.data.password, { type: argon2.argon2id });
    await prisma.$transaction(async (tx) => {
      await lockBusinessMemberships(tx, req.auth!.businessId);
      const assignedRole = await tx.userBusinessRole.findUnique({
        where: { userId_businessId: { userId: userId.data, businessId: req.auth!.businessId } },
        select: { role: true },
      });
      if (!assignedRole) throw new ApiError(404, "User is not assigned to this business.");
      if (assignedRole.role === Role.SYSTEM_ADMIN && req.auth!.role !== Role.SYSTEM_ADMIN) {
        throw new ApiError(403, "Only a system administrator can reset a system administrator's password.");
      }
      await tx.user.update({ where: { id: userId.data }, data: { passwordHash } });
      await tx.userSession.updateMany({
        where: { userId: userId.data, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          actorId: req.auth!.actorId,
          businessId: req.auth!.businessId,
          action: "user.password_reset",
          entityType: "User",
          entityId: userId.data,
        },
      });
    });
    res.status(204).end();
  },
);

router.delete(
  "/users/:userId/assignment",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  async (req, res) => {
    const userId = productIdSchema.safeParse(req.params.userId);
    if (!userId.success) {
      res.status(400).json({ error: "Invalid user identifier." });
      return;
    }
    await prisma.$transaction(async (tx) => {
      await lockBusinessMemberships(tx, req.auth!.businessId);
      const membership = await tx.userBusinessRole.findUnique({
        where: { userId_businessId: { userId: userId.data, businessId: req.auth!.businessId } },
      });
      if (!membership) throw new ApiError(404, "User is not assigned to this business.");
      if (membership.role === Role.SYSTEM_ADMIN && req.auth!.role !== Role.SYSTEM_ADMIN) {
        throw new ApiError(403, "Only a system administrator can remove a system administrator's business access.");
      }
      if (membership.role === Role.BUSINESS_ADMIN || membership.role === Role.SYSTEM_ADMIN) {
        const adminCount = await tx.userBusinessRole.count({
          where: {
            businessId: req.auth!.businessId,
            role: { in: [Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN] },
          },
        });
        if (adminCount <= 1) throw new ApiError(409, "Cannot remove the last business administrator.");
      }
      await tx.userBusinessRole.delete({
        where: { userId_businessId: { userId: userId.data, businessId: req.auth!.businessId } },
      });
      await tx.auditLog.create({
        data: {
          actorId: req.auth!.actorId,
          businessId: req.auth!.businessId,
          action: "user.business_access_removed",
          entityType: "UserBusinessRole",
          entityId: userId.data,
          details: { previousRole: membership.role },
        },
      });
    });
    res.status(204).end();
  },
);

router.post(
  "/invoices/preview",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN, Role.BILLING_OPERATOR),
  async (req, res) => {
    const input = invoicePreviewSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Invalid invoice draft.", details: input.error.flatten().fieldErrors });
      return;
    }
    const preview = await previewInvoice(input.data, req.auth!.businessId);
    res.json({ preview });
  },
);

router.post(
  "/purchases",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  async (req, res) => {
    const input = purchaseCreateSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Invalid purchase data.", details: input.error.flatten().fieldErrors });
      return;
    }
    try {
      const purchase = await finalizePurchase(input.data, req.auth!.businessId, req.auth!.actorId);
      res.status(201).json({ purchase: purchaseResponse(purchase) });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await prisma.purchase.findUnique({
          where: {
            businessId_idempotencyKey: {
              businessId: req.auth!.businessId,
              idempotencyKey: input.data.idempotencyKey,
            },
          },
          include: { lines: true },
        });
        if (existing) {
          if (existing.requestHash !== purchaseRequestHash(input.data)) {
            res.status(409).json({ error: "This idempotency key was already used for a different purchase request." });
            return;
          }
          res.status(200).json({ purchase: purchaseResponse(existing) });
          return;
        }
      }
      throw error;
    }
  },
);

router.post(
  "/purchases/:purchaseId/returns",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  async (req, res) => {
    const purchaseId = productIdSchema.safeParse(req.params.purchaseId);
    const input = purchaseReturnSchema.safeParse(req.body);
    if (!purchaseId.success || !input.success) {
      res.status(400).json({
        error: "Invalid purchase return.",
        ...(!input.success ? { details: input.error.flatten().fieldErrors } : {}),
      });
      return;
    }
    try {
      const purchaseReturn = await returnPurchase(
        purchaseId.data,
        input.data,
        req.auth!.businessId,
        req.auth!.actorId,
      );
      res.status(201).json({
        purchaseReturn: {
          id: purchaseReturn.id,
          purchaseId: purchaseReturn.purchaseId,
          reason: purchaseReturn.reason,
          refundMethod: purchaseReturn.refundMethod,
          refundTotal: purchaseReturn.refundTotal.toString(),
          lines: purchaseReturn.lines.map((line) => ({
            purchaseLineId: line.purchaseLineId,
            quantity: line.quantity.toString(),
            refundAmount: line.refundAmount.toString(),
          })),
          createdAt: purchaseReturn.createdAt,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await prisma.purchaseReturn.findUnique({
          where: {
            businessId_idempotencyKey: {
              businessId: req.auth!.businessId,
              idempotencyKey: input.data.idempotencyKey,
            },
          },
          include: { lines: true },
        });
        if (existing) {
          if (existing.requestHash !== purchaseReturnRequestHash(purchaseId.data, input.data)) {
            res.status(409).json({ error: "This idempotency key was already used for a different purchase return." });
            return;
          }
          res.status(200).json({
            purchaseReturn: {
              id: existing.id,
              purchaseId: existing.purchaseId,
              reason: existing.reason,
              refundMethod: existing.refundMethod,
              refundTotal: existing.refundTotal.toString(),
              lines: existing.lines.map((line) => ({
                purchaseLineId: line.purchaseLineId,
                quantity: line.quantity.toString(),
                refundAmount: line.refundAmount.toString(),
              })),
              createdAt: existing.createdAt,
            },
          });
          return;
        }
      }
      throw error;
    }
  },
);

router.get(
  "/purchases",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  async (req, res) => {
    const page = Math.max(1, Math.min(10_000, Number.parseInt(String(req.query.page ?? "1"), 10) || 1));
    const purchases = await prisma.purchase.findMany({
      where: { businessId: req.auth!.businessId },
      include: { lines: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * 50,
      take: 50,
    });
    res.json({ purchases: purchases.map(purchaseResponse), page, pageSize: 50 });
  },
);

router.post(
  "/invoices",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN, Role.BILLING_OPERATOR),
  async (req, res) => {
    const input = invoiceCreateSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Invalid invoice data.", details: input.error.flatten().fieldErrors });
      return;
    }
    try {
      const invoice = await finalizeInvoice(input.data, req.auth!.businessId, req.auth!.actorId);
      res.status(201).json({ invoice: invoiceResponse(invoice) });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await prisma.invoice.findUnique({
          where: {
            businessId_idempotencyKey: {
              businessId: req.auth!.businessId,
              idempotencyKey: input.data.idempotencyKey,
            },
          },
          include: { lines: true, payments: true },
        });
        if (existing) {
          if (existing.requestHash !== invoiceRequestHash(input.data)) {
            res.status(409).json({ error: "This idempotency key was already used for a different invoice request." });
            return;
          }
          res.status(200).json({ invoice: invoiceResponse(existing) });
          return;
        }
      }
      throw error;
    }
  },
);

router.get("/invoices", authenticate, async (req, res) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
  const invoices = await prisma.invoice.findMany({
    where: { businessId: req.auth!.businessId },
    include: { lines: true, payments: true },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * 50,
    take: 50,
  });
  res.json({ invoices: invoices.map(invoiceResponse), page, pageSize: 50 });
});

router.get("/invoices/:invoiceId", authenticate, async (req, res) => {
  const invoiceId = productIdSchema.safeParse(req.params.invoiceId);
  if (!invoiceId.success) {
    res.status(400).json({ error: "Invalid invoice identifier." });
    return;
  }
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId.data, businessId: req.auth!.businessId },
    include: {
      lines: { include: { returns: { select: { quantity: true } } } },
      payments: true,
      customer: { select: { name: true, phone: true, address: true, gstin: true, stateCode: true } },
      business: {
        select: {
          name: true,
          settings: {
            select: {
              address: true,
              phone: true,
              gstin: true,
              stateCode: true,
              logoDataUrl: true,
              termsAndConditions: true,
              warrantyNote: true,
              bankDetails: true,
              authorisedSignatory: true,
            },
          },
        },
      },
    },
  });
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found in this business." });
    return;
  }
  res.json({
    invoice: {
      ...invoiceResponse(invoice),
      lines: invoice.lines.map((line) => ({
        id: line.id,
        productId: line.productId,
        productName: line.productName,
        sku: line.sku,
        hsnCode: line.hsnCode,
        unit: line.unit,
        quantity: line.quantity.toString(),
        returnedQuantity: line.returns.reduce((total, returned) => total.plus(returned.quantity), new Prisma.Decimal(0)).toString(),
        unitPrice: line.unitPrice.toString(),
        discountPercent: line.discountPercent.toString(),
        discountAmount: line.discountAmount.toString(),
        gstRate: line.gstRate.toString(),
        taxableValue: line.taxableValue.toString(),
        taxAmount: line.taxAmount.toString(),
        lineTotal: line.lineTotal.toString(),
      })),
      customer: invoice.customer,
      business: { name: invoice.business.name, ...invoice.business.settings },
    },
  });
});

router.post(
  "/invoices/:invoiceId/returns",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  async (req, res) => {
    const invoiceId = productIdSchema.safeParse(req.params.invoiceId);
    const input = salesReturnSchema.safeParse(req.body);
    if (!invoiceId.success || !input.success) {
      res.status(400).json({
        error: "Invalid sales return.",
        ...(!input.success ? { details: input.error.flatten().fieldErrors } : {}),
      });
      return;
    }
    try {
      const salesReturn = await returnSale(
        invoiceId.data,
        input.data,
        req.auth!.businessId,
        req.auth!.actorId,
      );
      res.status(201).json({
        salesReturn: {
          id: salesReturn.id,
          invoiceId: salesReturn.invoiceId,
          reason: salesReturn.reason,
          refundMethod: salesReturn.refundMethod,
          refundTotal: salesReturn.refundTotal.toString(),
          lines: salesReturn.lines.map((line) => ({
            invoiceLineId: line.invoiceLineId,
            quantity: line.quantity.toString(),
            refundAmount: line.refundAmount.toString(),
            returnToStock: line.returnToStock,
          })),
          createdAt: salesReturn.createdAt,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await prisma.salesReturn.findUnique({
          where: {
            businessId_idempotencyKey: {
              businessId: req.auth!.businessId,
              idempotencyKey: input.data.idempotencyKey,
            },
          },
          include: { lines: true },
        });
        if (existing) {
          if (existing.requestHash !== salesReturnRequestHash(invoiceId.data, input.data)) {
            res.status(409).json({ error: "This idempotency key was already used for a different sales return." });
            return;
          }
          res.status(200).json({
            salesReturn: {
              id: existing.id,
              invoiceId: existing.invoiceId,
              reason: existing.reason,
              refundMethod: existing.refundMethod,
              refundTotal: existing.refundTotal.toString(),
              lines: existing.lines.map((line) => ({
                invoiceLineId: line.invoiceLineId,
                quantity: line.quantity.toString(),
                refundAmount: line.refundAmount.toString(),
                returnToStock: line.returnToStock,
              })),
              createdAt: existing.createdAt,
            },
          });
          return;
        }
      }
      throw error;
    }
  },
);

router.post(
  "/invoices/:invoiceId/cancel",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  async (req, res) => {
    const invoiceId = productIdSchema.safeParse(req.params.invoiceId);
    const input = cancellationSchema.safeParse(req.body);
    if (!invoiceId.success || !input.success) {
      res.status(400).json({
        error: "Invalid invoice cancellation.",
        ...(!input.success ? { details: input.error.flatten().fieldErrors } : {}),
      });
      return;
    }
    const invoice = await cancelInvoice(
      invoiceId.data,
      input.data.reason,
      req.auth!.businessId,
      req.auth!.actorId,
    );
    res.json({
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        cancellationReason: invoice.cancellationReason,
        cancelledAt: invoice.cancelledAt,
      },
    });
  },
);

router.get("/audit-logs", authenticate, requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN, Role.VIEWER), async (req, res) => {
  const page = Math.max(1, Math.min(10_000, Number.parseInt(String(req.query.page ?? "1"), 10) || 1));
  const logs = await prisma.auditLog.findMany({
    where: { businessId: req.auth!.businessId },
    include: { actor: { select: { username: true, displayName: true } } },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * 100,
    take: 100,
  });
  res.json({ logs, page, pageSize: 100 });
});

router.get("/sales-returns", authenticate, async (req, res) => {
  const page = Math.max(1, Math.min(10_000, Number.parseInt(String(req.query.page ?? "1"), 10) || 1));
  const returns = await prisma.salesReturn.findMany({
    where: { businessId: req.auth!.businessId },
    include: {
      invoice: { select: { invoiceNumber: true } },
      actor: { select: { username: true, displayName: true } },
      lines: true,
    },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * 100,
    take: 100,
  });
  res.json({
    returns: returns.map((returned) => ({
      id: returned.id,
      invoiceId: returned.invoiceId,
      invoiceNumber: returned.invoice.invoiceNumber,
      reason: returned.reason,
      refundMethod: returned.refundMethod,
      refundTotal: returned.refundTotal.toString(),
      actor: returned.actor,
      createdAt: returned.createdAt,
      lines: returned.lines.map((line) => ({
        invoiceLineId: line.invoiceLineId,
        quantity: line.quantity.toString(),
        refundAmount: line.refundAmount.toString(),
        returnToStock: line.returnToStock,
      })),
    })),
    page,
    pageSize: 100,
  });
});

router.get(
  "/purchase-returns",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  async (req, res) => {
    const page = Math.max(1, Math.min(10_000, Number.parseInt(String(req.query.page ?? "1"), 10) || 1));
    const returns = await prisma.purchaseReturn.findMany({
      where: { businessId: req.auth!.businessId },
      include: {
        purchase: { select: { purchaseNumber: true } },
        actor: { select: { username: true, displayName: true } },
        lines: true,
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * 100,
      take: 100,
    });
    res.json({
      returns: returns.map((returned) => ({
        id: returned.id,
        purchaseId: returned.purchaseId,
        purchaseNumber: returned.purchase.purchaseNumber,
        reason: returned.reason,
        refundMethod: returned.refundMethod,
        refundTotal: returned.refundTotal.toString(),
        actor: returned.actor,
        createdAt: returned.createdAt,
        lines: returned.lines.map((line) => ({
          purchaseLineId: line.purchaseLineId,
          quantity: line.quantity.toString(),
          refundAmount: line.refundAmount.toString(),
        })),
      })),
      page,
      pageSize: 100,
    });
  },
);

router.get("/price-history", authenticate, requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN, Role.VIEWER), async (req, res) => {
  const productId = typeof req.query.productId === "string" ? productIdSchema.safeParse(req.query.productId) : null;
  if (productId && !productId.success) {
    res.status(400).json({ error: "Invalid product identifier." });
    return;
  }
  const history = await prisma.productPriceHistory.findMany({
    where: {
      businessId: req.auth!.businessId,
      ...(productId?.success ? { productId: productId.data } : {}),
    },
    include: {
      product: { select: { name: true, sku: true } },
      actor: { select: { username: true, displayName: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  res.json({
    history: history.map((entry) => ({
      ...entry,
      oldPrice: entry.oldPrice?.toString() ?? null,
      newPrice: entry.newPrice?.toString() ?? null,
    })),
  });
});

router.patch(
  "/products/:productId",
  authenticate,
  requireRole(Role.SYSTEM_ADMIN, Role.BUSINESS_ADMIN),
  async (req, res) => {
    const input = productUpdateSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Invalid product data.", details: input.error.flatten().fieldErrors });
      return;
    }
    const productId = productIdSchema.safeParse(req.params.productId);
    if (!productId.success) {
      res.status(400).json({ error: "Invalid product identifier." });
      return;
    }
    const { priceChangeReason, ...updates } = input.data;
    try {
      const product = await prisma.$transaction(async (tx) => {
        const existing = await tx.product.findFirst({
          where: { id: productId.data, businessId: req.auth!.businessId },
        });
        if (!existing) return null;

        const nextPrice = updates.sellingPrice === undefined
          ? existing.sellingPrice
          : updates.sellingPrice === null ? null : new Prisma.Decimal(updates.sellingPrice);
        const priceChanged = existing.sellingPrice === null
          ? nextPrice !== null
          : nextPrice === null || !nextPrice.equals(existing.sellingPrice);
        const updated = await tx.product.update({
          where: { id: existing.id },
          data: {
            ...updates,
            ...(updates.gstRate === undefined ? {} : { gstRate: updates.gstRate === null ? null : new Prisma.Decimal(updates.gstRate) }),
            ...(updates.purchasePrice === undefined ? {} : { purchasePrice: updates.purchasePrice === null ? null : new Prisma.Decimal(updates.purchasePrice) }),
            ...(updates.sellingPrice === undefined ? {} : { sellingPrice: nextPrice }),
            ...(updates.minimumStock === undefined ? {} : { minimumStock: new Prisma.Decimal(updates.minimumStock) }),
          },
        });
        if (priceChanged) {
          await tx.productPriceHistory.create({
            data: {
              businessId: req.auth!.businessId,
              productId: existing.id,
              actorId: req.auth!.actorId,
              oldPrice: existing.sellingPrice,
              newPrice: nextPrice,
              reason: priceChangeReason,
            },
          });
        }
        await tx.auditLog.create({
          data: {
            actorId: req.auth!.actorId,
            businessId: req.auth!.businessId,
            action: priceChanged ? "product.price_changed" : "product.updated",
            entityType: "Product",
            entityId: existing.id,
            details: {
              changes: updates,
              ...(priceChanged
                ? {
                    previousPrice: existing.sellingPrice?.toString() ?? null,
                    newPrice: nextPrice?.toString() ?? null,
                    reason: priceChangeReason,
                  }
                : {}),
            },
          },
        });
        return updated;
      });
      if (!product) {
        res.status(404).json({ error: "Product not found in this business." });
        return;
      }
      res.json({ product: { id: product.id, name: product.name, sku: product.sku } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        res.status(409).json({ error: "A product with that SKU or barcode already exists in this business." });
        return;
      }
      throw error;
    }
  },
);
