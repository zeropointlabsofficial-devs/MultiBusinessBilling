import { describe, expect, it } from "vitest";
import { readServerConfig } from "../src/serverConfig.js";

describe("server network configuration", () => {
  it("pins the test process to the unreachable test-only database URL", () => {
    expect(process.env.DATABASE_URL)
      .toBe("postgresql://billing_test@127.0.0.1:1/billing_test?schema=public");
  });

  it("defaults to loopback HTTP for local development", () => {
    expect(readServerConfig({})).toEqual({
      host: "127.0.0.1",
      port: 4317,
      sessionTtlHours: 8,
    });
  });

  it("rejects non-loopback binds without both TLS files", () => {
    expect(() => readServerConfig({ HOST: "0.0.0.0" }))
      .toThrow("TLS_CERT_PATH and TLS_KEY_PATH are required when binding outside loopback.");
    expect(() => readServerConfig({ HOST: "192.168.1.10", TLS_CERT_PATH: "server.crt" }))
      .toThrow("TLS_CERT_PATH and TLS_KEY_PATH must both be configured.");
  });

  it("permits a configurable non-loopback bind only with TLS configured", () => {
    expect(readServerConfig({
      HOST: "0.0.0.0",
      PORT: "443",
      TLS_CERT_PATH: "server.crt",
      TLS_KEY_PATH: "server.key",
    })).toEqual({
      host: "0.0.0.0",
      port: 443,
      sessionTtlHours: 8,
      tls: { certificatePath: "server.crt", privateKeyPath: "server.key" },
    });
  });

  it("rejects invalid port and session lifetime configuration", () => {
    expect(() => readServerConfig({ PORT: "0" })).toThrow("PORT must be a valid TCP port.");
    expect(() => readServerConfig({ SESSION_TTL_HOURS: "25" }))
      .toThrow("SESSION_TTL_HOURS must be an integer from 1 to 24.");
  });
});
