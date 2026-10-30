export type InvoicePreviewDraftLine = {
  productId: string;
  quantity: string;
  discountPercent: string;
};

export function serializeInvoiceDraftLines(lines: readonly InvoicePreviewDraftLine[]) {
  return lines.map((line) => ({
    ...line,
    discountPercent: line.discountPercent.trim() === ""
      ? Number.NaN
      : Number(line.discountPercent),
  }));
}

export function createInvoicePreviewPayload(customerId: string, lines: readonly InvoicePreviewDraftLine[]) {
  return { customerId: customerId || null, lines: serializeInvoiceDraftLines(lines) };
}
