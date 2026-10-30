import "dotenv/config";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createApp } from "./app.js";
import { prisma } from "./db.js";
import { logger } from "./logging.js";
import { readServerConfig } from "./serverConfig.js";
import { createGracefulShutdown } from "./serverLifecycle.js";
import { connectShutdownControl } from "./shutdownControl.js";

const config = readServerConfig(process.env);
const app = createApp(config.sessionTtlHours);
const server = config.tls
  ? createHttpsServer({
    cert: readFileSync(config.tls.certificatePath),
    key: readFileSync(config.tls.privateKeyPath),
  }, app)
  : createHttpServer(app);
const shutdown = createGracefulShutdown(server, () => prisma.$disconnect());

function handleShutdownSignal() {
  void shutdown().catch((error: unknown) => {
    logger.error({ err: error }, "Server shutdown failed");
    process.exitCode = 1;
  });
}

process.on("SIGINT", handleShutdownSignal);
process.on("SIGTERM", handleShutdownSignal);

void connectShutdownControl(shutdown, process.env, undefined, (error) => {
  logger.error({ err: error }, "Shutdown-control request failed");
  process.exitCode = 1;
}).then(async (controlSession) => {
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(config.port, config.host, () => {
        server.off("error", onError);
        if (controlSession) {
          void controlSession.confirmReady().then(resolve, reject);
        } else {
          resolve();
        }
      });
    });

    logger.info({ host: config.host, port: config.port, tls: Boolean(config.tls) }, "Billing API listening");
  } catch (error) {
    controlSession?.failStartup();
    throw error;
  }
}).catch(async (error: unknown) => {
  logger.error({ err: error }, "Backend startup failed");
  process.exitCode = 1;
  try {
    await shutdown();
  } catch (shutdownError: unknown) {
    logger.error({ err: shutdownError }, "Shutdown after startup failure failed");
  }
});
