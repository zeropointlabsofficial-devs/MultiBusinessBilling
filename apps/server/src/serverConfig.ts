import { isIP } from "node:net";

export type ServerConfig = {
  host: string;
  port: number;
  sessionTtlHours: number;
  tls?: {
    certificatePath: string;
    privateKeyPath: string;
  };
};

function isLoopbackHost(host: string) {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.split(".")[0] === "127";
}

export function readServerConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  const host = environment.HOST?.trim() || "127.0.0.1";
  const port = Number(environment.PORT ?? 4317);
  const sessionTtlHours = Number(environment.SESSION_TTL_HOURS ?? 8);
  const certificatePath = environment.TLS_CERT_PATH?.trim();
  const privateKeyPath = environment.TLS_KEY_PATH?.trim();

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port.");
  }
  if (!Number.isInteger(sessionTtlHours) || sessionTtlHours < 1 || sessionTtlHours > 24) {
    throw new Error("SESSION_TTL_HOURS must be an integer from 1 to 24.");
  }
  if (!certificatePath && !privateKeyPath) {
    if (!isLoopbackHost(host)) {
      throw new Error("TLS_CERT_PATH and TLS_KEY_PATH are required when binding outside loopback.");
    }
    return { host, port, sessionTtlHours };
  }
  if (!certificatePath || !privateKeyPath) {
    throw new Error("TLS_CERT_PATH and TLS_KEY_PATH must both be configured.");
  }

  return {
    host,
    port,
    sessionTtlHours,
    tls: { certificatePath, privateKeyPath },
  };
}
