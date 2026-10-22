import http2 from "node:http2";
import type { AddressInfo } from "node:net";

export interface FakePushRequest {
  path: string;
  topic: string | undefined;
  body: string;
  token: string;
}

export interface FakePush {
  /** Address to use as APNS_HOST. */
  url: string;
  requests: FakePushRequest[];
  /** Make pushes to this token fail with the given status and reason (e.g. 410 Unregistered). */
  failToken: (token: string, status: number, reason: string) => void;
  clear: () => void;
  close: () => Promise<void>;
}

/** A stand-in for Apple's push service: records every push it receives. */
export async function startFakePush(): Promise<FakePush> {
  const requests: FakePushRequest[] = [];
  const failures = new Map<string, { status: number; reason: string }>();

  const server = http2.createServer();
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => (body += chunk));
    stream.on("end", () => {
      const path = String(headers[":path"] ?? "");
      const token = path.split("/").pop() ?? "";
      requests.push({ path, topic: headers["apns-topic"] as string | undefined, body, token });
      const failure = failures.get(token);
      if (failure) {
        stream.respond({ ":status": failure.status, "content-type": "application/json" });
        stream.end(JSON.stringify({ reason: failure.reason }));
      } else {
        stream.respond({ ":status": 200 });
        stream.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    failToken: (token, status, reason) => failures.set(token, { status, reason }),
    clear: () => {
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const session of sessions) session.destroy();
      }),
  };
}
