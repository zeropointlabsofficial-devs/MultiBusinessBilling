import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  attachShutdownControl,
  type ShutdownControlSocket,
} from "../src/shutdownControl.js";

class SyntheticSocket extends EventEmitter implements ShutdownControlSocket {
  readonly writes: string[] = [];
  ended = false;
  destroyed = false;

  setEncoding(): this {
    return this;
  }

  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  end(): this {
    this.ended = true;
    return this;
  }

  connect(): void {
    this.emit("connect");
  }

  receive(data: string): void {
    this.emit("data", data);
  }
}

describe("Windows shutdown-control client", () => {
  it("sends the per-start token and acknowledges an authorized stop", async () => {
    const socket = new SyntheticSocket();
    const shutdown = vi.fn(async () => undefined);
    const ready = attachShutdownControl(socket, "test-only-random-token", shutdown, 500);
    socket.connect();
    expect(socket.writes).toEqual(["HELLO test-only-random-token\n"]);
    socket.receive("READY\n");
    const session = await ready;
    const startup = session.confirmReady();
    expect(socket.writes).toContain("STARTED\n");
    socket.receive("RUNNING\n");
    await startup;
    socket.receive("STOP\n");
    await vi.waitFor(() => expect(socket.writes).toContain("ACK\n"));
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("rejects a server-denied client", async () => {
    const socket = new SyntheticSocket();
    const ready = attachShutdownControl(socket, "test-only-random-token", async () => undefined, 500);
    socket.connect();
    socket.receive("REJECTED\n");

    await expect(ready).rejects.toThrow("rejected this client");
    expect(socket.ended).toBe(true);
  });

  it("handles repeated stop requests through the same shutdown promise", async () => {
    const socket = new SyntheticSocket();
    let releaseShutdown!: () => void;
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const shutdown = vi.fn(() => shutdownGate);
    const ready = attachShutdownControl(socket, "test-only-random-token", shutdown, 500);
    socket.connect();
    socket.receive("READY\n");
    const session = await ready;
    const startup = session.confirmReady();
    socket.receive("RUNNING\n");
    await startup;
    socket.receive("STOP\nSTOP\n");

    expect(shutdown).toHaveBeenCalledTimes(1);
    releaseShutdown();
    await vi.waitFor(() => expect(socket.writes.filter((write) => write === "ACK\n")).toHaveLength(2));
  });

  it("fails closed when the authorized handshake does not arrive before timeout", async () => {
    const socket = new SyntheticSocket();
    const ready = attachShutdownControl(socket, "test-only-random-token", async () => undefined, 25);

    await expect(ready).rejects.toThrow("Timed out waiting");
    expect(socket.destroyed).toBe(true);
  });

  it("reports an unexpected authorized-channel close and attempts shutdown", async () => {
    const socket = new SyntheticSocket();
    const shutdown = vi.fn(async () => undefined);
    const onShutdownError = vi.fn();
    const ready = attachShutdownControl(
      socket,
      "test-only-random-token",
      shutdown,
      500,
      onShutdownError,
    );
    socket.connect();
    socket.receive("READY\n");
    await ready;
    socket.emit("close");

    expect(onShutdownError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "The shutdown-control connection closed unexpectedly." }),
    );
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
  });

  it("reports backend readiness acknowledgement timeout", async () => {
    const socket = new SyntheticSocket();
    const sessionPromise = attachShutdownControl(
      socket,
      "test-only-random-token",
      async () => undefined,
      25,
    );
    socket.connect();
    socket.receive("READY\n");
    const session = await sessionPromise;

    await expect(session.confirmReady()).rejects.toThrow("Timed out waiting for backend readiness");
    expect(socket.destroyed).toBe(true);
  });

  it("reports startup failure to the service host", async () => {
    const socket = new SyntheticSocket();
    const sessionPromise = attachShutdownControl(
      socket,
      "test-only-random-token",
      async () => undefined,
      500,
    );
    socket.connect();
    socket.receive("READY\n");
    const session = await sessionPromise;
    session.failStartup();

    expect(socket.writes).toContain("STARTUP_ERROR\n");
    expect(socket.ended).toBe(true);
  });
});
