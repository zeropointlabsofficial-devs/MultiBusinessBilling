import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  amountToIndianWords,
  InvoicePrint,
  invoiceTaxBreakdown,
  type InvoicePrintData,
} from "./invoicePrint";

const line = (overrides: Partial<NonNullable<InvoicePrintData["lines"]>[number]> = {}) => ({
  id: crypto.randomUUID(),
  productId: crypto.randomUUID(),
  productName: "Long product name ".repeat(12),
  sku: "SKU-1",
  hsnCode: "85071000",
  unit: "Piece",
  quantity: "2",
  unitPrice: "500.00",
  discountPercent: "10.00",
  discountAmount: "100.00",
  gstRate: "18.00",
  taxableValue: "762.71",
  taxAmount: "137.29",
  lineTotal: "900.00",
  ...overrides,
});

const invoice = (overrides: Partial<InvoicePrintData> = {}): InvoicePrintData => ({
  invoiceNumber: "INV-2026-000001",
  status: "FINALIZED",
  subtotal: "1525.42",
  taxTotal: "274.58",
  grandTotal: "1800.00",
  amountReceived: "1000.00",
  balanceDue: "800.00",
  createdAt: "2026-10-27T12:00:00.000Z",
  lines: [line(), line({ id: crypto.randomUUID(), productId: crypto.randomUUID(), sku: "SKU-2", discountPercent: "0", discountAmount: "0.00", taxAmount: "137.29" })],
  payments: [{ method: "Cash", amount: "1000.00" }],
  customer: { name: "Customer", phone: "", address: "", gstin: "", stateCode: "27" },
  business: {
    name: "Business A",
    address: "Configured address",
    phone: "Configured phone",
    gstin: "Configured GSTIN",
    stateCode: "27",
    logoDataUrl: "data:image/png;base64,aGVsbG8=",
    termsAndConditions: "Configured terms",
    warrantyNote: "Configured warranty",
    bankDetails: "Configured bank details",
    authorisedSignatory: "Configured signatory",
  },
  ...overrides,
});

describe("invoice print document", () => {
  it("renders multiple saved lines, discount, HSN, configured business data, and copy label", () => {
    const markup = renderToStaticMarkup(<InvoicePrint invoice={invoice()} copyKind="ORIGINAL" />);
    expect(markup).toContain("Original for recipient");
    expect(markup).toContain("Business A");
    expect(markup).toContain("Configured GSTIN");
    expect(markup).toContain("85071000");
    expect(markup).toContain("10.00%");
    expect(markup).toContain("Configured terms");
    expect((markup.match(/class="invoice-product-cell"/g) ?? []).length).toBe(2);
    expect(renderToStaticMarkup(<InvoicePrint invoice={invoice()} copyKind="DUPLICATE" />))
      .toContain("Duplicate for supplier");
  });

  it("shows CGST/SGST only for matching configured states and IGST for differing states", () => {
    expect(invoiceTaxBreakdown("101.05", "27", "27")).toEqual([
      { label: "CGST", amount: "50.53" },
      { label: "SGST", amount: "50.52" },
    ]);
    expect(invoiceTaxBreakdown("101.05", "27", "29")).toEqual([
      { label: "IGST", amount: "101.05" },
    ]);
    expect(invoiceTaxBreakdown("101.05", "27", null)).toEqual([
      { label: "GST", amount: "101.05" },
    ]);
  });

  it("renders safely when business and customer settings are missing", () => {
    const markup = renderToStaticMarkup(<InvoicePrint invoice={invoice({ business: undefined, customer: null })} copyKind="ORIGINAL" />);
    expect(markup).toContain("Business");
    expect(markup).toContain("Walk-in customer");
    expect(markup).toContain("Not configured");
    expect(markup).not.toContain("Configured bank details");
  });

  it("spells Indian currency amounts and supports large multipage item lists", () => {
    expect(amountToIndianWords("123456.78"))
      .toBe("One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees and Seventy Eight Paise Only");
    const manyLines = Array.from({ length: 60 }, (_, index) => line({ id: `line-${index}`, productId: `product-${index}` }));
    const markup = renderToStaticMarkup(<InvoicePrint invoice={invoice({ lines: manyLines })} copyKind="ORIGINAL" />);
    expect((markup.match(/class="invoice-product-cell"/g) ?? []).length).toBe(60);
    const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
    expect(css).toContain("@page { size: A4 portrait");
    expect(css).toContain("display: table-header-group");
    expect(css).toContain("page-break-inside: avoid");
    expect(css).toContain("overflow-wrap: anywhere");
  });
});