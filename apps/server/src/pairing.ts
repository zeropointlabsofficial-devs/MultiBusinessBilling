import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PairedDeviceStatus } from "./generated/prisma/enums.js";
import { prisma } from "./db.js";
import { ApiError } from "./errors.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const safeEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

export async function createPairingInvitation(businessId: string, actorId: string) {
  const code = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  const invitation = await prisma.$transaction(async (tx) => {
    const created = await tx.pairingInvitation.create({
      data: { businessId, createdById: actorId, tokenHash: hash(code), expiresAt },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        businessId,
        action: "device.pairing_invitation_created",
        entityType: "PairingInvitation",
        entityId: created.id,
      },
    });
    return created;
  });
  return { code, expiresAt, invitationId: invitation.id };
}

export async function requestDevicePairing(input: {
  invitationCode: string;
  deviceId: string;
  deviceName: string;
  deviceCredential: string;
  pollToken: string;
}) {
  const invitationTokenHash = hash(input.invitationCode);
  const credentialHash = hash(input.deviceCredential);
  const pollTokenHash = hash(input.pollToken);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const invitation = await tx.pairingInvitation.findUnique({
      where: { tokenHash: invitationTokenHash },
    });
    if (!invitation) throw new ApiError(400, "Pairing invitation is invalid.");
    if (invitation.expiresAt <= now) throw new ApiError(410, "Pairing invitation has expired.");

    if (invitation.redeemedAt) {
      const existing = await tx.pairedDevice.findUnique({ where: { deviceId: input.deviceId } });
      if (
        invitation.redeemedDeviceId === input.deviceId &&
        existing?.businessId === invitation.businessId &&
        safeEqual(existing.credentialHash, credentialHash) &&
        safeEqual(existing.pollTokenHash, pollTokenHash)
      ) {
        return { deviceId: existing.deviceId, businessId: existing.businessId, status: existing.status };
      }
      throw new ApiError(409, "Pairing invitation has already been used.");
    }

    const claimed = await tx.pairingInvitation.updateMany({
      where: { id: invitation.id, redeemedAt: null, expiresAt: { gt: now } },
      data: { redeemedAt: now, redeemedDeviceId: input.deviceId },
    });
    if (claimed.count !== 1) throw new ApiError(409, "Pairing invitation has already been used.");

    const device = await tx.pairedDevice.create({
      data: {
        deviceId: input.deviceId,
        businessId: invitation.businessId,
        name: input.deviceName,
        credentialHash,
        pollTokenHash,
        pairingExpiresAt: invitation.expiresAt,
      },
      select: { deviceId: true, businessId: true, status: true },
    });
    await tx.auditLog.create({
      data: {
        businessId: invitation.businessId,
        action: "device.pairing_requested",
        entityType: "PairedDevice",
        entityId: device.deviceId,
        details: { deviceName: input.deviceName },
      },
    });
    return device;
  });
}

export async function pollDevicePairing(deviceId: string, pollToken: string) {
  const device = await prisma.pairedDevice.findUnique({
    where: { deviceId },
    select: { status: true, pollTokenHash: true, pairingExpiresAt: true },
  });
  if (!device || !safeEqual(device.pollTokenHash, hash(pollToken))) {
    throw new ApiError(401, "Pairing status could not be verified.");
  }
  if (device.pairingExpiresAt <= new Date() && device.status === PairedDeviceStatus.PENDING) {
    throw new ApiError(410, "Pairing request has expired.");
  }
  return { status: device.status.toLowerCase() };
}

export async function listPairedDevices(businessId: string) {
  return prisma.pairedDevice.findMany({
    where: { businessId },
    select: {
      deviceId: true,
      name: true,
      status: true,
      createdAt: true,
      approvedAt: true,
      revokedAt: true,
      lastSeenAt: true,
      pairingExpiresAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function approvePairedDevice(deviceId: string, businessId: string, actorId: string) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.pairedDevice.updateMany({
      where: {
        deviceId,
        businessId,
        status: PairedDeviceStatus.PENDING,
        pairingExpiresAt: { gt: now },
      },
      data: { status: PairedDeviceStatus.APPROVED, approvedAt: now, approvedById: actorId },
    });
    if (updated.count !== 1) {
      const device = await tx.pairedDevice.findFirst({
        where: { deviceId, businessId },
        select: { status: true, pairingExpiresAt: true },
      });
      if (!device) throw new ApiError(404, "Pairing request was not found.");
      if (device.pairingExpiresAt <= now && device.status === PairedDeviceStatus.PENDING) {
        throw new ApiError(410, "Pairing request has expired.");
      }
      throw new ApiError(409, "Pairing request is no longer pending.");
    }
    await tx.auditLog.create({
      data: {
        actorId,
        businessId,
        action: "device.pairing_approved",
        entityType: "PairedDevice",
        entityId: deviceId,
      },
    });
    return { deviceId, status: "approved" };
  });
}

export async function revokePairedDevice(deviceId: string, businessId: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.pairedDevice.updateMany({
      where: { deviceId, businessId, status: { not: PairedDeviceStatus.REVOKED } },
      data: {
        status: PairedDeviceStatus.REVOKED,
        revokedAt: new Date(),
        credentialHash: hash(randomBytes(32).toString("base64url")),
      },
    });
    if (updated.count !== 1) {
      const exists = await tx.pairedDevice.findFirst({ where: { deviceId, businessId }, select: { deviceId: true } });
      if (!exists) throw new ApiError(404, "Paired device was not found.");
      return { deviceId, status: "revoked" };
    }
    await tx.auditLog.create({
      data: {
        actorId,
        businessId,
        action: "device.revoked",
        entityType: "PairedDevice",
        entityId: deviceId,
      },
    });
    return { deviceId, status: "revoked" };
  });
}

export async function verifyPairedDevice(deviceId: string, credential: string, businessId: string) {
  const device = await prisma.pairedDevice.findUnique({
    where: { deviceId },
    select: { businessId: true, credentialHash: true, status: true, lastSeenAt: true },
  });
  const authorized = Boolean(
    device &&
    device.status === PairedDeviceStatus.APPROVED &&
    device.businessId === businessId &&
    safeEqual(device.credentialHash, hash(credential)),
  );
  if (authorized && device) {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - 5 * 60 * 1000);
    if (!device.lastSeenAt || device.lastSeenAt < staleBefore) {
      await prisma.pairedDevice.updateMany({
        where: {
          deviceId,
          businessId,
          status: PairedDeviceStatus.APPROVED,
          OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: staleBefore } }],
        },
        data: { lastSeenAt: now },
      });
    }
  }
  return authorized;
}
