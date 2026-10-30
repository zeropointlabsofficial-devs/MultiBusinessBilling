export type InvoicePrintLine = {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  hsnCode?: string | null;
  unit: string;
  quantity: string;
  unitPrice: string;
  discountPercent?: string;
  discountAmount?: string;
  gstRate: string;
  taxableValue: string;
  taxAmount: string;
  lineTotal: string;
};

export type InvoicePrintData = {
  invoiceNumber: string;
  status: string;
  subtotal: string;
  taxTotal: string;
  grandTotal: string;
  amountReceived: string;
  balanceDue: string;
  createdAt: string;
  lines?: InvoicePrintLine[];
  payments?: Array<{ method: string; amount: string }>;
  customer?: {
    name: string;
    phone: string | null;
    address: string | null;
    gstin: string | null;
    stateCode?: string | null;
  } | null;
  business?: {
    name: string;
    address: string | null;
    phone: string | null;
    gstin: string | null;
    stateCode: string | null;
    logoDataUrl?: string | null;
    termsAndConditions?: string | null;
    warrantyNote?: string | null;
    bankDetails?: string | null;
    authorisedSignatory?: string | null;
  };
  cancellationReason?: string | null;
};

export type InvoiceCopyKind = "ORIGINAL" | "DUPLICATE";

const ones = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function underThousand(value: number): string {
  const words: string[] = [];
  if (value >= 100) {
    words.push(ones[Math.floor(value / 100)]!, "Hundred");
    value %= 100;
  }
  if (value >= 20) {
    const tail = value % 10;
    words.push(tens[Math.floor(value / 10)]!);
    if (tail) words.push(ones[tail]!);
  } else if (value > 0) {
    words.push(ones[value]!);
  }
  return words.join(" ");
}

function indianIntegerWords(value: bigint): string {
  if (value === 0n) return "Zero";
  const words: string[] = [];
  let group = Number(value % 1000n);
  value /= 1000n;
  if (group > 0) words.unshift(underThousand(group));
  const labels = ["Thousand", "Lakh", "Crore", "Arab", "Kharab", "Neel"];
  let index = 0;
  while (value > 0n) {
    group = Number(value % 100n);
    value /= 100n;
    if (group > 0) words.unshift(`${underThousand(group)} ${labels[index] ?? "Neel"}`);
    index += 1;
  }
  return words.join(" ");
}

export function amountToIndianWords(amount: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) return "Amount unavailable";
  const [whole = "0", fractional = ""] = amount.split(".");
  const rupees = BigInt(whole);
  const paise = Number(fractional.padEnd(2, "0"));
  const rupeeLabel = rupees === 1n ? "Rupee" : "Rupees";
  const paiseLabel = paise === 1 ? "Paisa" : "Paise";
  const parts = [`${indianIntegerWords(rupees)} ${rupeeLabel}`];
  if (paise > 0) parts.push(`${underThousand(paise)} ${paiseLabel}`);
  return `${parts.join(" and ")} Only`;
}

export function invoiceTaxBreakdown(
  taxAmount: string,
  sellerStateCode?: string | null,
  placeOfSupplyStateCode?: string | null,
) {
  const stateCodePattern = /^\d{2}$/;
  if (!sellerStateCode || !placeOfSupplyStateCode ||
      !stateCodePattern.test(sellerStateCode) || !stateCodePattern.test(placeOfSupplyStateCode)) {
    return [{ label: "GST", amount: taxAmount }];
  }
  if (sellerStateCode !== placeOfSupplyStateCode) {
    return [{ label: "IGST", amount: taxAmount }];
  }
  const [whole = "0", fraction = ""] = taxAmount.split(".");
  const paise = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  const centralPaise = (paise + 1n) / 2n;
  const statePaise = paise - centralPaise;
  const formatPaise = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
  return [
    { label: "CGST", amount: formatPaise(centralPaise) },
    { label: "SGST", amount: formatPaise(statePaise) },
  ];
}

function amountInPaise(value: string) {
  const [whole = "0", fractional = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fractional.padEnd(2, "0").slice(0, 2));
}

function formatPaise(value: bigint) {
  return `Rs. ${(value / 100n).toLocaleString("en-IN")}.${String(value % 100n).padStart(2, "0")}`;
}

function formatCurrency(value: string) {
  return formatPaise(amountInPaise(value));
}

