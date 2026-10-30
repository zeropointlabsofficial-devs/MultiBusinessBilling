import { z } from "zod";

const uuid = z.uuid();

export const loginSchema = z.object({
  businessId: uuid,
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(1024),
});

export const uuidSchema = z.uuid();
export const productIdSchema = uuidSchema;

export const productCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  sku: z.string().trim().min(1).max(80),
  barcode: z.string().trim().max(80).nullable().optional(),
  category: z.string().trim().max(100).nullable().optional(),
  brand: z.string().trim().max(100).nullable().optional(),
  model: z.string().trim().max(100).nullable().optional(),
  variant: z.string().trim().max(100).nullable().optional(),
  specifications: z.string().trim().max(1000).nullable().optional(),
  packSize: z.string().trim().max(100).nullable().optional(),
  catalogSourceUrl: z.url().max(1000).nullable().optional(),
  unit: z.string().trim().min(1).max(32).default("Piece"),
  hsnCode: z.string().trim().max(20).nullable().optional(),
  gstRate: z.number().min(0).max(100).nullable().optional(),
  purchasePrice: z.number().min(0).max(9999999999).nullable().optional(),
  sellingPrice: z.number().min(0).max(9999999999).nullable().optional(),
  minimumStock: z.number().min(0).max(99999999999).default(0),
  tracksSerialNumbers: z.boolean().default(false),
  warrantyMonths: z.number().int().min(0).max(1200).nullable().optional(),
});

export const productUpdateSchema = productCreateSchema.partial().extend({
  isActive: z.boolean().optional(),
  priceChangeReason: z.string().trim().max(500).optional(),
});

const decimalQuantity = z.string()
  .regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/)
  .refine((value) => Number(value) > 0);
const positiveMoney = z.string().regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/);

const invoiceLinesSchema = z.object({
  customerId: uuid.nullable().optional(),
  lines: z.array(z.object({
    productId: uuid,
    quantity: decimalQuantity,
    discountPercent: z.number().min(0).max(100).default(0),
    expectedUnitPrice: positiveMoney.optional(),
  })).min(1).max(100),
});

export const invoicePreviewSchema = invoiceLinesSchema;

export const invoiceCreateSchema = invoiceLinesSchema.extend({
  idempotencyKey: uuid,
  payments: z.array(z.object({
    method: z.string().trim().min(1).max(40),
    amount: positiveMoney,
  })).min(1).max(10),
});

export const stockAdjustmentSchema = z.object({
  productId: uuid,
  quantityChange: z.string().regex(/^-?(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/).refine((value) => Number(value) !== 0),
  reason: z.string().trim().min(1).max(500),
});

export const businessSettingsSchema = z.object({
  address: z.string().trim().max(500).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  gstin: z.string().trim().max(20).nullable().optional(),
  stateCode: z.string().trim().regex(/^\d{2}$/).nullable().optional(),
  logoDataUrl: z.string()
    .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)
    .max(240_000).nullable().optional(),
  termsAndConditions: z.string().trim().max(4000).nullable().optional(),
  warrantyNote: z.string().trim().max(2000).nullable().optional(),
  bankDetails: z.string().trim().max(1000).nullable().optional(),
  authorisedSignatory: z.string().trim().max(160).nullable().optional(),
  invoicePrefix: z.string().trim().regex(/^[A-Z0-9]{1,10}$/).default("INV"),
  allowCredit: z.boolean().default(false),
  pricesIncludeGst: z.boolean(),
});

export const contactCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(40).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  gstin: z.string().trim().max(20).nullable().optional(),
  stateCode: z.string().trim().regex(/^\d{2}$/).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const purchaseCreateSchema = z.object({
  idempotencyKey: uuid,
  supplierId: uuid,
  supplierInvoiceNumber: z.string().trim().max(100).nullable().optional(),
  purchaseDate: z.iso.datetime().optional(),
  lines: z.array(z.object({
    productId: uuid,
    quantity: decimalQuantity,
    unitCost: positiveMoney,
    discountPercent: z.number().min(0).max(100).default(0),
  })).min(1).max(100),
});

export const salesReturnSchema = z.object({
  idempotencyKey: uuid,
  reason: z.string().trim().min(1).max(500),
  refundMethod: z.string().trim().min(1).max(40),
  lines: z.array(z.object({
    invoiceLineId: uuid,
    quantity: decimalQuantity,
    returnToStock: z.boolean().default(false),
  })).min(1).max(100).refine(
    (lines) => new Set(lines.map((line) => line.invoiceLineId)).size === lines.length,
    "An invoice line can only appear once per return.",
  ),
});

export const purchaseReturnSchema = z.object({
  idempotencyKey: uuid,
  reason: z.string().trim().min(1).max(500),
  refundMethod: z.string().trim().min(1).max(40),
  lines: z.array(z.object({
    purchaseLineId: uuid,
    quantity: decimalQuantity,
  })).min(1).max(100).refine(
    (lines) => new Set(lines.map((line) => line.purchaseLineId)).size === lines.length,
    "A purchase line can only appear once per return.",
  ),
});

export const cancellationSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export const userCreateSchema = z.object({
  username: z.string().trim().min(1).max(100),
  displayName: z.string().trim().min(1).max(150),
  password: z.string().min(12).max(1024),
  role: z.enum(["SYSTEM_ADMIN", "BUSINESS_ADMIN", "BILLING_OPERATOR", "VIEWER", "TESTING_USER"]),
});

export const userRoleUpdateSchema = z.object({
  role: z.enum(["SYSTEM_ADMIN", "BUSINESS_ADMIN", "BILLING_OPERATOR", "VIEWER", "TESTING_USER"]),
});

export const passwordResetSchema = z.object({
  password: z.string().min(12).max(1024),
});

const opaqueSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const pairingInvitationSchema = z.object({});

export const pairingRequestSchema = z.object({
  invitationCode: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  deviceId: uuid,
  deviceName: z.string().trim().min(1).max(100),
  deviceCredential: opaqueSecret,
  pollToken: opaqueSecret,
});

export const pairingApprovalSchema = z.object({
  deviceId: uuid,
});

export const pairingPollSchema = z.object({
  deviceId: uuid,
  pollToken: opaqueSecret,
});
