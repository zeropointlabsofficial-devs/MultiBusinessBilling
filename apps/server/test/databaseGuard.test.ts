import { afterEach, describe, expect, it, vi } from "vitest";
import { disposableDatabaseUrl, sanitizeDatabaseOutput } from "./integration/databaseGuard.js";

const approval = "I_CREATED_A_DEDICATED_DISPOSABLE_LOCAL_DATABASE";
const targetUrl =
  "postgresql://billing_integration_test:private%20test%20password@127.0.0.1:5432/billing_pairing_integration_test?schema=public";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("disposable integration database guard", () => {
  it("fails closed when the dedicated database URL is absent", () => {
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_URL", "");
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_APPROVAL", approval);
    expect(() => disposableDatabaseUrl()).toThrow("Set BILLING_INTEGRATION_DATABASE_URL");
  });

  it("requires explicit disposable database approval", () => {
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_URL", targetUrl);
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_APPROVAL", "");
    expect(() => disposableDatabaseUrl()).toThrow("Explicitly approve");
  });

  it("rejects malformed URLs, missing passwords, and unexpected roles", () => {
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_APPROVAL", approval);
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_URL", "not-a-database-url");
    expect(() => disposableDatabaseUrl()).toThrow("not a valid PostgreSQL URL");

    vi.stubEnv(
      "BILLING_INTEGRATION_DATABASE_URL",
      targetUrl.replace("billing_integration_test:private%20test%20password@", ""),
    );
    expect(() => disposableDatabaseUrl()).toThrow("dedicated role and database");

    vi.stubEnv(
      "BILLING_INTEGRATION_DATABASE_URL",
      targetUrl.replace("billing_integration_test", "application_role"),
    );
    expect(() => disposableDatabaseUrl()).toThrow("dedicated role and database");
  });

  it("rejects remote or non-dedicated database targets", () => {
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_URL", targetUrl.replace("127.0.0.1", "db.example.invalid"));
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_APPROVAL", approval);
    expect(() => disposableDatabaseUrl()).toThrow("local loopback");

    vi.stubEnv("BILLING_INTEGRATION_DATABASE_URL", targetUrl.replace(
      "billing_pairing_integration_test",
      "billing",
    ));
    expect(() => disposableDatabaseUrl()).toThrow("database named");
  });

  it("accepts the dedicated 5433 port and rejects other ports and disallowed parameters", () => {
    const port5433Url = targetUrl.replace(":5432/", ":5433/");
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_URL", port5433Url);
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_APPROVAL", approval);
    expect(disposableDatabaseUrl()).toBe(port5433Url);

    vi.stubEnv("BILLING_INTEGRATION_DATABASE_URL", targetUrl.replace(":5432/", ":15432/"));
    expect(() => disposableDatabaseUrl()).toThrow("port 5432 or 5433");

    vi.stubEnv("BILLING_INTEGRATION_DATABASE_URL", `${targetUrl}&sslmode=require`);
    expect(() => disposableDatabaseUrl()).toThrow("may only specify schema");
  });

  it("treats an omitted PostgreSQL port as 5432", () => {
    const defaultPortUrl = targetUrl.replace(":5432", "");
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_URL", defaultPortUrl);
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_APPROVAL", approval);
    expect(disposableDatabaseUrl()).toBe(defaultPortUrl);
  });

  it("rejects a DATABASE_URL targeting the same database even with different credentials or loopback aliases", () => {
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_URL", targetUrl);
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_APPROVAL", approval);
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://application_role:different-password@localhost/billing_pairing_integration_test?schema=other",
    );
    expect(() => disposableDatabaseUrl()).toThrow("same database as DATABASE_URL");

    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://application_role:different-password@[::1]:5432/billing_pairing_integration_test",
    );
    expect(() => disposableDatabaseUrl()).toThrow("same database as DATABASE_URL");

    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://application_role:different-password@localhost.:5432/billing_pairing_integration_test",
    );
    expect(() => disposableDatabaseUrl()).toThrow("same database as DATABASE_URL");
  });

  it("allows the runner's exact approved URL in the child environment after strict target validation", () => {
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_URL", targetUrl);
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_APPROVAL", approval);
    vi.stubEnv("DATABASE_URL", targetUrl);

    expect(() => disposableDatabaseUrl()).toThrow("same database as DATABASE_URL");
    expect(disposableDatabaseUrl({ validatedChildEnvironment: true })).toBe(targetUrl);
  });

  it("rejects a mismatched child DATABASE_URL in validated-child mode", () => {
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_URL", targetUrl);
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_APPROVAL", approval);
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://billing_integration_test:private%20test%20password@127.0.0.1:5433/billing_pairing_integration_test?schema=public",
    );

    expect(() => disposableDatabaseUrl({ validatedChildEnvironment: true }))
      .toThrow("child DATABASE_URL must match");
  });

  it("accepts only the separately approved local test target", () => {
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_URL", targetUrl);
    vi.stubEnv("BILLING_INTEGRATION_DATABASE_APPROVAL", approval);
    expect(disposableDatabaseUrl()).toBe(targetUrl);
  });

  it("redacts database URLs and encoded or decoded credentials in tool output", () => {
    const safe = sanitizeDatabaseOutput(
      `failed for ${targetUrl}; password private test password`,
      targetUrl,
    );
    expect(safe).not.toContain("private%20test%20password");
    expect(safe).not.toContain("private test password");
    expect(safe).not.toContain("billing_integration_test");
    expect(safe).toContain("[REDACTED DATABASE URL]");
  });

  it("still redacts raw credentials when URL-encoded credential decoding fails", () => {
    const malformedEncodingUrl =
      "postgresql://billing_integration_test:%ZZ@127.0.0.1:5432/billing_pairing_integration_test";
    const safe = sanitizeDatabaseOutput(
      "credentials billing_integration_test %ZZ",
      malformedEncodingUrl,
    );

    expect(safe).not.toContain("billing_integration_test");
    expect(safe).not.toContain("%ZZ");
  });
});
