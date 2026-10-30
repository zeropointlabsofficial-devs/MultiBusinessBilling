import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import type { NextFunction, Request, Response } from "express";
import { Role } from "./generated/prisma/enums.js";
import { prisma } from "./db.js";
import { uuidSchema } from "./validation.js";
import { verifyPairedDevice } from "./pairing.js";

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function login(
  username: string,
  password: string,
  businessId: string,
  sessionTtlHours: number,
) {
  const user = await prisma.user.findUnique({
    where: { username },
    include: { memberships: { where: { businessId }, include: { business: true } } },
  });
  const passwordMatches = user ? await argon2.verify(user.passwordHash, password) : false;
  const membership = user?.memberships[0];

  if (!user || !user.isActive || !passwordMatches || !membership?.business.isActive) {
    await prisma.auditLog.create({
      data: {
        actorId: user?.id,
        businessId: membership?.businessId,
        action: "auth.login_failed",
        entityType: "User",
        entityId: user?.id,
        details: { username },
      },
    });
    return null;
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionTtlHours * 60 * 60 * 1000);
  const session = await prisma.$transaction(async (tx) => {
    const created = await tx.userSession.create({
      data: { tokenHash: tokenHash(token), userId: user.id, expiresAt },
    });
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        businessId,
        action: "auth.login",
        entityType: "UserSession",
        entityId: created.id,
      },
    });
    return created;
  });

  return {
    token,
    expiresAt,
    sessionId: session.id,
    user: { id: user.id, username: user.username, displayName: user.displayName },
    business: { id: membership.business.id, name: membership.business.name },
    role: membership.role,
  };
}

async function authenticateSession(req: Request, res: Response) {
  const authorization = req.header("authorization");
  const businessId = req.header("x-business-id");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token || !businessId) {
    res.status(401).json({ error: "Authentication and business selection are required." });
    return false;
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    res.status(401).json({ error: "Session is invalid or expired." });
    return false;
  }
  if (!uuidSchema.safeParse(businessId).success) {
    res.status(400).json({ error: "Invalid business identifier." });
    return false;
  }

  const session = await prisma.userSession.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: {
      user: {
        include: {
          memberships: { where: { businessId }, include: { business: true } },
        },
      },
    },
  });
  const membership = session?.user.memberships[0];
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt <= new Date() ||
    !session.user.isActive ||
    !membership ||
    !membership.business.isActive
  ) {
    res.status(401).json({ error: "Session is invalid or this business is not assigned to your account." });
    return false;
  }

  req.auth = {
    actorId: session.user.id,
    businessId,
    role: membership.role,
    sessionId: session.id,
  };
  return true;
}

export async function authenticateSessionOnly(req: Request, res: Response, next: NextFunction) {
  if (!(await authenticateSession(req, res))) return;
  next();
}

export async function requireTrustedPairingAdministrator(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const remoteAddress = req.socket.remoteAddress?.toLowerCase() ?? "";
  const normalizedAddress = remoteAddress.startsWith("::ffff:")
    ? remoteAddress.slice("::ffff:".length)
    : remoteAddress;
  if (normalizedAddress === "::1" || normalizedAddress.startsWith("127.")) {
    next();
    return;
  }

  const deviceId = req.header("x-device-id") ?? "";
  const credential = req.header("x-device-credential") ?? "";
  if (
    !req.auth ||
    !uuidSchema.safeParse(deviceId).success ||
    !/^[A-Za-z0-9_-]{43}$/.test(credential) ||
    !(await verifyPairedDevice(deviceId, credential, req.auth.businessId))
  ) {
    res.status(403).json({ error: "Pairing administration requires the server computer or an approved device." });
    return;
  }
  req.auth.deviceId = deviceId;
  next();
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  if (!(await authenticateSession(req, res))) return;
  const deviceId = req.header("x-device-id") ?? "";
  const credential = req.header("x-device-credential") ?? "";
  if (
    !uuidSchema.safeParse(deviceId).success ||
    !/^[A-Za-z0-9_-]{43}$/.test(credential) ||
    !(await verifyPairedDevice(deviceId, credential, req.auth!.businessId))
  ) {
    res.status(403).json({ error: "This device is not approved for the selected business." });
    return;
  }
  req.auth!.deviceId = deviceId;
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      res.status(403).json({ error: "You do not have permission to perform this action." });
      return;
    }
    next();
  };
}

export async function logout(req: Request) {
  if (!req.auth) return;
  await prisma.$transaction([
    prisma.userSession.update({
      where: { id: req.auth.sessionId },
      data: { revokedAt: new Date() },
    }),
    prisma.auditLog.create({
      data: {
        actorId: req.auth.actorId,
        businessId: req.auth.businessId,
        action: "auth.logout",
        entityType: "UserSession",
        entityId: req.auth.sessionId,
      },
    }),
  ]);
}

export { Role };
