import { describe, expect, it } from "vitest";
import {
  businessSettingsSchema,
  contactCreateSchema,
  invoiceCreateSchema,
  loginSchema,
  pairingRequestSchema,
  productCreateSchema,
  purchaseCreateSchema,
  salesReturnSchema,
} from "../src/validation.js";

describe("request validation", () => {
  it("requires a business and non-empty credentials for login", () => {
    expect(loginSchema.safeParse({
      businessId: "not-a-uuid",
      username: "",
      password: "",
    }).success).toBe(false);
  });

  it("accepts product-specific tax and unit values without forcing one unit", () => {
    const result = productCreateSchema.safeParse({
      name: "Engine Oil",
      sku: "OIL-1",
      unit: "Litre",
      gstRate: 18,
      sellingPrice: 1200,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.unit).toBe("Litre");
      expect(result.data.gstRate).toBe(18);
    }
  });

  it("allows catalog products to leave unknown prices and GST unset", () => {
    const result = productCreateSchema.safeParse({
      name: "Catalog item",
      sku: "CATALOG-ITEM",
      brand: "Manufacturer",
      model: "Verified model",
      catalogSourceUrl: "https://manufacturer.example/products/model",
      gstRate: null,
      purchasePrice: null,
      sellingPrice: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gstRate).toBeNull();
      expect(result.data.purchasePrice).toBeNull();
      expect(result.data.sellingPrice).toBeNull();
    }
  });

  it("validates optional invoice settings and customer place-of-supply state codes", () => {
    expect(businessSettingsSchema.safeParse({
      pricesIncludeGst: true,
      logoDataUrl: "data:image/png;base64,aGVsbG8=",
      termsAndConditions: "Configured terms",
      warrantyNote: null,
      bankDetails: "Configured by the business",
      authorisedSignatory: "Owner",
    }).success).toBe(true);
    expect(businessSettingsSchema.safeParse({
      pricesIncludeGst: true,
      logoDataUrl: "https://example.invalid/logo.png",
    }).success).toBe(false);
    expect(contactCreateSchema.safeParse({ name: "Buyer", stateCode: "27" }).success).toBe(true);
    expect(contactCreateSchema.safeParse({ name: "Buyer", stateCode: "2" }).success).toBe(false);
  });

  it("accepts bounded invoice discounts and rejects values above 100 percent", () => {
    const request = {
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
      lines: [{ productId: "00000000-0000-4000-8000-000000000002", quantity: "1", discountPercent: 12.5 }],
      payments: [{ method: "Cash", amount: "100.00" }],
    };
    expect(invoiceCreateSchema.safeParse(request).success).toBe(true);
    expect(invoiceCreateSchema.safeParse({
      ...request,
      lines: [{ ...request.lines[0], discountPercent: 100.01 }],
    }).success).toBe(false);
  });

  it("rejects invalid rates and negative monetary values", () => {
    expect(productCreateSchema.safeParse({
      name: "Invalid",
      sku: "BAD-1",
      gstRate: 101,
      purchasePrice: -1,
      sellingPrice: 1,
    }).success).toBe(false);
  });

  it("requires an idempotency key and positive purchase quantities", () => {
    expect(purchaseCreateSchema.safeParse({
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
      supplierId: "00000000-0000-4000-8000-000000000002",
      lines: [{
        productId: "00000000-0000-4000-8000-000000000003",
        quantity: "0",
        unitCost: "12.50",
      }],
    }).success).toBe(false);
  });

  it("validates one-time pairing codes and high-entropy client secrets", () => {
    const valid = {
      invitationCode: "A".repeat(32),
      deviceId: "00000000-0000-4000-8000-000000000001",
      deviceName: "Front desk",
      deviceCredential: "B".repeat(43),
      pollToken: "C".repeat(43),
    };
    expect(pairingRequestSchema.safeParse(valid).success).toBe(true);
    expect(pairingRequestSchema.safeParse({ ...valid, deviceCredential: "short" }).success).toBe(false);
    expect(pairingRequestSchema.safeParse({ ...valid, deviceName: "" }).success).toBe(false);
  });

  it("does not permit the same invoice line twice in one return", () => {
    const line = {
      invoiceLineId: "00000000-0000-4000-8000-000000000003",
      quantity: "1",
      returnToStock: true,
    };
    expect(salesReturnSchema.safeParse({
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
      reason: "Customer return",
      refundMethod: "Cash",
      lines: [line, line],
    }).success).toBe(false);
  });
});
