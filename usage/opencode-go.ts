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

let snapshot: UsageSnapshot | undefined;
let inflight: Promise<UsageSnapshot | undefined> | undefined;
let lastFetchedAt = 0;

export function getCachedSnapshot(): UsageSnapshot | undefined {
	return snapshot;
}

/** Combine the request timeout with an optional caller abort signal. */
function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	if (!signal) return timeout;

	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
	timeout.addEventListener("abort", abort, { once: true });
	return controller.signal;
}

export async function fetchUsage(
	ctx: ExtensionContext,
	force = false,
	signal?: AbortSignal,
): Promise<UsageSnapshot | undefined> {
	if (inflight) return inflight;
	if (!force && snapshot && Date.now() - lastFetchedAt < MIN_REFRESH_GAP_MS) {
		return snapshot;
	}

	inflight = (async () => {
		try {
			const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER);
			const apiKey = auth?.auth?.apiKey;
			if (!apiKey) return undefined;

			const baseUrl = (auth?.auth?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
			const headers = new Headers();
			for (const [name, value] of Object.entries(auth?.auth?.headers ?? {})) {
				if (typeof value === "string") headers.set(name, value);
			}
			// Respect a provider-supplied Authorization; only add the bearer token
			// when the provider headers do not already carry one.
			if (!headers.has("authorization")) headers.set("Authorization", `Bearer ${apiKey}`);

			const response = await fetch(`${baseUrl}/usage`, {
				headers,
				signal: requestSignal(signal),
			});
			if (!response.ok) {
				throw new Error(`usage endpoint returned HTTP ${response.status}`);
			}

			const payload = (await response.json()) as UsageResponse;
			const usage = payload.usage ?? {};
			snapshot = {
				fetchedAt: Date.now(),
				rolling: usage.rolling,
				weekly: usage.weekly,
				monthly: usage.monthly,
			};
			lastFetchedAt = snapshot.fetchedAt;
			return snapshot;
		} finally {
			inflight = undefined;
		}
	})();

	return inflight;
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
