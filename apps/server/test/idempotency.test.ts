import { describe, expect, it } from "vitest";
import { requestHash } from "../src/idempotency.js";
import { invoiceRequestHash } from "../src/sales.js";
import { invoiceCreateSchema } from "../src/validation.js";

describe("idempotency request fingerprints", () => {
  it("produces the same digest for the same validated request payload", () => {
    const payload = { supplierId: "supplier-1", lines: [{ productId: "product-1", quantity: "2" }] };
    expect(requestHash(payload)).toBe(requestHash(payload));
  });

  it("distinguishes a reused idempotency key with changed business data", () => {
    expect(requestHash({ productId: "product-1", quantity: "2" }))
      .not.toBe(requestHash({ productId: "product-1", quantity: "3" }));
  });

  it("preserves legacy invoice request hashes when the default discount is zero", () => {
    const previousPayload = {
      customerId: null,
      lines: [{ productId: "00000000-0000-4000-8000-000000000001", quantity: "2", expectedUnitPrice: "100.00" }],
      payments: [{ method: "Cash", amount: "236.00" }],
    };
    const input = invoiceCreateSchema.parse({
      idempotencyKey: "00000000-0000-4000-8000-000000000002",
      ...previousPayload,
    });

    expect(invoiceRequestHash(input)).toBe(requestHash(previousPayload));
  });
});
