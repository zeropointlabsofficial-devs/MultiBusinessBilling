type Fetcher = typeof fetch;

export type VerifiedServer = {
  serverUrl: string;
  apiBaseUrl: string;
};

const storageKey = "billing.serverUrl";
let defaultServerAddress = "http://127.0.0.1:4317";
let activeApiBaseUrl = "http://127.0.0.1:4317/api";

function isLoopback(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const ipv4 = host.split(".");
  return ipv4.length === 4 &&
    ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    Number(ipv4[0]) === 127;
}

export function normalizeServerAddress(input: string): VerifiedServer {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error("Enter a valid server URL, such as https://billing-server:4317.");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash ||
      !["", "/", "/api", "/api/"].includes(parsed.pathname)) {
    throw new Error("The server URL must not contain credentials, query parameters, or a custom path.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only HTTP or HTTPS server URLs are supported.");
  }
  if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) {
    throw new Error("LAN servers must use HTTPS. HTTP is allowed only for loopback development.");
  }

  const serverUrl = parsed.origin;
  return { serverUrl, apiBaseUrl: `${serverUrl}/api` };
}

export function configureDefaultServerAddress(address: string) {
  try {
    const normalized = normalizeServerAddress(address);
    defaultServerAddress = normalized.serverUrl;
    activeApiBaseUrl = normalized.apiBaseUrl;
  } catch {
    defaultServerAddress = "http://127.0.0.1:4317";
    activeApiBaseUrl = "http://127.0.0.1:4317/api";
  }
}

export function getSavedServerAddress() {
  try {
    if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        return normalizeServerAddress(saved).serverUrl;
      }
    }
  } catch {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(storageKey);
      }
    } catch {
      return "http://127.0.0.1:4317";
    }
  }
  try {
    return normalizeServerAddress(defaultServerAddress).serverUrl;
  } catch {
    return "http://127.0.0.1:4317";
  }
}

export async function verifyServerConnection(
  address: string,
  fetcher: Fetcher = fetch,
  timeoutMs = 5000,
): Promise<VerifiedServer> {
  const verifiedServer = normalizeServerAddress(address);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${verifiedServer.apiBaseUrl}/health`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(response.status === 503
        ? "The server is reachable but its database is not ready."
        : `Server readiness check failed (HTTP ${response.status}).`);
    }
    let readiness: unknown;
    try {
      readiness = await response.json();
    } catch {
      throw new Error("The server returned an invalid readiness response.");
    }
    if (typeof readiness !== "object" || readiness === null ||
        !("status" in readiness) || readiness.status !== "ok" ||
        !("database" in readiness) || readiness.database !== "ok") {
      throw new Error("The server is reachable but is not ready for billing.");
    }

    activeApiBaseUrl = verifiedServer.apiBaseUrl;
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(storageKey, verifiedServer.serverUrl);
      } catch {
        // The verified connection remains usable for this run without persistence.
      }
    }
    return verifiedServer;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("The server connection timed out. Check the address and network.");
    }
    if (error instanceof Error && (
      error.message.startsWith("Server readiness") ||
      error.message.startsWith("The server is") ||
      error.message.startsWith("The server returned")
    )) {
      throw error;
    }
    throw new Error("Could not securely reach the server. Check its address, network, and trusted TLS certificate.");
  } finally {
    clearTimeout(timeout);
  }
}

export function getApiBaseUrl() {
  return activeApiBaseUrl;
}
