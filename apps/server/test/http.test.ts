import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";

describe("HTTP API boundary", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createApp(8).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it("serves API liveness without requiring a database connection", async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", apiVersion: 1 });
  });

  it("reports database readiness without exposing connection details", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "unavailable",
      database: "unavailable",
      apiVersion: 1,
    });
  });

  it("rejects unauthenticated business data requests", async () => {
    const response = await fetch(`${baseUrl}/products`);
    expect(response.status).toBe(401);
  });

  it("validates login payloads before attempting database access", async () => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);
  });

  it("requires an authenticated administrator to create pairing invitations", async () => {
    const response = await fetch(`${baseUrl}/pairing/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("rate-limits repeated pairing attempts", async () => {
    const responses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      responses.push(await fetch(`${baseUrl}/pairing/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }));
    }
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 429]);
  });

  it("permits only configured Tauri origins through CORS", async () => {
    const response = await fetch(`${baseUrl}/invoices`, {
      method: "OPTIONS",
      headers: {
        origin: "http://tauri.localhost",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type,x-business-id,x-device-id,x-device-credential",
      },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");
    expect(response.headers.get("access-control-allow-headers"))
      .toContain("X-Device-Credential");
  });
});
