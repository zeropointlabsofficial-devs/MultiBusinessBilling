import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import {
  configureDefaultServerAddress,
  getApiBaseUrl,
  getSavedServerAddress,
  verifyServerConnection,
} from "./connection";
import {
  clearActiveDeviceCredential,
  forgetActiveDeviceCredential,
  getActiveDeviceHeaders,
  loadDeviceCredential,
  saveDeviceCredential,
  setActiveDeviceCredential,
  type DeviceCredential,
} from "./deviceCredentials";
import { createInvoicePreviewPayload, serializeInvoiceDraftLines } from "./invoiceDraft";
import { InvoicePrint, type InvoiceCopyKind } from "./invoicePrint";
import { watchForProductRefresh } from "./productRefresh";

configureDefaultServerAddress(import.meta.env.VITE_API_URL ?? "http://127.0.0.1:4317");

type Business = { id: string; name: string; category: string };
type Supplier = { id: string; name: string; phone: string | null };
type Customer = {
  id: string;
  name: string;
  phone: string | null;
  address?: string | null;
  gstin?: string | null;
  stateCode?: string | null;
};
type BusinessUser = { id: string; username: string; displayName: string; isActive: boolean; role: string };
type Product = {
  id: string;
  name: string;
  sku: string;
  category: string | null;
  brand: string | null;
  model: string | null;
  specifications: string | null;
  packSize: string | null;
  catalogSourceUrl: string | null;
  unit: string;
  gstRate: string | null;
  purchasePrice: string | null;
  sellingPrice: string | null;
  minimumStock: string;
  stockQuantity: string;
};
type ProductEditDraft = {
  category: string;
  brand: string;
  model: string;
  specifications: string;
  packSize: string;
  catalogSourceUrl: string;
  gstRate: string;
  purchasePrice: string;
  sellingPrice: string;
};
type Session = {
  token: string;
  expiresAt: string;
  business: Business;
  user: { id: string; displayName: string };
  role: string;
};
type InvoicePreview = {
  lines: Array<{
    productId: string;
    productName: string;
    sku: string;
    unit: string;
    quantity: string;
    unitPrice: string;
    hsnCode?: string | null;
    discountPercent?: string;
    discountAmount?: string;
    gstRate: string;
    taxableValue: string;
    taxAmount: string;
    lineTotal: string;
  }>;
  subtotal: string;
  taxTotal: string;
  grandTotal: string;
};
type Invoice = {
  id: string;
  invoiceNumber: string;
  status: string;
  subtotal: string;
  taxTotal: string;
  grandTotal: string;
  amountReceived: string;
  balanceDue: string;
  createdAt: string;
  lines?: Array<InvoicePreview["lines"][number] & { id: string; returnedQuantity?: string }>;
  payments?: Array<{ method: string; amount: string }>;
  customer?: { name: string; phone: string | null; address: string | null; gstin: string | null; stateCode?: string | null } | null;
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
  cancelledAt?: string | null;
};
type Purchase = {
  id: string;
  purchaseNumber: string;
  supplierInvoiceNumber: string | null;
  purchaseDate: string;
  subtotal: string;
  taxTotal: string;
  grandTotal: string;
  lines: Array<{ productName: string; quantity: string; unitCost: string; lineTotal: string }>;
};
type DraftLine = { productId: string; quantity: string; discountPercent: string };
type PurchaseDraftLine = { key: string; productId: string; quantity: string; unitCost: string; discountPercent: string };
type PaymentDraft = { key: string; method: string; amount: string };
type BusinessSettings = {
  address: string | null;
  phone: string | null;
  gstin: string | null;
  stateCode: string | null;
  invoicePrefix: string;
  allowCredit: boolean;
  pricesIncludeGst: boolean | null;
  logoDataUrl: string | null;
  termsAndConditions: string | null;
  warrantyNote: string | null;
  bankDetails: string | null;
  authorisedSignatory: string | null;
};
type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
type PairedDevice = {
  deviceId: string;
  name: string;
  status: "PENDING" | "APPROVED" | "REVOKED";
  createdAt: string;
  approvedAt: string | null;
  revokedAt: string | null;
  lastSeenAt: string | null;
  pairingExpiresAt: string;
};
type PendingPairing = DeviceCredential & {
  deviceId: string;
  businessId: string;
  pollToken: string;
};
type PairingAttempt = {
  invitationCode: string;
  deviceName: string;
  deviceId: string;
  deviceCredential: string;
  pollToken: string;
};

function secureToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function api<T>(path: string, options: RequestInit = {}, session?: Session): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  const abortRequest = () => controller.abort();
  options.signal?.addEventListener("abort", abortRequest, { once: true });
  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(session ? {
          authorization: `Bearer ${session.token}`,
          "x-business-id": session.business.id,
        } : {}),
        ...getActiveDeviceHeaders(),
        ...Object.fromEntries(new Headers(options.headers).entries()),
      },
    });
  } catch (reason) {
    if (options.signal?.aborted) throw reason;
    if (controller.signal.aborted) throw new Error("The request timed out. Check the server connection and retry.");
    throw new Error("Could not reach the selected server. Check the network and try again.");
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortRequest);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    let message = payload?.error ?? `Request failed (${response.status}).`;
    if (message === "This device is not approved for the selected business.") {
      try {
        await forgetActiveDeviceCredential();
      } catch {
        clearActiveDeviceCredential();
        message += " Use Forget saved device credentials on the connection screen.";
      }
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function App() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessId, setBusinessId] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [productEdit, setProductEdit] = useState<ProductEditDraft>({
    category: "",
    brand: "",
    model: "",
    specifications: "",
    packSize: "",
    catalogSourceUrl: "",
    gstRate: "",
    purchasePrice: "",
    sellingPrice: "",
  });
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"billing" | "products" | "invoices" | "purchases" | "users" | "settings" | "devices">("billing");
  const [cart, setCart] = useState<DraftLine[]>([]);
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [customerGstin, setCustomerGstin] = useState("");
  const [customerStateCode, setCustomerStateCode] = useState("");
  const [purchaseSupplierId, setPurchaseSupplierId] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [supplierPhone, setSupplierPhone] = useState("");
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  const [purchaseLines, setPurchaseLines] = useState<PurchaseDraftLine[]>([]);
  const [purchaseIdempotencyKey, setPurchaseIdempotencyKey] = useState(() => crypto.randomUUID());
  const [businessUsers, setBusinessUsers] = useState<BusinessUser[]>([]);
  const [newUser, setNewUser] = useState({ username: "", displayName: "", password: "", role: "BILLING_OPERATOR" });
  const [resetPassword, setResetPassword] = useState<Record<string, string>>({});
  const [lastInvoice, setLastInvoice] = useState<Invoice | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [invoiceCopyKind, setInvoiceCopyKind] = useState<InvoiceCopyKind>("ORIGINAL");
  const [salesReturnQuantities, setSalesReturnQuantities] = useState<Record<string, string>>({});
  const [salesReturnStock, setSalesReturnStock] = useState<Record<string, boolean>>({});
  const [salesReturnReason, setSalesReturnReason] = useState("");
  const [salesReturnMethod, setSalesReturnMethod] = useState("Cash");
  const [salesReturnIdempotencyKey, setSalesReturnIdempotencyKey] = useState(() => crypto.randomUUID());
  const [paymentAllocations, setPaymentAllocations] = useState<PaymentDraft[]>([
    { key: crypto.randomUUID(), method: "Cash", amount: "" },
  ]);
  const [paymentsEdited, setPaymentsEdited] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [settings, setSettings] = useState<BusinessSettings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsForm, setSettingsForm] = useState({
    address: "",
    phone: "",
    gstin: "",
    stateCode: "",
    invoicePrefix: "INV",
    allowCredit: false,
    pricesIncludeGst: "",
    logoDataUrl: "",
    termsAndConditions: "",
    warrantyNote: "",
    bankDetails: "",
    authorisedSignatory: "",
  });
  const [newProduct, setNewProduct] = useState({
    name: "",
    sku: "",
    category: "",
    brand: "",
    model: "",
    specifications: "",
    packSize: "",
    catalogSourceUrl: "",
    unit: "Piece",
    gstRate: "",
    purchasePrice: "",
    sellingPrice: "",
    minimumStock: "0",
  });
  const [adjustment, setAdjustment] = useState({ productId: "", quantityChange: "", reason: "" });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [serverAddress, setServerAddress] = useState(getSavedServerAddress);
  const [serverWasVerified, setServerWasVerified] = useState(false);
  const [invitationCode, setInvitationCode] = useState("");
  const [deviceName, setDeviceName] = useState("Desktop client");
  const [pairingStatus, setPairingStatus] = useState("");
  const [pendingPairing, setPendingPairing] = useState<PendingPairing | null>(null);
  const [pairingAttempt, setPairingAttempt] = useState<PairingAttempt | null>(null);
  const [pairedDevices, setPairedDevices] = useState<PairedDevice[]>([]);
  const [adminInvitation, setAdminInvitation] = useState<{ code: string; expiresAt: string } | null>(null);
  const selectedBusiness = useMemo(
    () => businesses.find((business) => business.id === businessId),
    [businesses, businessId],
  );
  async function viewInvoice(invoiceId: string) {
    if (!session) return;
    setError("");
    try {
      const result = await api<{ invoice: Invoice }>(`/invoices/${invoiceId}`, {}, session);
      setSelectedInvoice(result.invoice);
      setInvoiceCopyKind("ORIGINAL");
      setSalesReturnQuantities({});
      setSalesReturnStock({});
      setSalesReturnReason("");
      setSalesReturnIdempotencyKey(crypto.randomUUID());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Invoice could not be loaded.");
    }
  }

  async function requestPairing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (connectionStatus !== "connected" || !invitationCode.trim()) return;
    setError("");
    setBusy(true);
    const normalizedCode = invitationCode.trim();
    const normalizedName = deviceName.trim();
    const attempt = pairingAttempt?.invitationCode === normalizedCode &&
      pairingAttempt.deviceName === normalizedName
      ? pairingAttempt
      : {
          invitationCode: normalizedCode,
          deviceName: normalizedName,
          deviceId: crypto.randomUUID(),
          deviceCredential: secureToken(),
          pollToken: secureToken(),
        };
    setPairingAttempt(attempt);
    try {
      const result = await api<{ deviceId: string; businessId: string; status: string }>("/pairing/request", {
        method: "POST",
        body: JSON.stringify({
          invitationCode: attempt.invitationCode,
          deviceId: attempt.deviceId,
          deviceName: attempt.deviceName,
          deviceCredential: attempt.deviceCredential,
          pollToken: attempt.pollToken,
        }),
      });
      setInvitationCode("");
      setPairingStatus("Pairing request sent.");
      setPairingAttempt(null);
      setPendingPairing({
        deviceId: result.deviceId,
        businessId: result.businessId,
        credential: attempt.deviceCredential,
        pollToken: attempt.pollToken,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Pairing request could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  async function createPairingInvitation() {
    if (!session) return;
    setError("");
    setBusy(true);
    try {
      const invitation = await api<{ code: string; expiresAt: string }>("/pairing/invitations", {
        method: "POST",
        body: JSON.stringify({}),
      }, session);
      setAdminInvitation(invitation);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Pairing invitation could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function updatePairedDevice(deviceId: string, action: "approve" | "revoke") {
    if (!session) return;
    setError("");
    setBusy(true);
    try {
      await api(`/pairing/devices/${encodeURIComponent(deviceId)}/${action}`, { method: "POST" }, session);
      setRefreshVersion((version) => version + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Paired device could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  async function forgetCurrentDevice() {
    if (!businessId || !window.confirm("Forget this paired device on this computer? You will need a new approval to connect again.")) return;
    setError("");
    try {
      await loadDeviceCredential(serverAddress, businessId);
      await forgetActiveDeviceCredential();
      setPairingStatus("Saved device credentials were removed from Windows Credential Manager.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Saved device credentials could not be removed.");
    }
  }
  async function submitSalesReturn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !selectedInvoice) return;
    const lines = (selectedInvoice.lines ?? [])
      .filter((line) => Number(salesReturnQuantities[line.id] ?? 0) > 0)
      .map((line) => ({
        invoiceLineId: line.id,
        quantity: salesReturnQuantities[line.id],
        returnToStock: salesReturnStock[line.id] ?? true,
      }));
    if (lines.length === 0) {
      setError("Enter a return quantity for at least one invoice line.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await api(`/invoices/${selectedInvoice.id}/returns`, {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: salesReturnIdempotencyKey,
          reason: salesReturnReason,
          refundMethod: salesReturnMethod,
          lines,
        }),
      }, session);
      await viewInvoice(selectedInvoice.id);
      setRefreshVersion((version) => version + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sales return could not be recorded.");
    } finally {
      setBusy(false);
    }
  }
  async function cancelSelectedInvoice() {
    if (!session || !selectedInvoice) return;
    const reason = window.prompt("Enter the reason for cancelling this invoice.");
    if (!reason?.trim()) return;
    if (!window.confirm(`Cancel ${selectedInvoice.invoiceNumber} and restore its items to stock?`)) return;
    setError("");
    setBusy(true);
    try {
      await api(`/invoices/${selectedInvoice.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      }, session);
      await viewInvoice(selectedInvoice.id);
      setInvoices((current) => current.map((invoice) => invoice.id === selectedInvoice.id
        ? { ...invoice, status: "CANCELLED", cancellationReason: reason.trim() }
        : invoice));
      setRefreshVersion((version) => version + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Invoice could not be cancelled.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!serverWasVerified) return;
    let active = true;
    let checking = false;
    const checkHealth = async () => {
      if (checking) return;
      checking = true;
      try {
        await api<{ status: string }>("/health");
        if (active) setConnectionStatus("connected");
      } catch {
        if (active) setConnectionStatus("disconnected");
      } finally {
        checking = false;
      }
    };
    void checkHealth();
    const interval = window.setInterval(checkHealth, 15_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [session?.token, serverWasVerified]);

  useEffect(() => {
    if (connectionStatus !== "connected") return;
    let active = true;
    api<{ businesses: Business[] }>("/businesses")
      .then(({ businesses: available }) => {
        if (!active) return;
        setBusinesses(available);
        setBusinessId((current) => available.some((business) => business.id === current)
          ? current
          : available[0]?.id ?? "");
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Could not load businesses.");
      });
    return () => { active = false; };
  }, [connectionStatus]);

  async function connectToServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusinesses([]);
    setBusinessId("");
    setPendingPairing(null);
    setPairingAttempt(null);
    setPairingStatus("");
    clearActiveDeviceCredential();
    setConnectionStatus("connecting");
    setServerWasVerified(false);
    try {
      const verified = await verifyServerConnection(serverAddress);
      setServerAddress(verified.serverUrl);
      setServerWasVerified(true);
      setConnectionStatus("connected");
    } catch (reason) {
      setConnectionStatus("error");
      setError(reason instanceof Error ? reason.message : "Could not connect to the server.");
    }
  }

  useEffect(() => {
    if (!session || (view !== "billing" && view !== "products" && view !== "purchases")) return;
    let active = true;
    const requestController = new AbortController();
    setProductsLoading(true);
    const refreshProducts = async () => {
      try {
        const { products: available } = await api<{ products: Product[] }>(
          `/products${search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ""}`,
          { signal: requestController.signal },
          session,
        );
        if (!active) return;
        setProducts(available);
        setProductsError(null);
      } catch (reason) {
        if (!active) return;
        setProductsError(reason instanceof Error ? reason.message : "Could not load products.");
      } finally {
        if (active) setProductsLoading(false);
      }
    };
    const stopWatching = watchForProductRefresh(
      refreshProducts,
      (reason) => {
        if (active) {
          setProductsError(reason instanceof Error ? reason.message : "Could not load products.");
          setProductsLoading(false);
        }
      },
      document,
    );
    return () => {
      active = false;
      requestController.abort();
      stopWatching();
    };
  }, [session, search, view, refreshVersion]);

  useEffect(() => {
    if (!session || view !== "billing") return;
    api<{ customers: Customer[] }>("/customers", {}, session)
      .then(({ customers: records }) => setCustomers(records))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load customers."));
  }, [session, view]);

  useEffect(() => {
    if (!session || view !== "purchases") return;
    Promise.all([
      api<{ suppliers: Supplier[] }>("/suppliers", {}, session),
      api<{ purchases: Purchase[] }>("/purchases", {}, session),
    ])
      .then(([supplierResult, purchaseResult]) => {
        setSuppliers(supplierResult.suppliers);
        setPurchases(purchaseResult.purchases);
        setPurchaseSupplierId((current) => current || supplierResult.suppliers[0]?.id || "");
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load purchase records."));
  }, [session, view, refreshVersion]);

  useEffect(() => {
    if (!session || view !== "devices") return;
    api<{ devices: PairedDevice[] }>("/pairing/devices", {}, session)
      .then(({ devices }) => setPairedDevices(devices))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Paired devices could not be loaded."));
  }, [session, view, refreshVersion]);

  useEffect(() => {
    if (!pendingPairing) return;
    let active = true;
    let checking = false;
    const checkStatus = async () => {
      if (!active || checking) return;
      checking = true;
      try {
        const result = await api<{ status: "pending" | "approved" | "revoked" }>(
          `/pairing/${pendingPairing.deviceId}/status`,
          { headers: { "x-pairing-poll-token": pendingPairing.pollToken } },
        );
        if (!active) return;
        if (result.status === "approved") {
          await saveDeviceCredential(serverAddress, pendingPairing.businessId, {
            deviceId: pendingPairing.deviceId,
            credential: pendingPairing.credential,
          });
          if (!active) return;
          setPairingStatus("Approved and saved securely. Select the paired business and sign in.");
          setPendingPairing(null);
          setPairingAttempt(null);
        } else if (result.status === "revoked") {
          setPairingStatus("This pairing request was revoked by the server administrator.");
          setPendingPairing(null);
        } else {
          setPairingStatus("Waiting for the server administrator to approve this computer.");
        }
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : "Pairing status could not be checked.";
        if (!active) return;
        if (message.includes("expired")) {
          setPairingStatus("This pairing request expired. Ask the administrator for a new code.");
          setPendingPairing(null);
        } else {
          setPairingStatus(`Pairing status unavailable; retrying. ${message}`);
        }
      } finally {
        checking = false;
      }
    };
    void checkStatus();
    const interval = window.setInterval(checkStatus, 2500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [pendingPairing, serverAddress]);

  useEffect(() => {
    if (!session || view !== "users") return;
    api<{ users: BusinessUser[] }>("/users", {}, session)
      .then(({ users }) => setBusinessUsers(users))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load business users."));
  }, [session, view, refreshVersion]);

  useEffect(() => {
    if (!session || view !== "billing" || cart.length === 0) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    setPreview(null);
    api<{ preview: InvoicePreview }>("/invoices/preview", {
      method: "POST",
      body: JSON.stringify(createInvoicePreviewPayload(customerId, cart)),
      signal: controller.signal,
    }, session)
      .then(({ preview: currentPreview }) => setPreview(currentPreview))
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setError(reason instanceof Error ? reason.message : "Could not calculate this bill.");
        }
      });
    return () => controller.abort();
  }, [session, view, cart, customerId, previewVersion]);

  useEffect(() => {
    if (!preview || paymentsEdited || paymentAllocations.length !== 1) return;
    setPaymentAllocations((current) => current.map((payment) => ({ ...payment, amount: preview.grandTotal })));
  }, [preview, paymentsEdited, paymentAllocations.length]);

  useEffect(() => {
    if (!session || view !== "invoices") return;
    api<{ invoices: Invoice[] }>("/invoices", {}, session)
      .then(({ invoices: recent }) => setInvoices(recent))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load invoices."));
  }, [session, view]);

  useEffect(() => {
    if (!session || view !== "settings") return;
    setSettingsLoaded(false);
    api<{ settings: BusinessSettings | null }>("/settings", {}, session)
      .then(({ settings: saved }) => {
        setSettings(saved);
        if (saved) {
          setSettingsForm({
            address: saved.address ?? "",
            phone: saved.phone ?? "",
            gstin: saved.gstin ?? "",
            stateCode: saved.stateCode ?? "",
            invoicePrefix: saved.invoicePrefix,
            allowCredit: saved.allowCredit,
            pricesIncludeGst: saved.pricesIncludeGst === null ? "" : saved.pricesIncludeGst ? "inclusive" : "exclusive",
            logoDataUrl: saved.logoDataUrl ?? "",
            termsAndConditions: saved.termsAndConditions ?? "",
            warrantyNote: saved.warrantyNote ?? "",
            bankDetails: saved.bankDetails ?? "",
            authorisedSignatory: saved.authorisedSignatory ?? "",
          });
        } else {
          setSettingsForm((form) => ({ ...form, pricesIncludeGst: "" }));
        }
        setSettingsLoaded(true);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load business settings."));
  }, [session, view]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (connectionStatus !== "connected") {
      setError("Connect to a ready server before signing in.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const credential = await loadDeviceCredential(serverAddress, businessId);
      if (credential) setActiveDeviceCredential(serverAddress, businessId, credential);
      const nextSession = await api<Session>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ businessId, username, password }),
      });
      setSession(nextSession);
      setPassword("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (session) {
      try {
        await api<void>("/auth/logout", { method: "POST" }, session);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not sign out from the server.");
      }
    }
    setSession(null);
    setProducts([]);
    setProductsLoading(false);
    setProductsError(null);
    setCart([]);
    setPreview(null);
    setInvoices([]);
    setPurchases([]);
    setSuppliers([]);
    setBusinessUsers([]);
    setCustomers([]);
    setCustomerId("");
    setCustomerName("");
    setCustomerPhone("");
    setPurchaseLines([]);
    setLastInvoice(null);
    setSelectedInvoice(null);
    setSettings(null);
    setSettingsLoaded(false);
    setAdminInvitation(null);
    setPairedDevices([]);
    setPairingStatus("");
    setPendingPairing(null);
    setView("billing");
    setError("");
  }

  function replaceCart(nextCart: DraftLine[]) {
    setCart(nextCart);
    setIdempotencyKey(crypto.randomUUID());
    setPaymentsEdited(false);
    setPaymentAllocations((current) => [{ key: current[0]?.key ?? crypto.randomUUID(), method: current[0]?.method ?? "Cash", amount: "" }]);
    setLastInvoice(null);
    setError("");
  }

  function addProduct(productId: string) {
    const existing = cart.find((line) => line.productId === productId);
    replaceCart(existing
      ? cart.map((line) => line.productId === productId
        ? { ...line, quantity: String(Number(line.quantity) + 1) }
        : line)
      : [...cart, { productId, quantity: "1", discountPercent: "0" }]);
  }

  async function finalizeBill() {
    if (!session || !preview) return;
    setError("");
    setBusy(true);
    try {
      const invoiceLines = serializeInvoiceDraftLines(cart).map((line) => ({
        ...line,
        expectedUnitPrice: preview.lines.find((item) => item.productId === line.productId)?.unitPrice,
      }));
      const result = await api<{ invoice: Invoice }>("/invoices", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey,
          customerId: customerId || null,
          lines: invoiceLines,
          payments: paymentAllocations.map(({ method, amount }) => ({ method, amount })),
        }),
      }, session);
      setLastInvoice(result.invoice);
      setCart([]);
      setPreview(null);
      setIdempotencyKey(crypto.randomUUID());
      setView("invoices");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Invoice could not be finalized.");
      setPreviewVersion((version) => version + 1);
    } finally {
      setBusy(false);
    }
  }

  async function createProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setError("");
    setBusy(true);
    try {
      await api("/products", {
        method: "POST",
        body: JSON.stringify({
          ...newProduct,
          gstRate: newProduct.gstRate.trim() ? Number(newProduct.gstRate) : null,
          purchasePrice: newProduct.purchasePrice.trim() ? Number(newProduct.purchasePrice) : null,
          sellingPrice: newProduct.sellingPrice.trim() ? Number(newProduct.sellingPrice) : null,
          minimumStock: Number(newProduct.minimumStock),
        }),
      }, session);
      setNewProduct({ name: "", sku: "", category: "", brand: "", model: "", specifications: "", packSize: "", catalogSourceUrl: "", unit: "Piece", gstRate: "", purchasePrice: "", sellingPrice: "", minimumStock: "0" });
      setRefreshVersion((version) => version + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Product could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  function beginProductEdit(product: Product) {
    setEditingProductId(product.id);
    setProductEdit({
      category: product.category ?? "",
      brand: product.brand ?? "",
      model: product.model ?? "",
      specifications: product.specifications ?? "",
      packSize: product.packSize ?? "",
      catalogSourceUrl: product.catalogSourceUrl ?? "",
      gstRate: product.gstRate ?? "",
      purchasePrice: product.purchasePrice ?? "",
      sellingPrice: product.sellingPrice ?? "",
    });
  }

  async function saveProductEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !editingProductId) return;
    setError("");
    setBusy(true);
    try {
      await api(`/products/${encodeURIComponent(editingProductId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          category: productEdit.category.trim() || null,
          brand: productEdit.brand.trim() || null,
          model: productEdit.model.trim() || null,
          specifications: productEdit.specifications.trim() || null,
          packSize: productEdit.packSize.trim() || null,
          catalogSourceUrl: productEdit.catalogSourceUrl.trim() || null,
          gstRate: productEdit.gstRate.trim() ? Number(productEdit.gstRate) : null,
          purchasePrice: productEdit.purchasePrice.trim() ? Number(productEdit.purchasePrice) : null,
          sellingPrice: productEdit.sellingPrice.trim() ? Number(productEdit.sellingPrice) : null,
        }),
      }, session);
      setEditingProductId(null);
      setRefreshVersion((version) => version + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Product could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  async function adjustStock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setError("");
    setBusy(true);
    try {
      await api("/inventory/adjustments", {
        method: "POST",
        body: JSON.stringify(adjustment),
      }, session);
      setAdjustment({ ...adjustment, quantityChange: "", reason: "" });
      setRefreshVersion((version) => version + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Stock adjustment was rejected.");
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !settingsForm.pricesIncludeGst) return;
    setError("");
    setBusy(true);
    try {
      const result = await api<{ settings: BusinessSettings }>("/settings", {
        method: "PUT",
        body: JSON.stringify({
          address: settingsForm.address || null,
          phone: settingsForm.phone || null,
          gstin: settingsForm.gstin || null,
          stateCode: settingsForm.stateCode || null,
          logoDataUrl: settingsForm.logoDataUrl || null,
          termsAndConditions: settingsForm.termsAndConditions || null,
          warrantyNote: settingsForm.warrantyNote || null,
          bankDetails: settingsForm.bankDetails || null,
          authorisedSignatory: settingsForm.authorisedSignatory || null,
          invoicePrefix: settingsForm.invoicePrefix,
          allowCredit: settingsForm.allowCredit,
          pricesIncludeGst: settingsForm.pricesIncludeGst === "inclusive",
        }),
      }, session);
      setSettings(result.settings);
      setSettingsLoaded(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Business settings could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  function loadInvoiceLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 175_000) {
      setError("Choose a PNG, JPEG, or WebP logo smaller than 175 KB.");
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setSettingsForm((form) => ({ ...form, logoDataUrl: reader.result as string }));
        setError("");
      }
    };
    reader.onerror = () => setError("The selected logo could not be read.");
    reader.readAsDataURL(file);
  }

  async function createSupplier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setError("");
    setBusy(true);
    try {
      const result = await api<{ supplier: Supplier }>("/suppliers", {
        method: "POST",
        body: JSON.stringify({ name: supplierName, phone: supplierPhone || null }),
      }, session);
      setSuppliers((current) => [...current, result.supplier].sort((a, b) => a.name.localeCompare(b.name)));
      setPurchaseSupplierId(result.supplier.id);
      setSupplierName("");
      setSupplierPhone("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Supplier could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function finalizePurchaseForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setError("");
    setBusy(true);
    try {
      await api("/purchases", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: purchaseIdempotencyKey,
          supplierId: purchaseSupplierId,
          supplierInvoiceNumber: supplierInvoiceNumber || null,
          lines: purchaseLines.map(({ productId, quantity, unitCost, discountPercent }) => ({
            productId,
            quantity,
            unitCost,
            discountPercent: Number(discountPercent),
          })),
        }),
      }, session);
      setPurchaseLines([]);
      setSupplierInvoiceNumber("");
      setPurchaseIdempotencyKey(crypto.randomUUID());
      setRefreshVersion((version) => version + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Purchase could not be finalized.");
    } finally {
      setBusy(false);
    }
  }

  async function createBusinessUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setError("");
    setBusy(true);
    try {
      await api("/users", { method: "POST", body: JSON.stringify(newUser) }, session);
      setNewUser({ username: "", displayName: "", password: "", role: "BILLING_OPERATOR" });
      setRefreshVersion((version) => version + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "User could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function updateUserRole(userId: string, role: string) {
    if (!session) return;
    setError("");
    try {
      await api(`/users/${userId}/role`, { method: "PATCH", body: JSON.stringify({ role }) }, session);
      setRefreshVersion((version) => version + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "User role could not be changed.");
      setRefreshVersion((version) => version + 1);
    }
  }

  async function resetUserPassword(userId: string) {
    if (!session || !resetPassword[userId]) return;
    setError("");
    setBusy(true);
    try {
      await api(`/users/${userId}/password-reset`, {
        method: "POST",
        body: JSON.stringify({ password: resetPassword[userId] }),
      }, session);
      setResetPassword((current) => ({ ...current, [userId]: "" }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Password reset failed.");
    } finally {
      setBusy(false);
    }
  }

  async function removeUserAssignment(userId: string) {
    if (!session || !window.confirm("Remove this user's access to the selected business? Historical records will be preserved.")) return;
    setError("");
    try {
      await api<void>(`/users/${userId}/assignment`, { method: "DELETE" }, session);
      setRefreshVersion((version) => version + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Business access could not be removed.");
    }
  }

  async function createCustomer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setError("");
    setBusy(true);
    try {
      const result = await api<{ customer: Customer }>("/customers", {
        method: "POST",
        body: JSON.stringify({
          name: customerName,
          phone: customerPhone || null,
          address: customerAddress || null,
          gstin: customerGstin || null,
          stateCode: customerStateCode || null,
        }),
      }, session);
      setCustomers((current) => [...current, result.customer].sort((a, b) => a.name.localeCompare(b.name)));
      setCustomerId(result.customer.id);
      setCustomerName("");
      setCustomerPhone("");
      setCustomerAddress("");
      setCustomerGstin("");
      setCustomerStateCode("");
      setIdempotencyKey(crypto.randomUUID());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Customer could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  if (session) {
    const canManage = session.role === "SYSTEM_ADMIN" || session.role === "BUSINESS_ADMIN";
    const canCreateCustomer = canManage || session.role === "BILLING_OPERATOR";
    return (
      <main className="workspace">
        <header className="topbar">
          <div className="brand-mark">MB</div>
          <div className="business-heading">
            <strong>{session.business.name}</strong>
            <span>Inventory &amp; catalogue</span>
          </div>
          <div className="user-menu">
            <span>{session.user.displayName} · {session.role.replaceAll("_", " ").toLowerCase()}</span>
            <button className="quiet-button" onClick={signOut}>Sign out</button>
          </div>
        </header>
        <nav className="workspace-nav" aria-label="Main navigation">
          <button className={view === "billing" ? "active" : ""} onClick={() => setView("billing")}>Billing</button>
          <button className={view === "invoices" ? "active" : ""} onClick={() => setView("invoices")}>Invoices</button>
          <button className={view === "products" ? "active" : ""} onClick={() => setView("products")}>Products</button>
          {canManage && <button className={view === "purchases" ? "active" : ""} onClick={() => setView("purchases")}>Purchases</button>}
          {canManage && <button className={view === "users" ? "active" : ""} onClick={() => setView("users")}>Users</button>}
          {canManage && <button className={view === "devices" ? "active" : ""} onClick={() => setView("devices")}>Devices</button>}
          {canManage && <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>Settings</button>}
        </nav>
        <section className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">BUSINESS WORKSPACE</p>
              <h1>{view === "billing" ? "Create a bill" : view === "invoices" ? "Invoices" : view === "purchases" ? "Purchases" : view === "users" ? "Users & permissions" : view === "settings" ? "Business settings" : view === "devices" ? "Paired devices" : "Products"}</h1>
              <p className="subheading">{session.business.name} · Prices and stock are controlled by the server.</p>
            </div>
            <span className={`connection ${connectionStatus}`}><i /> {connectionStatus === "connecting" ? "Connecting" : connectionStatus === "connected" ? "Server ready" : connectionStatus === "error" ? "Connection error" : "Disconnected"}</span>
          </div>
          {error && <div className="alert" role="alert">{error}</div>}
          {productsError && <div className="alert" role="alert">Products could not be refreshed: {productsError}</div>}
          {view === "devices" && canManage && (
            <>
              <div className="management-card">
                <h2>Approve a client computer</h2>
                <p>Create a one-time code for this business. The client must redeem it before it expires, and this administrator must approve its request.</p>
                <button className="primary-button" type="button" disabled={busy} onClick={createPairingInvitation}>Create pairing code</button>
                {adminInvitation && (
                  <div className="success-banner" role="status">
                    <strong>Share this code with the client now:</strong>
                    <p><code>{adminInvitation.code}</code></p>
                    <small>Expires {new Date(adminInvitation.expiresAt).toLocaleTimeString()} · single use</small>
                  </div>
                )}
              </div>
              <div className="management-card user-list">
                <div className="toolbar">
                  <h2>Client computers</h2>
                  <button className="quiet-button" type="button" onClick={() => setRefreshVersion((version) => version + 1)}>Refresh list</button>
                </div>
                {pairedDevices.map((device) => {
                  const expired = device.status === "PENDING" && new Date(device.pairingExpiresAt) <= new Date();
                  return (
                    <div className="user-row" key={device.deviceId}>
                      <div className="user-details">
                        <strong>{device.name}</strong>
                        <small>{expired ? "Expired" : device.status.toLowerCase()} · Requested {new Date(device.createdAt).toLocaleString()}</small>
                      </div>
                      {device.status === "PENDING" && !expired && (
                        <button className="add-button" disabled={busy} onClick={() => updatePairedDevice(device.deviceId, "approve")}>Approve</button>
                      )}
                      {device.status !== "REVOKED" && (
                        <button className="quiet-button danger-button" disabled={busy} onClick={() => updatePairedDevice(device.deviceId, "revoke")}>Revoke</button>
                      )}
                    </div>
                  );
                })}
                {pairedDevices.length === 0 && <p className="muted">No client computers have requested access.</p>}
              </div>
            </>
          )}
          {(view === "billing" || view === "products" || view === "purchases") && (
            <div className="toolbar">
              <label className="search-box">
                <span aria-hidden="true">⌕</span>
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, SKU, brand or model" />
              </label>
              <span className="result-count" aria-live="polite">
                {productsLoading ? "Loading products…" : `${products.length} products`}
              </span>
            </div>
          )}
          {view === "users" && canManage && (
            <>
              <form className="management-card new-user-card" onSubmit={createBusinessUser}>
                <h2>Add a business user</h2>
                <p>Accounts receive access only to {session.business.name}. Use a unique username and a long temporary password.</p>
                <div className="form-grid">
                  <label>Username<input className="text-input" required maxLength={100} value={newUser.username} onChange={(event) => setNewUser({ ...newUser, username: event.target.value })} /></label>
                  <label>Display name<input className="text-input" required maxLength={150} value={newUser.displayName} onChange={(event) => setNewUser({ ...newUser, displayName: event.target.value })} /></label>
                  <label>Initial password<input className="text-input" type="password" required minLength={12} autoComplete="new-password" value={newUser.password} onChange={(event) => setNewUser({ ...newUser, password: event.target.value })} /></label>
                  <label>Role<select className="text-input" value={newUser.role} onChange={(event) => setNewUser({ ...newUser, role: event.target.value })}>
                    <option value="BUSINESS_ADMIN">Business administrator</option><option value="BILLING_OPERATOR">Billing operator</option><option value="VIEWER">Viewer</option><option value="TESTING_USER">Testing user</option>
                    {session.role === "SYSTEM_ADMIN" && <option value="SYSTEM_ADMIN">System administrator</option>}
                  </select></label>
                </div>
                <button className="primary-button" disabled={busy}>Create user</button>
              </form>
              <div className="management-card user-list">
                <h2>Assigned users</h2>
                {businessUsers.map((user) => (
                  <div className="user-row" key={user.id}>
                    <div className="user-details"><strong>{user.displayName}</strong><small>{user.username} · {user.isActive ? "Active" : "Disabled"}</small></div>
                    <select aria-label={`Role for ${user.username}`} className="text-input role-select" value={user.role}
                      disabled={user.role === "SYSTEM_ADMIN" && session.role !== "SYSTEM_ADMIN"}
                      onChange={(event) => updateUserRole(user.id, event.target.value)}>
                      {session.role === "SYSTEM_ADMIN" && <option value="SYSTEM_ADMIN">System admin</option>}
                      <option value="BUSINESS_ADMIN">Business admin</option><option value="BILLING_OPERATOR">Billing operator</option><option value="VIEWER">Viewer</option><option value="TESTING_USER">Testing user</option>
                    </select>
                    {user.id !== session.user.id && (
                      <details className="reset-password">
                        <summary>Reset password</summary>
                        <div className="reset-controls">
                          <input className="text-input" type="password" minLength={12} autoComplete="new-password" aria-label={`New password for ${user.username}`}
                            value={resetPassword[user.id] ?? ""} onChange={(event) => setResetPassword((current) => ({ ...current, [user.id]: event.target.value }))} />
                          <button type="button" className="quiet-button" disabled={busy || (resetPassword[user.id] ?? "").length < 12} onClick={() => resetUserPassword(user.id)}>Set</button>
                        </div>
                      </details>
                    )}
                    {user.id !== session.user.id && <button className="remove-access" onClick={() => removeUserAssignment(user.id)}>Remove access</button>}
                  </div>
                ))}
                {businessUsers.length === 0 && <p className="empty-bill">No users are assigned to this business.</p>}
              </div>
            </>
          )}
          {view === "purchases" && canManage && (
            <>
              <div className="management-grid">
                <form className="management-card" onSubmit={createSupplier}>
                  <h2>Add supplier</h2>
                  <div className="form-grid">
                    <label>Name<input className="text-input" required value={supplierName} onChange={(event) => { setSupplierName(event.target.value); setPurchaseIdempotencyKey(crypto.randomUUID()); }} /></label>
                    <label>Phone<input className="text-input" value={supplierPhone} onChange={(event) => { setSupplierPhone(event.target.value); setPurchaseIdempotencyKey(crypto.randomUUID()); }} /></label>
                  </div>
                  <button className="primary-button" disabled={busy}>Save supplier</button>
                </form>
                <form className="management-card" onSubmit={finalizePurchaseForm}>
                  <h2>Receive a purchase</h2>
                  <label>Supplier<select className="text-input" required value={purchaseSupplierId} onChange={(event) => { setPurchaseSupplierId(event.target.value); setPurchaseIdempotencyKey(crypto.randomUUID()); }}>
                    <option value="">Choose supplier</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
                  </select></label>
                  <label>Supplier invoice number<input className="text-input" value={supplierInvoiceNumber} onChange={(event) => { setSupplierInvoiceNumber(event.target.value); setPurchaseIdempotencyKey(crypto.randomUUID()); }} /></label>
                  {purchaseLines.map((line) => (
                    <div className="purchase-draft-line" key={line.key}>
                      <select aria-label="Purchase product" className="text-input" required value={line.productId} onChange={(event) => { setPurchaseIdempotencyKey(crypto.randomUUID()); setPurchaseLines((current) => current.map((item) => item.key === line.key ? { ...item, productId: event.target.value } : item)); }}>
                        <option value="">Product</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
                      </select>
                      <input aria-label="Purchase quantity" className="text-input" type="number" min="0.001" step="0.001" required placeholder="Qty" value={line.quantity} onChange={(event) => { setPurchaseIdempotencyKey(crypto.randomUUID()); setPurchaseLines((current) => current.map((item) => item.key === line.key ? { ...item, quantity: event.target.value } : item)); }} />
                      <input aria-label="Purchase unit cost" className="text-input" type="number" min="0" step="0.01" required placeholder="Cost" value={line.unitCost} onChange={(event) => { setPurchaseIdempotencyKey(crypto.randomUUID()); setPurchaseLines((current) => current.map((item) => item.key === line.key ? { ...item, unitCost: event.target.value } : item)); }} />
                      <input aria-label="Purchase discount percent" className="text-input" type="number" min="0" max="100" step="0.01" placeholder="Disc %" value={line.discountPercent} onChange={(event) => { setPurchaseIdempotencyKey(crypto.randomUUID()); setPurchaseLines((current) => current.map((item) => item.key === line.key ? { ...item, discountPercent: event.target.value } : item)); }} />
                      <button type="button" className="remove-button" aria-label="Remove purchase line" onClick={() => { setPurchaseIdempotencyKey(crypto.randomUUID()); setPurchaseLines((current) => current.filter((item) => item.key !== line.key)); }}>×</button>
                    </div>
                  ))}
                  <button type="button" className="quiet-button" onClick={() => { setPurchaseIdempotencyKey(crypto.randomUUID()); setPurchaseLines((current) => [...current, { key: crypto.randomUUID(), productId: "", quantity: "1", unitCost: "", discountPercent: "0" }]); }}>Add purchase line</button>
                  <button className="primary-button" disabled={busy || !purchaseSupplierId || purchaseLines.length === 0}>Finalize receipt and update stock</button>
                  <p className="footnote">Stock changes only after the server successfully finalizes this purchase.</p>
                </form>
              </div>
              <div className="table-wrap purchase-history">
                <table>
                  <thead><tr><th>Purchase</th><th>Date</th><th>Supplier invoice</th><th>Lines</th><th className="numeric">Subtotal</th><th className="numeric">Tax</th><th className="numeric">Total</th></tr></thead>
                  <tbody>
                    {purchases.map((purchase) => <tr key={purchase.id}>
                      <td><strong>{purchase.purchaseNumber}</strong></td><td>{new Date(purchase.purchaseDate).toLocaleDateString()}</td>
                      <td>{purchase.supplierInvoiceNumber ?? "—"}</td><td>{purchase.lines.length}</td>
                      <td className="numeric">₹{purchase.subtotal}</td><td className="numeric">₹{purchase.taxTotal}</td><td className="numeric price">₹{purchase.grandTotal}</td>
                    </tr>)}
                    {purchases.length === 0 && <tr><td className="empty" colSpan={7}>No purchases have been finalized.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {view === "billing" && (
            <div className="billing-layout">
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Product</th><th>SKU</th><th>Stock</th><th className="numeric">Price</th><th /></tr></thead>
                  <tbody>
                    {products.map((product) => (
                      <tr key={product.id}>
                        <td><strong>{product.name}</strong><small>{[product.brand, product.model].filter(Boolean).join(" · ")}</small></td>
                        <td className="muted">{product.sku}</td>
                        <td>{product.stockQuantity} {product.unit}</td>
                        <td className="numeric price">{product.sellingPrice === null ? "Price not set" : `₹${Number(product.sellingPrice).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`}</td>
                        <td><button className="add-button" onClick={() => addProduct(product.id)} disabled={product.sellingPrice === null || product.gstRate === null || Number(product.stockQuantity) <= 0}>Add</button></td>
                      </tr>
                    ))}
                    {products.length === 0 && <tr><td colSpan={5} className="empty">No active products found.</td></tr>}
                  </tbody>
                </table>
              </div>
              <aside className="bill-card">
                <div className="bill-card-heading"><strong>Current bill</strong><span>{cart.length} items</span></div>
                <label className="field-label" htmlFor="bill-customer">Customer</label>
                <select id="bill-customer" className="text-input" value={customerId} onChange={(event) => { setCustomerId(event.target.value); setIdempotencyKey(crypto.randomUUID()); }}>
                  <option value="">Walk-in customer</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}{customer.phone ? ` · ${customer.phone}` : ""}</option>)}
                </select>
                {canCreateCustomer && (
                  <details className="quick-contact">
                    <summary>Add customer</summary>
                    <form onSubmit={createCustomer}>
                      <input className="text-input" aria-label="New customer name" placeholder="Customer name" required value={customerName} onChange={(event) => setCustomerName(event.target.value)} />
                      <input className="text-input" aria-label="New customer phone" placeholder="Phone (optional)" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} />
                      <input className="text-input" aria-label="New customer address" placeholder="Address (optional)" value={customerAddress} onChange={(event) => setCustomerAddress(event.target.value)} />
                      <input className="text-input" aria-label="New customer GSTIN" placeholder="GSTIN (optional)" value={customerGstin} onChange={(event) => setCustomerGstin(event.target.value)} />
                      <input className="text-input" aria-label="New customer state code" inputMode="numeric" maxLength={2} placeholder="State code (optional)" value={customerStateCode} onChange={(event) => setCustomerStateCode(event.target.value)} />
                      <button className="quiet-button" disabled={busy}>Save customer</button>
                    </form>
                  </details>
                )}
                {cart.length === 0 ? <p className="empty-bill">Search and add products to begin.</p> : (
                  <div className="cart-lines">
                    {cart.map((line) => {
                      const product = products.find((item) => item.id === line.productId);
                      const linePreview = preview?.lines.find((item) => item.productId === line.productId);
                      return (
                        <div className="cart-line" key={line.productId}>
                          <div><strong>{product?.name ?? linePreview?.productName}</strong><small>{linePreview ? `₹${linePreview.lineTotal}` : "Calculating…"}</small></div>
                          <input aria-label={`Quantity for ${product?.name ?? "product"}`} type="number" min="0.001" step="0.001" value={line.quantity}
                            onChange={(event) => replaceCart(cart.map((item) => item.productId === line.productId ? { ...item, quantity: event.target.value } : item))} />
                          <input aria-label={`Discount percent for ${product?.name ?? "product"}`} type="number" min="0" max="100" step="0.01" value={line.discountPercent}
                            onChange={(event) => replaceCart(cart.map((item) => item.productId === line.productId ? { ...item, discountPercent: event.target.value } : item))} />
                          <button aria-label={`Remove ${product?.name ?? "product"}`} className="remove-button" onClick={() => replaceCart(cart.filter((item) => item.productId !== line.productId))}>×</button>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="bill-total"><span>Total (server preview)</span><strong>{preview ? `₹${Number(preview.grandTotal).toLocaleString("en-IN", { minimumFractionDigits: 2 })}` : "—"}</strong></div>
                <div className="payment-heading"><span className="field-label">Payment allocations</span><button type="button" className="quiet-button" disabled={paymentAllocations.length >= 10} onClick={() => { setPaymentsEdited(true); setPaymentAllocations((current) => [...current, { key: crypto.randomUUID(), method: "UPI", amount: "" }]); }}>Split payment</button></div>
                {paymentAllocations.map((payment) => (
                  <div className="payment-row" key={payment.key}>
                    <select aria-label="Payment method" className="text-input" value={payment.method} onChange={(event) => { setPaymentsEdited(true); setPaymentAllocations((current) => current.map((item) => item.key === payment.key ? { ...item, method: event.target.value } : item)); }}>
                      <option>Cash</option><option>UPI</option><option>Card</option><option>Other</option>
                    </select>
                    <input aria-label="Payment amount" className="text-input" inputMode="decimal" type="number" min="0" step="0.01" required value={payment.amount} onChange={(event) => { setPaymentsEdited(true); setPaymentAllocations((current) => current.map((item) => item.key === payment.key ? { ...item, amount: event.target.value } : item)); }} />
                    {paymentAllocations.length > 1 && <button type="button" aria-label="Remove payment allocation" className="remove-button" onClick={() => { setPaymentsEdited(true); setPaymentAllocations((current) => current.filter((item) => item.key !== payment.key)); }}>×</button>}
                  </div>
                ))}
                <button className="primary-button" disabled={busy || cart.length === 0 || !preview || paymentAllocations.some((payment) => !payment.amount)} onClick={finalizeBill}>
                  {busy ? "Finalizing…" : "Finalize invoice"}
                </button>
                <p className="footnote">The server revalidates price, tax, payment, and stock in one transaction.</p>
              </aside>
            </div>
          )}
          {view === "products" && (
            <>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Product</th><th>SKU</th><th>Category / brand</th><th>Pack</th><th>Stock</th><th>Unit</th><th>GST</th><th className="numeric">Selling price</th>{canManage && <th />}</tr></thead>
                  <tbody>
                    {products.map((product) => (
                      <tr key={product.id}>
                        <td><strong>{product.name}</strong>{product.model && <small>{product.model}</small>}{product.specifications && <small>{product.specifications}</small>}</td>
                        <td className="muted">{product.sku}</td>
                        <td>{[product.category, product.brand].filter(Boolean).join(" · ") || "—"}</td>
                        <td>{product.packSize ?? "—"}</td>
                        <td>{product.stockQuantity}</td>
                        <td>{product.unit}</td>
                        <td>{product.gstRate === null ? "Not set" : `${product.gstRate}%`}</td>
                        <td className="numeric price">{product.sellingPrice === null ? "Not set" : `₹${Number(product.sellingPrice).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`}</td>
                        {canManage && <td><button type="button" className="quiet-button" onClick={() => beginProductEdit(product)}>Edit</button></td>}
                      </tr>
                    ))}
                    {products.length === 0 && <tr><td colSpan={canManage ? 9 : 8} className="empty">No active products found.</td></tr>}
                  </tbody>
                </table>
              </div>
              {canManage && (
                <div className="management-grid">
                  {editingProductId && (
                    <form className="management-card" onSubmit={saveProductEdit}>
                      <h2>Edit product</h2>
                      <div className="form-grid">
                        <label>Category<input className="text-input" value={productEdit.category} onChange={(event) => setProductEdit({ ...productEdit, category: event.target.value })} /></label>
                        <label>Brand<input className="text-input" value={productEdit.brand} onChange={(event) => setProductEdit({ ...productEdit, brand: event.target.value })} /></label>
                        <label>Model<input className="text-input" value={productEdit.model} onChange={(event) => setProductEdit({ ...productEdit, model: event.target.value })} /></label>
                        <label>Pack size<input className="text-input" value={productEdit.packSize} onChange={(event) => setProductEdit({ ...productEdit, packSize: event.target.value })} /></label>
                        <label>Specifications<input className="text-input" value={productEdit.specifications} onChange={(event) => setProductEdit({ ...productEdit, specifications: event.target.value })} /></label>
                        <label>Manufacturer source URL<input className="text-input" type="url" value={productEdit.catalogSourceUrl} onChange={(event) => setProductEdit({ ...productEdit, catalogSourceUrl: event.target.value })} /></label>
                        <label>GST rate (%)<input className="text-input" type="number" min="0" max="100" step="0.01" value={productEdit.gstRate} onChange={(event) => setProductEdit({ ...productEdit, gstRate: event.target.value })} /></label>
                        <label>Purchase price<input className="text-input" type="number" min="0" step="0.01" value={productEdit.purchasePrice} onChange={(event) => setProductEdit({ ...productEdit, purchasePrice: event.target.value })} /></label>
                        <label>Selling price<input className="text-input" type="number" min="0" step="0.01" value={productEdit.sellingPrice} onChange={(event) => setProductEdit({ ...productEdit, sellingPrice: event.target.value })} /></label>
                      </div>
                      <div className="form-actions">
                        <button className="primary-button" disabled={busy}>Save changes</button>
                        <button type="button" className="quiet-button" onClick={() => setEditingProductId(null)}>Cancel</button>
                      </div>
                    </form>
                  )}
                  <form className="management-card" onSubmit={createProduct}>
                    <h2>Add a product</h2>
                    <p>Unknown prices and tax remain unset; configure them before billing or receiving stock.</p>
                    <div className="form-grid">
                      <label>Name<input className="text-input" required value={newProduct.name} onChange={(event) => setNewProduct({ ...newProduct, name: event.target.value })} /></label>
                      <label>SKU<input className="text-input" required value={newProduct.sku} onChange={(event) => setNewProduct({ ...newProduct, sku: event.target.value })} /></label>
                      <label>Category<input className="text-input" value={newProduct.category} onChange={(event) => setNewProduct({ ...newProduct, category: event.target.value })} /></label>
                      <label>Brand<input className="text-input" value={newProduct.brand} onChange={(event) => setNewProduct({ ...newProduct, brand: event.target.value })} /></label>
                      <label>Model<input className="text-input" value={newProduct.model} onChange={(event) => setNewProduct({ ...newProduct, model: event.target.value })} /></label>
                      <label>Pack size<input className="text-input" value={newProduct.packSize} onChange={(event) => setNewProduct({ ...newProduct, packSize: event.target.value })} /></label>
                      <label>Specifications<input className="text-input" value={newProduct.specifications} onChange={(event) => setNewProduct({ ...newProduct, specifications: event.target.value })} /></label>
                      <label>Manufacturer source URL<input className="text-input" type="url" value={newProduct.catalogSourceUrl} onChange={(event) => setNewProduct({ ...newProduct, catalogSourceUrl: event.target.value })} /></label>
                      <label>Unit<select className="text-input" value={newProduct.unit} onChange={(event) => setNewProduct({ ...newProduct, unit: event.target.value })}>
                        <option>Piece</option><option>Box</option><option>Litre</option><option>Millilitre</option><option>Kilogram</option>
                      </select></label>
                      <label>GST rate (%)<input className="text-input" type="number" min="0" max="100" step="0.01" value={newProduct.gstRate} onChange={(event) => setNewProduct({ ...newProduct, gstRate: event.target.value })} /></label>
                      <label>Purchase price<input className="text-input" type="number" min="0" step="0.01" value={newProduct.purchasePrice} onChange={(event) => setNewProduct({ ...newProduct, purchasePrice: event.target.value })} /></label>
                      <label>Selling price<input className="text-input" type="number" min="0" step="0.01" value={newProduct.sellingPrice} onChange={(event) => setNewProduct({ ...newProduct, sellingPrice: event.target.value })} /></label>
                    </div>
                    <button className="primary-button" disabled={busy}>Save product</button>
                  </form>
                  <form className="management-card" onSubmit={adjustStock}>
                    <h2>Adjust stock</h2>
                    <p>Use a positive quantity to receive stock or a negative quantity to reduce it.</p>
                    <label>Product<select className="text-input" required value={adjustment.productId} onChange={(event) => setAdjustment({ ...adjustment, productId: event.target.value })}>
                      <option value="">Choose a product</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.sku}</option>)}
                    </select></label>
                    <label>Quantity change<input className="text-input" required value={adjustment.quantityChange} onChange={(event) => setAdjustment({ ...adjustment, quantityChange: event.target.value })} placeholder="e.g. 12 or -2" /></label>
                    <label>Reason<input className="text-input" required value={adjustment.reason} onChange={(event) => setAdjustment({ ...adjustment, reason: event.target.value })} /></label>
                    <button className="primary-button" disabled={busy}>Post adjustment</button>
                  </form>
                </div>
              )}
            </>
          )}
          {view === "invoices" && (
            <>
              {lastInvoice && <div className="success-banner" role="status">Invoice {lastInvoice.invoiceNumber} finalized. Total ₹{lastInvoice.grandTotal}.</div>}
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Invoice</th><th>Date</th><th>Status</th><th className="numeric">Tax</th><th className="numeric">Total</th><th className="numeric">Due</th><th /></tr></thead>
                  <tbody>
                    {invoices.map((invoice) => (
                      <tr key={invoice.id}><td><strong>{invoice.invoiceNumber}</strong></td><td>{new Date(invoice.createdAt).toLocaleString()}</td>
                        <td>{invoice.status}</td><td className="numeric">₹{invoice.taxTotal}</td><td className="numeric price">₹{invoice.grandTotal}</td><td className="numeric">₹{invoice.balanceDue}</td>
                        <td><button className="add-button" onClick={() => viewInvoice(invoice.id)}>View / Print</button></td></tr>
                    ))}
                    {invoices.length === 0 && <tr><td colSpan={7} className="empty">No finalized invoices yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {view === "settings" && canManage && (
            <form className="management-card settings-card" onSubmit={saveSettings}>
              <h2>Invoice and tax configuration</h2>
              <p>Configure values supplied by your business. GST registration and tax treatment must be verified before production billing.</p>
              <div className="form-grid">
                <label>Invoice prefix<input className="text-input" required maxLength={10} value={settingsForm.invoicePrefix} onChange={(event) => setSettingsForm({ ...settingsForm, invoicePrefix: event.target.value.toUpperCase() })} /></label>
                <label>Product prices are<select className="text-input" required value={settingsForm.pricesIncludeGst} onChange={(event) => setSettingsForm({ ...settingsForm, pricesIncludeGst: event.target.value })}>
                  <option value="">Choose tax pricing mode</option><option value="exclusive">GST-exclusive</option><option value="inclusive">GST-inclusive</option>
                </select></label>
                <label>GSTIN<input className="text-input" value={settingsForm.gstin} onChange={(event) => setSettingsForm({ ...settingsForm, gstin: event.target.value })} /></label>
                <label>State code<input className="text-input" inputMode="numeric" maxLength={2} value={settingsForm.stateCode} onChange={(event) => setSettingsForm({ ...settingsForm, stateCode: event.target.value })} /></label>
                <label>Phone<input className="text-input" value={settingsForm.phone} onChange={(event) => setSettingsForm({ ...settingsForm, phone: event.target.value })} /></label>
                <label>Address<input className="text-input" value={settingsForm.address} onChange={(event) => setSettingsForm({ ...settingsForm, address: event.target.value })} /></label>
                <label>Business logo<input className="text-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={loadInvoiceLogo} /></label>
                <label>Terms and conditions<textarea className="text-input settings-textarea" maxLength={4000} value={settingsForm.termsAndConditions} onChange={(event) => setSettingsForm({ ...settingsForm, termsAndConditions: event.target.value })} /></label>
                <label>Warranty note<textarea className="text-input settings-textarea" maxLength={2000} value={settingsForm.warrantyNote} onChange={(event) => setSettingsForm({ ...settingsForm, warrantyNote: event.target.value })} /></label>
                <label>Bank details<textarea className="text-input settings-textarea" maxLength={1000} value={settingsForm.bankDetails} onChange={(event) => setSettingsForm({ ...settingsForm, bankDetails: event.target.value })} /></label>
                <label>Authorised signatory<input className="text-input" maxLength={160} value={settingsForm.authorisedSignatory} onChange={(event) => setSettingsForm({ ...settingsForm, authorisedSignatory: event.target.value })} /></label>
              </div>
              {settingsForm.logoDataUrl && <div className="settings-logo-preview"><img src={settingsForm.logoDataUrl} alt="Invoice logo preview" /><button type="button" className="quiet-button" onClick={() => setSettingsForm({ ...settingsForm, logoDataUrl: "" })}>Remove logo</button></div>}
              <label className="check-row"><input type="checkbox" checked={settingsForm.allowCredit} onChange={(event) => setSettingsForm({ ...settingsForm, allowCredit: event.target.checked })} /> Allow underpaid credit invoices</label>
              <button className="primary-button" disabled={busy || !settingsLoaded || !settingsForm.pricesIncludeGst}>
                {settings ? "Save business settings" : "Configure business"}
              </button>
            </form>
          )}
        </section>
        {selectedInvoice && (
          <section className="invoice-print" aria-label="Historical invoice">
            <div className="invoice-actions no-print">
              {canManage && selectedInvoice.status === "FINALIZED" && <button className="quiet-button danger-button" disabled={busy} onClick={cancelSelectedInvoice}>Cancel invoice</button>}
              <div className="invoice-copy-controls" role="group" aria-label="Invoice copy type">
                <button type="button" className={`quiet-button${invoiceCopyKind === "ORIGINAL" ? " selected" : ""}`} onClick={() => setInvoiceCopyKind("ORIGINAL")}>Original</button>
                <button type="button" className={`quiet-button${invoiceCopyKind === "DUPLICATE" ? " selected" : ""}`} onClick={() => setInvoiceCopyKind("DUPLICATE")}>Duplicate</button>
              </div>
              <button className="quiet-button" onClick={() => window.print()}>Print / Save as PDF</button>
              <button className="quiet-button" onClick={() => setSelectedInvoice(null)}>Close</button>
            </div>
            <InvoicePrint invoice={selectedInvoice} copyKind={invoiceCopyKind} />
            {canManage && selectedInvoice.status === "FINALIZED" && (
              <form className="invoice-return no-print" onSubmit={submitSalesReturn}>
                <h3>Record a sales return</h3>
                <p>Refund values are calculated and validated by the server. Returned quantities cannot exceed the remaining sold quantity.</p>
                {(selectedInvoice.lines ?? []).map((line) => {
                  const remaining = Math.max(0, Number(line.quantity) - Number(line.returnedQuantity ?? 0));
                  return (
                    <div className="return-line" key={line.id}>
                      <label>{line.productName}<small>{remaining} {line.unit} remaining from this invoice</small>
                        <input className="text-input" type="number" min="0" max={remaining} step="0.001" disabled={remaining === 0}
                          value={salesReturnQuantities[line.id] ?? ""}
                          onChange={(event) => setSalesReturnQuantities((current) => ({ ...current, [line.id]: event.target.value }))} />
                      </label>
                      <label className="check-row"><input type="checkbox" checked={salesReturnStock[line.id] ?? true}
                        onChange={(event) => setSalesReturnStock((current) => ({ ...current, [line.id]: event.target.checked }))} /> Return to stock</label>
                    </div>
                  );
                })}
                <div className="form-grid">
                  <label>Reason<input className="text-input" required maxLength={500} value={salesReturnReason} onChange={(event) => setSalesReturnReason(event.target.value)} /></label>
                  <label>Refund method<select className="text-input" value={salesReturnMethod} onChange={(event) => setSalesReturnMethod(event.target.value)}>
                    <option>Cash</option><option>UPI</option><option>Card</option><option>Bank transfer</option><option>Other</option>
                  </select></label>
                </div>
                <button className="primary-button" disabled={busy || !salesReturnReason.trim()}>Record return</button>
              </form>
            )}
          </section>
        )}
      </main>
    );
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-mark large">MB</div>
        <p className="eyebrow">BUSINESS BILLING &amp; INVENTORY SYSTEM</p>
        <h1>Welcome back</h1>
        <p className="subheading">Connect to your business server, then sign in with your assigned account.</p>
        {error && <div className="alert" role="alert">{error}</div>}
        <form className="server-connection-form" onSubmit={connectToServer}>
          <label className="field-label" htmlFor="server-address">Server address</label>
          <input id="server-address" className="text-input" type="url" autoComplete="url" required
            placeholder="https://billing-server:4317" value={serverAddress}
            onChange={(event) => {
              setServerAddress(event.target.value);
              clearActiveDeviceCredential();
              setPendingPairing(null);
              setPairingStatus("");
              setConnectionStatus("disconnected");
              setServerWasVerified(false);
              setBusinesses([]);
              setBusinessId("");
            }} />
          <button className="quiet-button" type="submit" disabled={connectionStatus === "connecting"}>
            {connectionStatus === "connecting" ? "Checking server…" : connectionStatus === "connected" ? "Reconnect" : "Connect"}
          </button>
          <p className="connection-help">For development, HTTP is allowed only on this computer. For another computer, use HTTPS with a certificate trusted by Windows. Automatic discovery is not available yet; enter the server address here.</p>
        </form>
        <div className={`server-note ${connectionStatus}`}><i /> {
          connectionStatus === "connected" ? "Server and database are ready" :
            connectionStatus === "connecting" ? "Verifying server and certificate…" :
              connectionStatus === "error" ? "Connection failed" : "Not connected"
        }</div>
        {connectionStatus === "connected" && (
          <>
            <form className="server-connection-form" onSubmit={requestPairing}>
              <label className="field-label" htmlFor="pairing-code">Pair this computer</label>
              <p className="connection-help">Enter the one-time code created by an administrator on the server. Access starts only after that administrator approves this request. A retry in this window reuses the same request securely from memory.</p>
              <label className="field-label" htmlFor="device-name">Computer name</label>
              <input id="device-name" className="text-input" maxLength={100} required
                value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
              <input id="pairing-code" className="text-input" autoComplete="off" maxLength={32}
                value={invitationCode} onChange={(event) => setInvitationCode(event.target.value)} placeholder="One-time pairing code" />
              <button className="quiet-button" type="submit" disabled={busy || !invitationCode.trim() || Boolean(pendingPairing)}>
                {pendingPairing ? "Waiting for approval…" : pairingAttempt ? "Retry pairing request safely" : "Request pairing"}
              </button>
            </form>
            {pairingStatus && <div className="server-note" role="status">{pairingStatus}</div>}
            {businessId && (
              <button className="quiet-button" type="button" onClick={forgetCurrentDevice}>Forget saved device credentials</button>
            )}
          </>
        )}
        <form onSubmit={signIn}>
          <fieldset className="businesses">
            <legend>Choose a business</legend>
            {connectionStatus === "connected" && businesses.length === 0 && <p className="muted">No businesses are available for this account.</p>}
            {businesses.map((business) => (
              <button type="button" key={business.id} onClick={() => setBusinessId(business.id)}
                className={`business-card${business.id === businessId ? " selected" : ""}`}>
                <span className="business-icon">{business.name.slice(0, 1)}</span>
                <span className="business-copy"><strong>{business.name}</strong><small>{business.category}</small></span>
                <span className="radio-mark" aria-hidden="true">{business.id === businessId ? "●" : "○"}</span>
              </button>
            ))}
          </fieldset>
          <label className="field-label" htmlFor="username">Username</label>
          <input id="username" className="text-input" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
          <label className="field-label" htmlFor="password">Password</label>
          <input id="password" className="text-input" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          <button className="primary-button" type="submit" disabled={busy || connectionStatus !== "connected" || !businessId || !selectedBusiness}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <div className="server-note"><i /> Connecting to the configured server</div>
      </section>
      <aside className="login-aside">
        <div>
          <p className="eyebrow">ONE WORKSPACE, FOUR BUSINESSES</p>
          <h2>Stock and sales,<br />kept in their place.</h2>
          <p>Business access is checked by the server on every request. Your account only sees workspaces it has been assigned.</p>
        </div>
        <span className="aside-caption">CENTRAL SERVER · BUSINESS-SCOPED ACCESS</span>
      </aside>
    </main>
  );
}
