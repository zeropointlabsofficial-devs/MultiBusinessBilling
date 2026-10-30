import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { disposableDatabaseUrl, sanitizeDatabaseOutput } from "./integration/databaseGuard.js";

let databaseUrl: string;
let safeOutput: (output: string) => string;
try {
  databaseUrl = disposableDatabaseUrl();
  safeOutput = (output) => sanitizeDatabaseOutput(output, databaseUrl);
} catch (error) {
  console.error(
    `Integration test database check failed: ${error instanceof Error ? error.message : "Invalid test database configuration."}`,
  );
  process.exit(1);
}

const serverRoot = fileURLToPath(new URL("../", import.meta.url));
const childEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  LOG_LEVEL: "silent",
  DEBUG: "",
};
delete childEnvironment.NODE_OPTIONS;

function run(cliPath: string, args: string[]) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: serverRoot,
    env: childEnvironment,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    console.error("Could not start the local test tool.");
    process.exit(1);
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const sanitized = safeOutput(output);
  if (sanitized) process.stdout.write(sanitized);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const prismaCli = fileURLToPath(new URL("../../../node_modules/prisma/build/index.js", import.meta.url));
const vitestCli = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));
run(prismaCli, ["migrate", "deploy"]);
run(vitestCli, ["run", "--config", "vitest.integration.config.ts"]);
