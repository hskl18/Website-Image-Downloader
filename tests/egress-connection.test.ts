import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createPinnedConnection } from "../lib/server/egress";

// Real sockets on purpose: the route tests stub fetch, so they missed Node.js 26's
// built-in fetch rejecting the Agent from undici 6 (every download returned 500).
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.end(`${request.headers.host} ok`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it("connects the built-in fetch to the pinned address through the undici Agent", async () => {
  const connection = createPinnedConnection({ address: "127.0.0.1", family: 4 });
  try {
    // .invalid never resolves in DNS, so a response proves the pinned address was used.
    const response = await fetch(`http://pinned.invalid:${port}/`, {
      dispatcher: connection.dispatcher,
    } as RequestInit);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`pinned.invalid:${port} ok`);
  } finally {
    await connection.close();
  }
});
