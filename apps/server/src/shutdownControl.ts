import { createConnection, type Socket } from "node:net";

const PIPE_ENV = "BILLING_SHUTDOWN_PIPE";
const TOKEN_ENV = "BILLING_SHUTDOWN_TOKEN";
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export interface ShutdownControlSession {
  confirmReady(): Promise<void>;
  failStartup(): void;
}

export async function connectShutdownControl(
  shutdown: () => Promise<void>,
  environment: NodeJS.ProcessEnv = process.env,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  onShutdownError: (error: unknown) => void = () => undefined,
): Promise<ShutdownControlSession | undefined> {
  const pipePath = environment[PIPE_ENV];
  const token = environment[TOKEN_ENV];
  if (!pipePath && !token) {
    return undefined;
  }
  if (!pipePath || !token || process.platform !== "win32") {
    throw new Error("The Windows shutdown-control configuration is incomplete or unsupported.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Shutdown-control connection timeout must be a positive finite number.");
  }

  const socket = createConnection(pipePath) as ShutdownControlSocket;
  return attachShutdownControl(socket, token, shutdown, timeoutMs, onShutdownError);
}

export interface ShutdownControlSocket {
  setEncoding(encoding: BufferEncoding): this;
  write(data: string): boolean;
  destroy(): this;
  end(): this;
  on(event: "data", listener: (chunk: string | Buffer) => void): this;
  once(event: "connect", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: () => void): this;
}

export function attachShutdownControl(
  socket: ShutdownControlSocket,
  token: string,
  shutdown: () => Promise<void>,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  onShutdownError: (error: unknown) => void = () => undefined,
): Promise<ShutdownControlSession> {
  if (!token || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Shutdown-control token and positive finite timeout are required.");
  }

  socket.setEncoding("utf8");

  return new Promise<ShutdownControlSession>((resolve, reject) => {
    let buffer = "";
    let ready = false;
    let settled = false;
    let responseSent = false;
    let shutdownPromise: Promise<void> | undefined;
    let startupAckPromise: Promise<void> | undefined;
    let resolveStartupAck: (() => void) | undefined;
    let rejectStartupAck: ((error: Error) => void) | undefined;
    let startupAckTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error("Timed out waiting for the shutdown-control handshake."));
    }, timeoutMs);

    const finish = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    socket.once("connect", () => {
      socket.write(`HELLO ${token}\n`);
    });

    socket.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString();
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!ready && line === "READY") {
          ready = true;
          settled = true;
          clearTimeout(timer);
          resolve({
            confirmReady: () => {
              if (startupAckPromise) return startupAckPromise;
              startupAckPromise = new Promise<void>((readyResolve, readyReject) => {
                resolveStartupAck = readyResolve;
                rejectStartupAck = readyReject;
                startupAckTimer = setTimeout(() => {
                  const error = new Error("Timed out waiting for backend readiness acknowledgement.");
                  rejectStartupAck?.(error);
                  onShutdownError(error);
                  socket.destroy();
                }, timeoutMs);
              });
              socket.write("STARTED\n");
              return startupAckPromise;
            },
            failStartup: () => {
              socket.write("STARTUP_ERROR\n");
              socket.end();
            },
          });
          continue;
        }
        if (ready && line === "RUNNING") {
          if (startupAckTimer) clearTimeout(startupAckTimer);
          resolveStartupAck?.();
          continue;
        }
        if (ready && line === "STARTUP_ERROR") {
          if (startupAckTimer) clearTimeout(startupAckTimer);
          rejectStartupAck?.(new Error("Backend failed before becoming ready."));
          continue;
        }
        if (!ready && line === "REJECTED") {
          finish(new Error("The shutdown-control server rejected this client."));
          socket.end();
          continue;
        }
        if (ready && line === "STOP") {
          shutdownPromise ??= shutdown();
          void shutdownPromise.then(
            () => {
              responseSent = true;
              socket.write("ACK\n");
            },
            (error: unknown) => {
              responseSent = true;
              onShutdownError(error);
              socket.write("ERROR\n");
            },
          );
        }
      }
    });

    socket.once("error", (error) => {
      if (!ready) finish(error);
      else handleControlFailure(error);
    });
    socket.once("close", () => {
      if (!ready) finish(new Error("The shutdown-control connection closed before authorization."));
      else if (startupAckPromise && rejectStartupAck) {
        const error = new Error("The shutdown-control connection closed before backend readiness.");
        if (startupAckTimer) clearTimeout(startupAckTimer);
        rejectStartupAck(error);
      }
      else if (!responseSent) {
        handleControlFailure(new Error("The shutdown-control connection closed unexpectedly."));
      }
    });

    function handleControlFailure(error: Error): void {
      if (responseSent) return;
      responseSent = true;
      onShutdownError(error);
      shutdownPromise ??= shutdown();
      void shutdownPromise.catch(onShutdownError);
    }
  });
}
