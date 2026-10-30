import { createHash, randomBytes, randomUUID } from "node:crypto";
import argon2 from "argon2";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { Role } from "../../src/generated/prisma/enums.js";
import { createApp } from "../../src/app.js";
import { createPairingInvitation } from "../../src/pairing.js";
import { prisma } from "../../src/db.js";

type UserFixture = {
  id: string;
  username: string;
  password: string;
};

type Fixture = {
  businessA: string;
  businessB: string;
  admin: UserFixture;
  viewer: UserFixture;
  baseUrl: string;
  invitationIds: string[];
  deviceIds: string[];
  customerIds: string[];
  dispose: () => Promise<void>;
};

type LoginResult = {
  token: string;
};

type InvitationResult = {
  code: string;
  invitationId: string;
};

type PairingRequest = {
  invitationCode: string;
  deviceId: string;
  deviceName: string;
  deviceCredential: string;
  pollToken: string;
};

const testPassword = randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function startApi() {
  const server = createApp(8).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/api`,
  };
}

async function stopApi(server: Server) {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  server.closeAllConnections();
  await closed;
}

async function deleteFixtureRecords(fixture: {
  businessIds: string[];
  userIds: string[];
  invitationIds: string[];
  deviceIds: string[];
  customerIds: string[];
}) {
  const { businessIds, userIds, invitationIds, deviceIds, customerIds } = fixture;
  if (deviceIds.length > 0) {
    await prisma.pairedDevice.deleteMany({ where: { deviceId: { in: deviceIds } } });
  }
  if (invitationIds.length > 0) {
    await prisma.pairingInvitation.deleteMany({ where: { id: { in: invitationIds } } });
  }
  if (customerIds.length > 0) {
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  }

  const sessions = userIds.length > 0
    ? await prisma.userSession.findMany({
      where: { userId: { in: userIds } },
      select: { id: true },
    })
    : [];
  if (sessions.length > 0) {
    await prisma.userSession.deleteMany({ where: { id: { in: sessions.map(({ id }) => id) } } });
  }

  const ownedAuditEvents = [
    ...(userIds.length > 0 ? [{ actorId: { in: userIds } }] : []),
    ...(deviceIds.length > 0 ? [{ entityId: { in: deviceIds } }] : []),
    ...(invitationIds.length > 0 ? [{ entityId: { in: invitationIds } }] : []),
  ];
  if (ownedAuditEvents.length > 0) {
    const auditEvents = await prisma.auditLog.findMany({
      where: { OR: ownedAuditEvents },
      select: { id: true },
    });
    if (auditEvents.length > 0) {
      await prisma.auditLog.deleteMany({ where: { id: { in: auditEvents.map(({ id }) => id) } } });
    }
  }

  if (userIds.length > 0) {
    await prisma.userBusinessRole.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  if (businessIds.length > 0) {
    await prisma.business.deleteMany({ where: { id: { in: businessIds } } });
  }
}

async function createFixture(): Promise<Fixture> {
  const ownedRecords = {
    businessIds: [] as string[],
    userIds: [] as string[],
    invitationIds: [] as string[],
    deviceIds: [] as string[],
    customerIds: [] as string[],
  };
  let server: Server | undefined;

  try {
    const suffix = randomUUID();
    const businessA = await prisma.business.create({
      data: { name: `pairing-integration-a-${suffix}`, category: "integration" },
      select: { id: true },
    });
    ownedRecords.businessIds.push(businessA.id);
    const businessB = await prisma.business.create({
      data: { name: `pairing-integration-b-${suffix}`, category: "integration" },
      select: { id: true },
    });
    ownedRecords.businessIds.push(businessB.id);

    const passwordHash = await argon2.hash(testPassword);
    const adminRecord = await prisma.user.create({
      data: {
        username: `pairing-admin-${suffix}`,
        passwordHash,
        displayName: "Integration Administrator",
      },
      select: { id: true, username: true },
    });
    ownedRecords.userIds.push(adminRecord.id);
    const viewerRecord = await prisma.user.create({
      data: {
        username: `pairing-viewer-${suffix}`,
        passwordHash,
        displayName: "Integration Viewer",
      },
      select: { id: true, username: true },
    });
    ownedRecords.userIds.push(viewerRecord.id);

    await prisma.userBusinessRole.createMany({
      data: [
        { userId: adminRecord.id, businessId: businessA.id, role: Role.BUSINESS_ADMIN },
        { userId: adminRecord.id, businessId: businessB.id, role: Role.BUSINESS_ADMIN },
        { userId: viewerRecord.id, businessId: businessA.id, role: Role.VIEWER },
      ],
    });
    const customerA = await prisma.customer.create({
      data: { businessId: businessA.id, name: `customer-a-${suffix}` },
      select: { id: true },
    });
    ownedRecords.customerIds.push(customerA.id);
    const customerB = await prisma.customer.create({
      data: { businessId: businessB.id, name: `customer-b-${suffix}` },
      select: { id: true },
    });
    ownedRecords.customerIds.push(customerB.id);

    const api = await startApi();
    server = api.server;
    return {
      businessA: businessA.id,
      businessB: businessB.id,
      admin: { id: adminRecord.id, username: adminRecord.username, password: testPassword },
      viewer: { id: viewerRecord.id, username: viewerRecord.username, password: testPassword },
      baseUrl: api.baseUrl,
      invitationIds: ownedRecords.invitationIds,
      deviceIds: ownedRecords.deviceIds,
      customerIds: ownedRecords.customerIds,
      dispose: async () => {
        try {
          if (server) await stopApi(server);
        } finally {
          await deleteFixtureRecords(ownedRecords);
        }
      },
    };
  } catch (error) {
    try {
      if (server) await stopApi(server);
    } finally {
      await deleteFixtureRecords(ownedRecords);
    }
    throw error;
  }
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.dispose();
  }
}

async function login(fixture: Fixture, user: UserFixture, businessId: string) {
  const response = await fetch(`${fixture.baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user.username, password: user.password, businessId }),
  });
  expect(response.status).toBe(200);
  return await response.json() as LoginResult;
}

