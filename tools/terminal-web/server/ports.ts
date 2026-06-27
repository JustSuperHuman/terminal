import type http from "node:http";
import net from "node:net";

async function canBind(host: string, port: number): Promise<boolean> {
  const probe = net.createServer();

  return new Promise<boolean>((resolve) => {
    probe.once("error", () => {
      resolve(false);
    });
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, host);
  });
}

async function listen(server: http.Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function listenOnAvailablePort(
  server: http.Server,
  host: string,
  startPort: number,
  maxAttempts = 100
): Promise<number> {
  let port = startPort;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1, port += 1) {
    if (!(await canBind(host, port))) {
      continue;
    }

    try {
      await listen(server, host, port);
      return port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }
    }
  }

  throw new Error(`No available port found from ${startPort} after ${maxAttempts} attempts.`);
}
