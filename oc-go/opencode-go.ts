/**
 * opencode-go quota client.
 *
 * The subscription quota lives behind `<baseUrl>/usage` and is authenticated
 * with the same credential pi already stores for the `opencode-go` provider.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PROVIDER = "opencode-go";

const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_REFRESH_GAP_MS = 10_000;

export type UsageWindow = {
	status?: string;
	percent?: number;
	resetsAt?: string;
};

export type UsageSnapshot = {
	fetchedAt: number;
	rolling?: UsageWindow;
	weekly?: UsageWindow;
	monthly?: UsageWindow;
};

type UsageResponse = {
	usage?: {
		rolling?: UsageWindow;
		weekly?: UsageWindow;
		monthly?: UsageWindow;
	};
};

export type WindowKey = "rolling" | "weekly" | "monthly";

export const WINDOW_KEYS: readonly WindowKey[] = ["rolling", "weekly", "monthly"];

export const WINDOW_TITLES: Record<WindowKey, string> = {
	rolling: "last 5h",
	weekly: "last 7d",
	monthly: "last 30d",
};

const WINDOW_PERIOD_MS: Record<WindowKey, number> = {
	rolling: 5 * 3600_000,
	weekly: 7 * 86400_000,
	monthly: 30 * 86400_000,
};

type CachedUsage = { key: string; snapshot: UsageSnapshot; at: number };

let cache: CachedUsage | undefined;
let inflight: { key: string; id: number; promise: Promise<UsageSnapshot> } | undefined;
let nextId = 0;

/** Credentials needed for one quota call. */
export type UsageCredentials = {
	apiKey: string;
	baseUrl?: string;
	headers?: Record<string, string>;
};

/** Combine the request timeout with an optional caller abort signal. */
function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

type ProviderAuthLike = {
	auth?: { baseUrl?: string; headers?: Record<string, string | null> };
};

/** Endpoint and configured headers, without the secret. */
function requestSettings(auth: ProviderAuthLike | undefined): Omit<UsageCredentials, "apiKey"> {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(auth?.auth?.headers ?? {})) {
		// Provider auth can already embed `Authorization: Bearer <active key>`
		// when authHeader is configured. Drop it so per-key queries always send
		// the key they were asked for via fetchUsageWithCredentials.
		if (typeof value === "string" && name.toLowerCase() !== "authorization") headers[name] = value;
	}
	return { baseUrl: auth?.auth?.baseUrl, headers };
}

/** Credentials for the effective key, or undefined when none is configured. */
async function resolveUsageCredentials(
	ctx: ExtensionContext,
): Promise<UsageCredentials | undefined> {
	const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER);
	const apiKey = auth?.auth?.apiKey;
	if (!apiKey) return undefined;
	return { ...requestSettings(auth), apiKey };
}

/**
 * Endpoint and headers for the provider, without a key. Stored keys reuse
 * these so `/oc-go keys` can query each key's quota without switching.
 */
export async function resolveRequestSettings(
	ctx: ExtensionContext,
): Promise<Omit<UsageCredentials, "apiKey">> {
	return requestSettings(await ctx.modelRegistry.getProviderAuth(PROVIDER));
}

/** One quota call with explicit credentials; no caching. */
export async function fetchUsageWithCredentials(
	credentials: UsageCredentials,
	signal?: AbortSignal,
): Promise<UsageSnapshot> {
	const baseUrl = (credentials.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const headers = new Headers();
	for (const [name, value] of Object.entries(credentials.headers ?? {})) {
		headers.set(name, value);
	}
	// Callers pass provider headers without a credential-derived Authorization;
	// add the bearer token for the key this call carries.
	if (!headers.has("authorization")) headers.set("Authorization", `Bearer ${credentials.apiKey}`);

	const response = await fetch(`${baseUrl}/usage`, {
		headers,
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		throw new Error(`usage endpoint returned HTTP ${response.status}`);
	}

	const payload = (await response.json()) as UsageResponse;
	const usage = payload.usage ?? {};
	return {
		fetchedAt: Date.now(),
		rolling: usage.rolling,
		weekly: usage.weekly,
		monthly: usage.monthly,
	};
}

/** Cached quota for the effective key. */
export async function fetchUsage(
	ctx: ExtensionContext,
	force = false,
	signal?: AbortSignal,
): Promise<UsageSnapshot | undefined> {
	const credentials = await resolveUsageCredentials(ctx);
	if (!credentials) return undefined;

	if (inflight && inflight.key === credentials.apiKey) return inflight.promise;
	if (
		!force &&
		cache &&
		cache.key === credentials.apiKey &&
		Date.now() - cache.at < MIN_REFRESH_GAP_MS
	) {
		return cache.snapshot;
	}

	// Only the newest request may update the cache, so a slow response for an
	// older credential cannot overwrite a newer one after a key switch.
	const id = ++nextId;
	const promise = fetchUsageWithCredentials(credentials, signal);
	inflight = { key: credentials.apiKey, id, promise };
	try {
		const snapshot = await promise;
		if (inflight?.id === id) cache = { key: credentials.apiKey, snapshot, at: Date.now() };
		return snapshot;
	} finally {
		if (inflight?.id === id) inflight = undefined;
	}
}

/**
 * Time range of a quota window. The server reports when the window resets, so
 * the start is derived by subtracting the window's period.
 */
export function windowRange(key: WindowKey, snap: UsageSnapshot): { start: number; end: number } {
	const period = WINDOW_PERIOD_MS[key];
	const parsed = snap[key]?.resetsAt ? Date.parse(snap[key]!.resetsAt!) : Number.NaN;
	const now = Date.now();

	let end = Number.isFinite(parsed) ? parsed : now;
	// If the reported reset already passed, project forward to the next one.
	if (end <= now) end += Math.ceil((now - end) / period) * period;

	return { start: end - period, end };
}
