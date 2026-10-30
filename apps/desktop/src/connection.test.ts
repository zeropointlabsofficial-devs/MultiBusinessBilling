import { describe, expect, it, vi } from "vitest";
import {
  normalizeServerAddress,
  verifyServerConnection,
} from "./connection";

const readyResponse = () => new Response(JSON.stringify({
  status: "ok",
  database: "ok",
  apiVersion: 1,
}), { status: 200, headers: { "content-type": "application/json" } });

describe("desktop server connection configuration", () => {
  it("accepts HTTPS for a LAN server and normalizes the API base", () => {
    expect(normalizeServerAddress("https://billing-server.local:4317/"))
      .toEqual({
        serverUrl: "https://billing-server.local:4317",
        apiBaseUrl: "https://billing-server.local:4317/api",
      });
  });

  it("allows plaintext only for loopback development", () => {
    expect(normalizeServerAddress("http://127.0.0.1:4317/api").apiBaseUrl)
      .toBe("http://127.0.0.1:4317/api");
    expect(normalizeServerAddress("http://[::1]:4317").apiBaseUrl)
      .toBe("http://[::1]:4317/api");
    expect(() => normalizeServerAddress("http://192.168.1.20:4317"))
      .toThrow("LAN servers must use HTTPS.");
  });

  it("rejects unsupported URL schemes and embedded credentials", () => {
    expect(() => normalizeServerAddress("ftp://billing-server")).toThrow("Only HTTP or HTTPS");
    expect(() => normalizeServerAddress("https://user:secret@billing-server"))
      .toThrow("must not contain credentials");
    expect(() => normalizeServerAddress("https://billing-server/other"))
      .toThrow("must not contain credentials");
  });

  it("requires API and database readiness before accepting the connection", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(readyResponse());
    await expect(verifyServerConnection("https://billing-server", fetcher))
      .resolves.toEqual({
        serverUrl: "https://billing-server",
        apiBaseUrl: "https://billing-server/api",
      });
    expect(fetcher).toHaveBeenCalledWith(
      "https://billing-server/api/health",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );

    const notReady = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ status: "unavailable", database: "unavailable" }),
      { status: 503 },
    ));
    await expect(verifyServerConnection("https://billing-server", notReady))
      .rejects.toThrow("database is not ready");
  });

  it("remembers a server address only after readiness succeeds", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    try {
      const failed: typeof fetch = async () => new Response(null, { status: 503 });
      await expect(verifyServerConnection("https://not-ready-server", failed)).rejects.toThrow();
      expect(values.size).toBe(0);

      await verifyServerConnection("https://ready-server", async () => readyResponse());
      expect(values.get("billing.serverUrl")).toBe("https://ready-server");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports timeouts and does not reveal transport error details", async () => {
    const timeoutFetcher: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    await expect(verifyServerConnection("https://billing-server", timeoutFetcher, 1))
      .rejects.toThrow("timed out");

    const failedTls: typeof fetch = async () => {
      throw new TypeError("certificate key material should not be displayed");
    };
    await expect(verifyServerConnection("https://billing-server", failedTls))
      .rejects.toThrow("Could not securely reach the server. Check its address, network, and trusted TLS certificate.");
  });
});
