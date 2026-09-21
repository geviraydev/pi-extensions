/**
 * Stored opencode-go API keys ("key pool").
 *
 * Keys live in a plaintext 0600 JSON file in the pi agent directory, separate
 * from pi's own auth.json. Switching logs in through pi's credential store
 * (`ModelRuntime.login`), which writes auth.json under its file lock and
 * updates the in-memory credential state, so there is one source of truth for
 * the effective key.
 *
 * The file holds names and secrets only. Reports and session entries use the
 * fingerprint from keys.ts; add also writes the label file so the report names
 * the key.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PROVIDER } from "./opencode-go.ts";

export type StoredKey = {
	name: string;
	key: string;
};

export type KeyPool = {
	keys: StoredKey[];
};

const POOL_FILE = join(getAgentDir(), "opencode-go-usage-keys.json");
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_NAME_LENGTH = 40;

export function isValidKeyName(name: string): boolean {
	return name.length <= MAX_NAME_LENGTH && NAME_RE.test(name);
}

export async function readPool(): Promise<KeyPool> {
	let raw: string;
	try {
		raw = await readFile(POOL_FILE, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { keys: [] };
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`key pool file is not valid JSON: ${POOL_FILE}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`key pool file has an unexpected shape: ${POOL_FILE}`);
	}

	const data = parsed as { keys?: unknown };
	if (!Array.isArray(data.keys)) {
		throw new Error(`key pool file is missing the "keys" array: ${POOL_FILE}`);
	}

	const keys: StoredKey[] = [];
	const names = new Set<string>();
	for (const entry of data.keys) {
		const { name, key } = (entry ?? {}) as { name?: unknown; key?: unknown };
		if (typeof name !== "string" || name.length === 0 || typeof key !== "string" || key.length === 0) {
			throw new Error(`key pool file contains an invalid entry: ${POOL_FILE}`);
		}
		if (names.has(name)) {
			throw new Error(`key pool file contains duplicate name "${name}": ${POOL_FILE}`);
		}
		names.add(name);
		keys.push({ name, key });
	}

	return { keys };
}

export async function writePool(pool: KeyPool): Promise<void> {
	await mkdir(dirname(POOL_FILE), { recursive: true });
	await writeFile(POOL_FILE, `${JSON.stringify({ keys: pool.keys }, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	// writeFile applies mode only when it creates the file.
	await chmod(POOL_FILE, 0o600);
}

type RuntimeKeyControl = {
	login(
		provider: string,
		type: "api_key",
		interaction: {
			signal?: AbortSignal;
			prompt: (prompt: { type: "secret"; message: string }) => Promise<string>;
			notify: (event: unknown) => void;
		},
	): Promise<unknown>;
	setRuntimeApiKey(provider: string, apiKey: string): Promise<void>;
	removeRuntimeApiKey(provider: string, options?: { signal?: AbortSignal }): Promise<void>;
};

/**
 * ModelRegistry keeps its ModelRuntime private, and login plus the runtime
 * override are the only ways to change the effective credential without
 * restarting pi. This is the same method pi's own `/login` and `--api-key`
 * handling call.
 */
function runtimeControl(ctx: ExtensionContext): RuntimeKeyControl {
	const runtime = (ctx.modelRegistry as unknown as { runtime?: RuntimeKeyControl }).runtime;
	if (!runtime?.login || !runtime.removeRuntimeApiKey) {
		throw new Error("pi runtime credential access is unavailable");
	}
	return runtime;
}

/**
 * Make `apiKey` the effective opencode-go credential by logging in through
 * pi's credential store, which persists to auth.json and refreshes provider
 * availability.
 */
export async function loginKey(ctx: ExtensionContext, apiKey: string): Promise<void> {
	await runtimeControl(ctx).login(PROVIDER, "api_key", {
		signal: ctx.signal,
		prompt: async () => apiKey,
		notify: () => {},
	});
}

/** Drop a runtime override (`pi --api-key`) that would shadow auth.json. */
export async function clearRuntimeOverride(ctx: ExtensionContext): Promise<void> {
	await runtimeControl(ctx).removeRuntimeApiKey(PROVIDER, { signal: ctx.signal });
}

/** Put a runtime override back, e.g. after a failed switch. */
export async function setRuntimeOverride(ctx: ExtensionContext, apiKey: string): Promise<void> {
	const runtime = runtimeControl(ctx);
	if (!runtime.setRuntimeApiKey) throw new Error("pi runtime API key override is unavailable");
	await runtime.setRuntimeApiKey(PROVIDER, apiKey);
}
