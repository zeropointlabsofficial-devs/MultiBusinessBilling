import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import argon2 from "argon2";
import { Role } from "../src/generated/prisma/enums.js";
import { prisma } from "../src/db.js";
import { logger } from "../src/logging.js";

const businesses = [
  { name: "ARJUNA AGENCY", category: "Batteries" },
  { name: "SANTHOSH AUTOMOBILES", category: "Exide Batteries" },
  { name: "ARJUNA ENTERPRISES", category: "Paint & Oil" },
  { name: "ZEROPOINT LABS", category: "Testing" },
];

function promptHidden(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) {
    return Promise.reject(new Error("Administrator setup requires an interactive terminal."));
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString()) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Administrator setup was cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };

    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function main() {
  const existing = await prisma.userBusinessRole.findFirst({ where: { role: Role.SYSTEM_ADMIN } });
  if (existing) {
    throw new Error("An initial system administrator already exists; bootstrap is one-time only.");
  }

  const prompt = createInterface({ input: stdin, output: stdout });
  const username = (await prompt.question("Administrator username: ")).trim();
  prompt.close();
  const password = await promptHidden("Administrator password (12+ characters, input hidden): ");
  const confirmation = await promptHidden("Confirm administrator password: ");
  if (!username || password.length < 12 || password !== confirmation) {
    throw new Error("Username is required and passwords must match and contain at least 12 characters.");
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { username, displayName: username, passwordHash },
    });
    for (const business of businesses) {
      const created = await tx.business.upsert({
        where: { name: business.name },
        create: business,
        update: {},
      });
      await tx.userBusinessRole.create({
        data: { userId: user.id, businessId: created.id, role: Role.SYSTEM_ADMIN },
      });
    }
    await tx.auditLog.create({
      data: { actorId: user.id, action: "system.initial_admin_created", entityType: "User", entityId: user.id },
    });
  });
  logger.info({ username }, "Initial administrator created and assigned to configured businesses");
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error }, "Administrator bootstrap failed");
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
