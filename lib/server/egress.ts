import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, type Dispatcher } from "undici";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;
const finalResponseUrls = new WeakMap<Response, URL>();

const blockedIpv4Addresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}

const blockedIpv6Addresses = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

const blockedHostnames = new Set([
  "metadata.google.internal",
  "metadata.goog",
]);

export class EgressPolicyError extends Error {
  constructor() {
    super("URL is not allowed");
    this.name = "EgressPolicyError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type ResolveHost = (
  hostname: string,
) => Promise<readonly ResolvedAddress[]>;

interface PinnedConnection {
  dispatcher: Dispatcher;
  close: () => Promise<void>;
}

type CreatePinnedConnection = (address: ResolvedAddress) => PinnedConnection;

type DispatcherFetch = (
  input: URL | string,
  init: RequestInit & { dispatcher: Dispatcher },
) => Promise<Response>;

interface SafeFetchOptions {
  fetchImpl?: DispatcherFetch;
  resolver?: ResolveHost;
  timeoutMs?: number;
  maxRedirects?: number;
  connectionFactory?: CreatePinnedConnection;
}

const resolveHost: ResolveHost = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({
    address,
    family: family as 4 | 6,
  }));
};

export async function assertSafeUrl(
  url: URL,
  resolver: ResolveHost = resolveHost,
): Promise<ResolvedAddress> {
  const expectedPort = url.protocol === "http:" ? "80" : "443";
  const effectivePort = url.port || expectedPort;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addressType = isIP(hostname);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    effectivePort !== expectedPort ||
    url.username !== "" ||
    url.password !== "" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    blockedHostnames.has(hostname.toLowerCase()) ||
    isBlockedAddress(hostname)
  ) {
    throw new EgressPolicyError();
  }

  if (addressType !== 0) {
    return { address: hostname, family: addressType as 4 | 6 };
  }

  let addresses;
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new EgressPolicyError();
  }

  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isBlockedAddress(address))
  ) {
    throw new EgressPolicyError();
  }

  return addresses[0];
}

export async function safeFetch(
  input: URL | string,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
) {
  const fetchImpl = options.fetchImpl ?? (fetch as DispatcherFetch);
  const resolver = options.resolver ?? resolveHost;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const connectionFactory =
    options.connectionFactory ?? createPinnedConnection;
  let currentUrl = input instanceof URL ? input : new URL(input);

  for (let redirectCount = 0; ; redirectCount += 1) {
    const selectedAddress = await assertSafeUrl(currentUrl, resolver);
    const connection = connectionFactory(selectedAddress);
    let response;

    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = init.signal
        ? AbortSignal.any([init.signal, timeoutSignal])
        : timeoutSignal;
      response = await fetchImpl(currentUrl, {
        ...init,
        dispatcher: connection.dispatcher,
        redirect: "manual",
        signal,
      });
    } catch (error) {
      await connection.close();
      throw error;
    }

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      const managedResponse = attachConnectionLifecycle(
        response,
        connection.close,
      );
      finalResponseUrls.set(managedResponse, new URL(currentUrl));
      return managedResponse;
    }

    const location = response.headers.get("location");
    await response.body?.cancel();
    await connection.close();

    if (!location || redirectCount >= maxRedirects) {
      throw new EgressPolicyError();
    }

    currentUrl = new URL(location, currentUrl);
  }
}

export function getFinalUrl(response: Response) {
  const finalUrl = finalResponseUrls.get(response);
  if (!finalUrl) {
    throw new EgressPolicyError();
  }
  return new URL(finalUrl);
}

export function createPinnedLookup(address: ResolvedAddress) {
  return (
    _hostname: string,
    options: { all?: boolean },
    callback: (
      error: Error | null,
      result: string | ResolvedAddress[],
      family?: number,
    ) => void,
  ) => {
    if (options.all) {
      callback(null, [{ address: address.address, family: address.family }]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

function createPinnedConnection(address: ResolvedAddress): PinnedConnection {
  const dispatcher = new Agent({
    connect: { lookup: createPinnedLookup(address) },
  });

  return {
    dispatcher,
    close: () => dispatcher.close(),
  };
}

function attachConnectionLifecycle(
  response: Response,
  close: () => Promise<void>,
) {
  if (!response.body) {
    void close();
    return response;
  }

  const reader = response.body.getReader();
  let closed = false;
  const closeOnce = async () => {
    if (closed) return;
    closed = true;
    await close();
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await closeOnce();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
        await closeOnce();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      await closeOnce();
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function isBlockedAddress(address: string) {
  const addressType = isIP(address);

  return (
    (addressType === 4 && blockedIpv4Addresses.check(address, "ipv4")) ||
    (addressType === 6 && blockedIpv6Addresses.check(address, "ipv6"))
  );
}
