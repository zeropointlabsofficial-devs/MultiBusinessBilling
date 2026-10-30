import { disposableDatabaseUrl } from "./databaseGuard.js";

try {
  process.env.DATABASE_URL = disposableDatabaseUrl({ validatedChildEnvironment: true });
  process.env.LOG_LEVEL = "silent";
} catch (error) {
  throw new Error(
    `Integration test database check failed: ${error instanceof Error ? error.message : "Invalid test database configuration."}`,
  );
}
