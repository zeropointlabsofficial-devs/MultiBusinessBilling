import { describe, expect, it } from "vitest";
import { createInvoicePreviewPayload, serializeInvoiceDraftLines } from "./invoiceDraft";

describe("invoice preview payload", () => {
  it("sends discount percentages as numbers and preserves zero", () => {
    const payload = createInvoicePreviewPayload("", [
      { productId: "product-zero", quantity: "1", discountPercent: "0" },
      { productId: "product-discount", quantity: "2", discountPercent: "12.5" },
    ]);

    expect(payload.customerId).toBeNull();
    expect(payload.lines.map((line) => line.discountPercent)).toEqual([0, 12.5]);
    expect(payload.lines.every((line) => typeof line.discountPercent === "number")).toBe(true);

    const invoiceLines = serializeInvoiceDraftLines([
      { productId: "product-zero", quantity: "1", discountPercent: "0" },
      { productId: "product-discount", quantity: "2", discountPercent: "12.5" },
    ]);
    expect(invoiceLines.map((line) => line.discountPercent)).toEqual([0, 12.5]);
    expect(invoiceLines.every((line) => typeof line.discountPercent === "number")).toBe(true);
  });

  it("does not turn an empty discount into zero", () => {
    const lines = serializeInvoiceDraftLines([
      { productId: "product-empty", quantity: "1", discountPercent: "" },
    ]);

    expect(Number.isNaN(lines[0].discountPercent)).toBe(true);
    expect(JSON.parse(JSON.stringify(lines))[0].discountPercent).toBeNull();
  });
});