export function InvoicePrint({ invoice, copyKind }: { invoice: InvoicePrintData; copyKind: InvoiceCopyKind }) {
  const lines = invoice.lines ?? [];
  const business = invoice.business;
  const supplierState = business?.stateCode ?? null;
  const placeOfSupply = invoice.customer?.stateCode ?? null;
  const discountTotal = lines.reduce((total, line) => total + amountInPaise(line.discountAmount ?? "0"), 0n);

  return (
    <article className="invoice-document" aria-label={`${copyKind.toLowerCase()} invoice ${invoice.invoiceNumber}`}>
      <header className="invoice-document-header">
        {business?.logoDataUrl && <img className="invoice-logo" src={business.logoDataUrl} alt="Business logo" />}
        <div className="invoice-business">
          <p className="invoice-title">Tax Invoice</p>
          <h1>{business?.name ?? "Business"}</h1>
          {business?.address && <p>{business.address}</p>}
          {business?.phone && <p>Phone: {business.phone}</p>}
          {business?.gstin && <p>GSTIN: {business.gstin}</p>}
        </div>
        <div className="invoice-identifiers">
          <span className="invoice-copy-label">{copyKind === "ORIGINAL" ? "Original for recipient" : "Duplicate for supplier"}</span>
          <strong>{invoice.invoiceNumber}</strong>
          <span>{new Date(invoice.createdAt).toLocaleDateString("en-IN")}</span>
          {invoice.status !== "FINALIZED" && <span className="invoice-status">{invoice.status}</span>}
        </div>
      </header>

      <section className="invoice-parties">
        <div>
          <h2>Bill to</h2>
          <strong>{invoice.customer?.name ?? "Walk-in customer"}</strong>
          {invoice.customer?.address && <p>{invoice.customer.address}</p>}
          {invoice.customer?.phone && <p>Phone: {invoice.customer.phone}</p>}
          {invoice.customer?.gstin && <p>GSTIN: {invoice.customer.gstin}</p>}
        </div>
        <div className="invoice-place-of-supply">
          <h2>Place of supply</h2>
          <p>{placeOfSupply ? `State code ${placeOfSupply}` : "Not configured"}</p>
        </div>
      </section>

      <table className="invoice-items-table">
        <thead>
          <tr>
            <th className="invoice-col-number">#</th>
            <th className="invoice-col-product">Product / description</th>
            <th className="invoice-col-hsn">HSN/SAC</th>
            <th className="invoice-col-quantity">Qty</th>
            <th className="invoice-col-rate">Rate</th>
            <th className="invoice-col-discount">Discount</th>
            <th className="invoice-col-taxable">Taxable</th>
            <th className="invoice-col-tax">Tax</th>
            <th className="invoice-col-total">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => {
            const split = invoiceTaxBreakdown(line.taxAmount, supplierState, placeOfSupply);
            return (
              <tr key={line.id ?? `${line.productId}-${index}`}>
                <td>{index + 1}</td>
                <td className="invoice-product-cell"><strong>{line.productName}</strong><small>{line.sku}</small></td>
                <td>{line.hsnCode || "—"}</td>
                <td>{line.quantity} {line.unit}</td>
                <td>{formatCurrency(line.unitPrice)}</td>
                <td>{Number(line.discountAmount ?? 0) > 0
                  ? <>{line.discountPercent ?? "0"}%<small>{formatCurrency(line.discountAmount!)}</small></>
                  : "—"}</td>
                <td>{formatCurrency(line.taxableValue)}</td>
                <td className="invoice-tax-cell">
                  <small>{line.gstRate}% GST</small>
                  {split.map((tax) => <small key={tax.label}>{tax.label} {formatCurrency(tax.amount)}</small>)}
                </td>
                <td>{formatCurrency(line.lineTotal)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <section className="invoice-totals">
        <div className="invoice-total-words">
          <span>Amount in words</span>
          <strong>{amountToIndianWords(invoice.grandTotal)}</strong>
        </div>
        <dl>
          {discountTotal > 0n && <><dt>Discounts</dt><dd>{formatPaise(discountTotal)}</dd></>}
          <dt>Taxable subtotal</dt><dd>{formatCurrency(invoice.subtotal)}</dd>
          <dt>Total GST</dt><dd>{formatCurrency(invoice.taxTotal)}</dd>
          <dt className="invoice-grand-total">Invoice total</dt><dd className="invoice-grand-total">{formatCurrency(invoice.grandTotal)}</dd>
          <dt>Amount paid</dt><dd>{formatCurrency(invoice.amountReceived)}</dd>
          <dt>Balance due</dt><dd>{formatCurrency(invoice.balanceDue)}</dd>
        </dl>
      </section>

      <section className="invoice-payment-details">
        <strong>Payment method</strong>
        <span>{invoice.payments?.length
          ? invoice.payments.map((payment) => `${payment.method}: ${formatCurrency(payment.amount)}`).join(" · ")
          : "Not recorded"}</span>
      </section>

      {invoice.cancellationReason && <p className="invoice-cancellation">Cancelled: {invoice.cancellationReason}</p>}
      {business?.bankDetails && <section className="invoice-business-note"><h2>Bank details</h2><p>{business.bankDetails}</p></section>}
      {business?.warrantyNote && <section className="invoice-business-note"><h2>Warranty</h2><p>{business.warrantyNote}</p></section>}
      {business?.termsAndConditions && <section className="invoice-business-note"><h2>Terms and conditions</h2><p>{business.termsAndConditions}</p></section>}

      <footer className="invoice-signatures">
        <div><span>Customer signature</span></div>
        <div><span>For {business?.name ?? "Business"}</span><strong>{business?.authorisedSignatory ?? "Authorised signatory"}</strong></div>
      </footer>
    </article>
  );
}