import { isIP } from "node:net";

const requiredApproval = "I_CREATED_A_DEDICATED_DISPOSABLE_LOCAL_DATABASE";
const requiredDatabaseName = "billing_pairing_integration_test";
const requiredDatabaseUser = "billing_integration_test";

function isLoopbackHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const version = isIP(host);
  if (version === 4) return Number(host.split(".")[0]) === 127;
  return false;
}

export function sanitizeDatabaseOutput(output: string, connectionString: string) {
  let safeOutput = output.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[REDACTED DATABASE URL]");
  let target: URL;
  try {
    target = new URL(connectionString);
  } catch {
    return safeOutput;
  }
  const sensitiveValues = new Set([target.username, target.password]);
  for (const value of [target.username, target.password]) {
    try {
      sensitiveValues.add(decodeURIComponent(value));
    } catch {
      continue;
    }
  }
  for (const value of sensitiveValues) {
    if (value) {
      safeOutput = safeOutput.replaceAll(value, "[REDACTED]");
    }
  }
  return safeOutput;
}

export function disposableDatabaseUrl(options: { validatedChildEnvironment?: boolean } = {}) {
  const value = process.env.BILLING_INTEGRATION_DATABASE_URL;
  if (!value) {
    throw new Error("Set BILLING_INTEGRATION_DATABASE_URL to the dedicated test database URL.");
  }
  if (process.env.BILLING_INTEGRATION_DATABASE_APPROVAL !== requiredApproval) {
    throw new Error("Explicitly approve the disposable local database using BILLING_INTEGRATION_DATABASE_APPROVAL.");
  }

  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new Error("BILLING_INTEGRATION_DATABASE_URL is not a valid PostgreSQL URL.");
  }

  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  if (target.protocol !== "postgres:" && target.protocol !== "postgresql:") {
    throw new Error("The integration database must use PostgreSQL.");
  }
  if (hostname !== "127.0.0.1" && hostname !== "::1") {
    throw new Error("The integration database must be explicitly hosted on the local loopback interface.");
  }
  if (!["5432", "5433"].includes(target.port || "5432")) {
    throw new Error("The integration database must use local PostgreSQL port 5432 or 5433.");
  }
  let username: string;
  let databaseName: string;
  try {
    username = decodeURIComponent(target.username);
    databaseName = decodeURIComponent(target.pathname.slice(1));
  } catch {
    throw new Error("The integration database URL contains invalid encoding.");
  }
  if (username !== requiredDatabaseUser || databaseName !== requiredDatabaseName || !target.password) {
    throw new Error(
      `Use a dedicated role and database named ${requiredDatabaseUser} and ${requiredDatabaseName}.`,
    );
  }
  if (
    target.hash ||
    [...target.searchParams.keys()].some((key) => key !== "schema") ||
    target.searchParams.getAll("schema").length > 1 ||
    (target.searchParams.has("schema") && target.searchParams.get("schema") !== "public")
  ) {
    throw new Error("The integration database URL may only specify schema=public.");
  }
  if (options.validatedChildEnvironment && process.env.DATABASE_URL !== value) {
    throw new Error("The child DATABASE_URL must match the approved integration database URL.");
  }
  if (!options.validatedChildEnvironment && process.env.DATABASE_URL) {
    try {
      const inheritedTarget = new URL(process.env.DATABASE_URL);
      const inheritedDatabase = decodeURIComponent(inheritedTarget.pathname.slice(1));
      if (
        ["postgres:", "postgresql:"].includes(inheritedTarget.protocol) &&
        isLoopbackHost(inheritedTarget.hostname) &&
        (inheritedTarget.port || "5432") === (target.port || "5432") &&
        inheritedDatabase === databaseName
      ) {
        throw new Error("Do not use a test URL targeting the same database as DATABASE_URL.");
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Do not use a test URL")) throw error;
    }
  }
  return value;
}
