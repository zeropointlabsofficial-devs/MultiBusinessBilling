// Never let inherited environment configuration point tests at a real database.
process.env.DATABASE_URL =
  "postgresql://billing_test@127.0.0.1:1/billing_test?schema=public";
process.env.LOG_LEVEL ??= "silent";