function authenticatedHeaders(token: string, businessId: string, device?: PairingRequest): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    "x-business-id": businessId,
    ...(device ? {
      "x-device-id": device.deviceId,
      "x-device-credential": device.deviceCredential,
    } : {}),
  };
}

async function createInvitation(
  fixture: Fixture,
  token: string,
  businessId: string,
  additionalBody: Record<string, unknown> = {},
) {
  const response = await fetch(`${fixture.baseUrl}/pairing/invitations`, {
    method: "POST",
    headers: {
      ...authenticatedHeaders(token, businessId),
      "content-type": "application/json",
    },
    body: JSON.stringify(additionalBody),
  });
  expect(response.status).toBe(201);
  const invitation = await response.json() as InvitationResult;
  fixture.invitationIds.push(invitation.invitationId);
  return invitation;
}

function newPairingRequest(invitationCode: string): PairingRequest {
  return {
    invitationCode,
    deviceId: randomUUID(),
    deviceName: "Integration client",
    deviceCredential: randomBytes(32).toString("base64url"),
    pollToken: randomBytes(32).toString("base64url"),
  };
}

async function requestPairing(fixture: Fixture, input: PairingRequest) {
  fixture.deviceIds.push(input.deviceId);
  return await fetch(`${fixture.baseUrl}/pairing/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function requestPairingsTogether(fixture: Fixture, requests: PairingRequest[]) {
  let ready = 0;
  let release!: () => void;
  const startSignal = new Promise<void>((resolve) => {
    release = resolve;
  });
  const responses = requests.map(async (request) => {
    ready += 1;
    if (ready === requests.length) release();
    await startSignal;
    return await requestPairing(fixture, request);
  });
  return await Promise.all(responses);
}

describe("PostgreSQL-backed device pairing API", () => {
  it("persists invitation expiry and rejects redemption after expiry", async () => {
    await withFixture(async (fixture) => {
      const adminSession = await login(fixture, fixture.admin, fixture.businessA);
      const invitation = await createInvitation(fixture, adminSession.token, fixture.businessA);
      const storedInvitation = await prisma.pairingInvitation.findUniqueOrThrow({
        where: { id: invitation.invitationId },
      });
      expect(storedInvitation.tokenHash).toBe(digest(invitation.code));
      expect(storedInvitation.tokenHash).not.toBe(invitation.code);

      const invalidResponse = await requestPairing(fixture, newPairingRequest("Z".repeat(32)));
      expect(invalidResponse.status).toBe(400);

      await prisma.pairingInvitation.update({
        where: { id: invitation.invitationId },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      const response = await requestPairing(fixture, newPairingRequest(invitation.code));

      expect(response.status).toBe(410);
      expect(await prisma.pairedDevice.count({ where: { businessId: fixture.businessA } })).toBe(0);
    });
  });

  it("allows only one redemption while accepting an identical safe retry", async () => {
    await withFixture(async (fixture) => {
      const adminSession = await login(fixture, fixture.admin, fixture.businessA);
      const invitation = await createInvitation(fixture, adminSession.token, fixture.businessA);
      const request = newPairingRequest(invitation.code);

      const firstResponse = await requestPairing(fixture, request);
      expect(firstResponse.status).toBe(202);
      const firstResult = await firstResponse.json();
      const retryResponse = await requestPairing(fixture, request);
      expect(retryResponse.status).toBe(202);
      expect(await retryResponse.json()).toEqual(firstResult);

      const otherDeviceResponse = await requestPairing(fixture, newPairingRequest(invitation.code));
      expect(otherDeviceResponse.status).toBe(409);
      const storedDevice = await prisma.pairedDevice.findUniqueOrThrow({
        where: { deviceId: request.deviceId },
      });
      expect(storedDevice.credentialHash).toBe(digest(request.deviceCredential));
      expect(storedDevice.pollTokenHash).toBe(digest(request.pollToken));
      expect(storedDevice.credentialHash).not.toBe(request.deviceCredential);
      expect(storedDevice.pollTokenHash).not.toBe(request.pollToken);
      expect(await prisma.pairedDevice.count({ where: { businessId: fixture.businessA } })).toBe(1);
    });
  });

  it("allows exactly one concurrent redemption of a single-use invitation", async () => {
    await withFixture(async (fixture) => {
      const adminSession = await login(fixture, fixture.admin, fixture.businessA);
      const invitation = await createInvitation(fixture, adminSession.token, fixture.businessA);
      const requests = [
        newPairingRequest(invitation.code),
        newPairingRequest(invitation.code),
      ];

      const responses = await requestPairingsTogether(fixture, requests);
      expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
      expect(await prisma.pairedDevice.count({ where: { businessId: fixture.businessA } })).toBe(1);
      const redeemed = await prisma.pairingInvitation.findUniqueOrThrow({
        where: { id: invitation.invitationId },
      });
      expect(redeemed.redeemedAt).not.toBeNull();
    });
  });

  it("rolls back invitation redemption when a unique device constraint fails", async () => {
    await withFixture(async (fixture) => {
      const adminSession = await login(fixture, fixture.admin, fixture.businessA);
      const firstInvitation = await createInvitation(fixture, adminSession.token, fixture.businessA);
      const secondInvitation = await createInvitation(fixture, adminSession.token, fixture.businessA);
      const firstRequest = newPairingRequest(firstInvitation.code);
      expect((await requestPairing(fixture, firstRequest)).status).toBe(202);

      const duplicateDeviceRequest = {
        ...newPairingRequest(secondInvitation.code),
        deviceId: firstRequest.deviceId,
      };
      const duplicateResponse = await requestPairing(fixture, duplicateDeviceRequest);
      expect(duplicateResponse.status).toBe(500);

      const unclaimedInvitation = await prisma.pairingInvitation.findUniqueOrThrow({
        where: { id: secondInvitation.invitationId },
      });
      expect(unclaimedInvitation.redeemedAt).toBeNull();
      expect((await requestPairing(fixture, newPairingRequest(secondInvitation.code))).status).toBe(202);
    });
  });

  it("enforces approval, role, membership, business scope, and revocation through API requests", async () => {
    await withFixture(async (fixture) => {
      const adminA = await login(fixture, fixture.admin, fixture.businessA);
      const adminB = await login(fixture, fixture.admin, fixture.businessB);
      const viewerA = await login(fixture, fixture.viewer, fixture.businessA);
      const invitation = await createInvitation(
        fixture,
        adminA.token,
        fixture.businessA,
        { businessId: fixture.businessB, role: "SYSTEM_ADMIN" },
      );
      const storedInvitation = await prisma.pairingInvitation.findUniqueOrThrow({
        where: { id: invitation.invitationId },
      });
      expect(storedInvitation.businessId).toBe(fixture.businessA);

      const device = newPairingRequest(invitation.code);
      expect((await requestPairing(fixture, device)).status).toBe(202);
      const businessAHeaders = authenticatedHeaders(adminA.token, fixture.businessA, device);
      const pendingAccess = await fetch(`${fixture.baseUrl}/customers`, { headers: businessAHeaders });
      expect(pendingAccess.status).toBe(403);

      const unauthorizedApproval = await fetch(
        `${fixture.baseUrl}/pairing/devices/${device.deviceId}/approve`,
        {
          method: "POST",
          headers: {
            ...authenticatedHeaders(viewerA.token, fixture.businessA),
            "content-type": "application/json",
          },
          body: JSON.stringify({ deviceId: device.deviceId, role: "BUSINESS_ADMIN" }),
        },
      );
      expect(unauthorizedApproval.status).toBe(403);

      const approval = await fetch(`${fixture.baseUrl}/pairing/devices/${device.deviceId}/approve`, {
        method: "POST",
        headers: {
          ...authenticatedHeaders(adminA.token, fixture.businessA),
          "content-type": "application/json",
        },
        body: JSON.stringify({ deviceId: device.deviceId }),
      });
      expect(approval.status).toBe(200);

      const businessAAccess = await fetch(`${fixture.baseUrl}/customers`, { headers: businessAHeaders });
      expect(businessAAccess.status).toBe(200);
      const customersA = await businessAAccess.json() as { customers: Array<{ name: string }> };
      expect(customersA.customers).toHaveLength(1);
      expect(customersA.customers[0]?.name).toContain("customer-a-");

      const deviceCrossBusinessAccess = await fetch(`${fixture.baseUrl}/customers`, {
        headers: authenticatedHeaders(adminB.token, fixture.businessB, device),
      });
      expect(deviceCrossBusinessAccess.status).toBe(403);

      const userCrossBusinessAccess = await fetch(`${fixture.baseUrl}/customers`, {
        headers: authenticatedHeaders(viewerA.token, fixture.businessB, device),
      });
      expect(userCrossBusinessAccess.status).toBe(401);

      const revoke = await fetch(`${fixture.baseUrl}/pairing/devices/${device.deviceId}/revoke`, {
        method: "POST",
        headers: {
          ...authenticatedHeaders(adminA.token, fixture.businessA),
          "content-type": "application/json",
        },
        body: JSON.stringify({ deviceId: device.deviceId }),
      });
      expect(revoke.status).toBe(200);
      const revokedDevice = await prisma.pairedDevice.findUniqueOrThrow({
        where: { deviceId: device.deviceId },
      });
      expect(revokedDevice.status).toBe("REVOKED");
      expect(revokedDevice.revokedAt).not.toBeNull();
      const existingSession = await prisma.userSession.findUnique({
        where: { tokenHash: digest(adminA.token) },
        select: { revokedAt: true, expiresAt: true },
      });
      expect(existingSession?.revokedAt).toBeNull();
      expect(existingSession?.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const revokedAccess = await fetch(`${fixture.baseUrl}/customers`, { headers: businessAHeaders });
      expect(revokedAccess.status).toBe(403);
    });
  });

  it("rejects a pairing invitation with a nonexistent creator using the database foreign key", async () => {
    await withFixture(async (fixture) => {
      const failure = await createPairingInvitation(fixture.businessA, randomUUID()).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "P2003" });
      expect(await prisma.pairingInvitation.count({ where: { businessId: fixture.businessA } })).toBe(0);
    });
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
