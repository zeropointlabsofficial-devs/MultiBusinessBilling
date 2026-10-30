import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL must be configured before starting the API.");
}

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});
