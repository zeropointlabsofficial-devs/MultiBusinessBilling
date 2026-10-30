import type { Server } from "node:http";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_DATABASE_DISCONNECT_TIMEOUT_MS = 10_000;

export function createGracefulShutdown(
  server: Pick<Server, "close" | "closeAllConnections">,
  disconnectDatabase: () => Promise<unknown>,
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  databaseDisconnectTimeoutMs = DEFAULT_DATABASE_DISCONNECT_TIMEOUT_MS,
): () => Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Shutdown timeout must be a positive finite number.");
  }
  if (!Number.isFinite(databaseDisconnectTimeoutMs) || databaseDisconnectTimeoutMs <= 0) {
    throw new RangeError("Database disconnect timeout must be a positive finite number.");
  }

  let shutdownPromise: Promise<void> | undefined;

  return () => {
    shutdownPromise ??= performShutdown();
    return shutdownPromise;
  };

  async function performShutdown(): Promise<void> {
    const failures: unknown[] = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const closeServer = new Promise<void>((resolve, reject) => {
      try {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      } catch (error) {
        reject(error);
      }
    });

    const closeOrTimeout = new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => {
        const timeoutError = new Error(`HTTP server shutdown exceeded ${timeoutMs}ms.`);
        timeoutError.name = "ShutdownTimeoutError";
        try {
          server.closeAllConnections();
        } catch (error) {
          timeoutError.message += ` Closing active connections also failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        reject(timeoutError);
      }, timeoutMs);

      closeServer.then(resolve, reject);
    });

    try {
      await closeOrTimeout;
    } catch (error) {
      failures.push(error);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }

    try {
      let databaseTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(disconnectDatabase),
          new Promise<never>((_resolve, reject) => {
            databaseTimeout = setTimeout(() => {
              const error = new Error(
                `Database disconnect exceeded ${databaseDisconnectTimeoutMs}ms.`,
              );
              error.name = "DatabaseDisconnectTimeoutError";
              reject(error);
            }, databaseDisconnectTimeoutMs);
          }),
        ]);
      } finally {
        if (databaseTimeout) clearTimeout(databaseTimeout);
      }
    } catch (error) {
      failures.push(error);
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, "Graceful server shutdown failed.");
    }
  }
}
