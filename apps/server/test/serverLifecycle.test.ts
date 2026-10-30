import { createServer, get, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGracefulShutdown } from "../src/serverLifecycle.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }));
});

async function listen(server: Server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test HTTP server did not bind to a TCP address.");
  }
  return address as AddressInfo;
}

function makeRequest(port: number) {
  return new Promise<void>((resolve, reject) => {
    const request = get({ host: "127.0.0.1", port, path: "/", agent: false }, (response) => {
      response.resume();
      response.once("end", resolve);
      response.once("error", reject);
    });
    request.once("error", reject);
  });
}

describe("graceful server shutdown", () => {
  it("waits for in-flight HTTP requests and is idempotent", async () => {
    let markRequestEntered!: () => void;
    const requestEntered = new Promise<void>((resolve) => {
      markRequestEntered = resolve;
    });
    let releaseRequest!: () => void;
    const requestReleased = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const server = createServer((_request, response) => {
      markRequestEntered();
      void requestReleased.then(() => response.end("finished"));
    });
    const address = await listen(server);
    const requestFinished = makeRequest(address.port);
    await requestEntered;

    const disconnectDatabase = vi.fn(async () => undefined);
    const shutdown = createGracefulShutdown(server, disconnectDatabase, 3000);
    const firstShutdown = shutdown();
    expect(shutdown()).toBe(firstShutdown);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disconnectDatabase).not.toHaveBeenCalled();

    releaseRequest();
    await requestFinished;
    await firstShutdown;
    expect(disconnectDatabase).toHaveBeenCalledTimes(1);
  });

  it("force-closes remaining synthetic requests after a bounded timeout and disconnects", async () => {
    let markRequestEntered!: () => void;
    const requestEntered = new Promise<void>((resolve) => {
      markRequestEntered = resolve;
    });
    const server = createServer(() => {
      markRequestEntered();
    });
    const address = await listen(server);
    const requestFinished = makeRequest(address.port);
    const requestFailure = requestFinished.catch((error: unknown) => error);
    await requestEntered;

    const disconnectDatabase = vi.fn(async () => undefined);
    const shutdown = createGracefulShutdown(server, disconnectDatabase, 25);
    let shutdownError: unknown;
    try {
      await shutdown();
    } catch (error) {
      shutdownError = error;
    }

    expect(shutdownError).toBeInstanceOf(AggregateError);
    expect((shutdownError as AggregateError).errors[0]).toMatchObject({ name: "ShutdownTimeoutError" });
    expect(disconnectDatabase).toHaveBeenCalledTimes(1);
    expect(await requestFailure).toBeInstanceOf(Error);
  });

  it("reports HTTP-close and database-disconnect errors without skipping either", async () => {
    const server = createServer();
    servers.push(server);
    const disconnectError = new Error("synthetic database disconnect failure");
    const shutdown = createGracefulShutdown(server, async () => {
      throw disconnectError;
    });

    let shutdownError: unknown;
    try {
      await shutdown();
    } catch (error) {
      shutdownError = error;
    }

    expect(shutdownError).toBeInstanceOf(AggregateError);
    const failures = (shutdownError as AggregateError).errors;
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ code: "ERR_SERVER_NOT_RUNNING" });
    expect(failures[1]).toBe(disconnectError);
  });

  it("bounds a database disconnect that never settles", async () => {
    const server = createServer();
    await listen(server);
    const shutdown = createGracefulShutdown(
      server,
      () => new Promise<never>(() => undefined),
      100,
      25,
    );
    const startedAt = Date.now();

    await expect(shutdown()).rejects.toMatchObject({
      name: "AggregateError",
      errors: [expect.objectContaining({ name: "DatabaseDisconnectTimeoutError" })],
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("bounds the total HTTP drain plus database disconnect and reports both timeouts", async () => {
    let enteredRequest!: () => void;
    const requestEnteredPromise = new Promise<void>((resolve) => {
      enteredRequest = resolve;
    });
    const server = createServer(() => {
      enteredRequest();
    });
    const address = await listen(server);
    const requestFinished = makeRequest(address.port).catch(() => undefined);
    await requestEnteredPromise;
    const shutdown = createGracefulShutdown(
      server,
      () => new Promise<never>(() => undefined),
      25,
      25,
    );
    const startedAt = Date.now();

    await expect(shutdown()).rejects.toMatchObject({
      name: "AggregateError",
      errors: [
        expect.objectContaining({ name: "ShutdownTimeoutError" }),
        expect.objectContaining({ name: "DatabaseDisconnectTimeoutError" }),
      ],
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
    await requestFinished;
  });
});
