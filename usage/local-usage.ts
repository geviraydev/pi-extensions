/**
 * Local opencode-go usage aggregation.
 *
 * The quota endpoint only exposes percentages, so the per-model breakdown is
 * reconstructed from the two clients on this machine:
 *
 * - pi session files in `~/.pi/agent/sessions/` (exact tokens + recorded cost)
 * - the OpenCode client database in `~/.local/share/opencode/opencode.db`
 *   (tokens; cost is estimated from the rates learned from pi sessions)
 *
 * Parsed pi files are cached by path + mtime + size, so repeated `/usage`
 * calls only re-read files that changed.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { keyFingerprint } from "./keys.ts";

const PI_SESSIONS_DIR = join(getAgentDir(), "sessions");
const OPENCODE_DIR = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode");
const OPENCODE_DB = join(OPENCODE_DIR, "opencode.db");
const OPENCODE_AUTH = join(OPENCODE_DIR, "auth.json");
const PROVIDER = "opencode-go";
const MTIME_MARGIN_MS = 12 * 3600_000;

export type UsageEvent = {
	ts: number;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	costKnown: boolean;
	source: "pi" | "opencode";
	/** Fingerprint of the API key this request was made with, when known. */
	key?: string;
};

export type ModelUsage = {
	model: string;
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tokens: number;
	cost: number;
	costKnown: boolean;
};

export type WindowUsage = {
	requests: number;
	tokens: number;
	cost: number;
	models: ModelUsage[];
};

type Rate = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

type CacheEntry = {
	mtimeMs: number;
	size: number;
	events: UsageEvent[];
};

const fileCache = new Map<string, CacheEntry>();
const rateTable = new Map<string, Rate>();

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function mergeRate(model: string, next: Partial<Rate>): void {
	const previous = rateTable.get(model);
	rateTable.set(model, {
		input: next.input || previous?.input || 0,
		output: next.output || previous?.output || 0,
		cacheRead: next.cacheRead || previous?.cacheRead || 0,
		cacheWrite: next.cacheWrite || previous?.cacheWrite || 0,
	});
}

function estimateCost(
	model: string,
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
): { cost: number; known: boolean } {
	const rate = rateTable.get(model);
	if (!rate) return { cost: 0, known: false };
	const cost =
		input * rate.input + output * rate.output + cacheRead * rate.cacheRead + cacheWrite * rate.cacheWrite;
	return { cost, known: true };
}

// ---------------------------------------------------------------------------
// pi session files
// ---------------------------------------------------------------------------

async function listJsonlFiles(dir: string): Promise<string[]> {
	const files: string[] = [];
	async function walk(current: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
		}
	}
	await walk(dir);
	return files;
}

function parsePiContent(content: string): UsageEvent[] {
	const events: UsageEvent[] = [];
	let currentKey: string | undefined;

	for (const line of content.split("\n")) {
		if (line.includes('"customType":"opencode-go-key"')) {
			try {
				const entry = JSON.parse(line) as { data?: { fp?: unknown } };
				if (typeof entry.data?.fp === "string") currentKey = entry.data.fp;
			} catch {
				// ignore malformed entry
			}
			continue;
		}

		if (!line.includes('"role":"assistant"') || !line.includes(`"provider":"${PROVIDER}"`)) continue;

		let entry: { timestamp?: unknown; message?: Record<string, unknown> };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue;
		}

		const message = entry.message;
		if (!message || message.role !== "assistant" || message.provider !== PROVIDER) continue;

		const usage = (message.usage ?? {}) as Record<string, unknown>;
		const cost = (usage.cost ?? {}) as Record<string, unknown>;
		const input = num(usage.input);
		const output = num(usage.output);
		const cacheRead = num(usage.cacheRead);
		const cacheWrite = num(usage.cacheWrite);

		const ts =
			typeof message.timestamp === "number"
				? message.timestamp
				: Date.parse(String(entry.timestamp ?? ""));
		if (!Number.isFinite(ts)) continue;

		const model = typeof message.model === "string" ? message.model : "unknown";

		// Learn per-token rates so OpenCode client rows, which record cost 0 on
		// the subscription, can still be weighted.
		if (input + output + cacheRead + cacheWrite > 0) {
			mergeRate(model, {
				input: input > 0 ? num(cost.input) / input : 0,
				output: output > 0 ? num(cost.output) / output : 0,
				cacheRead: cacheRead > 0 ? num(cost.cacheRead) / cacheRead : 0,
				cacheWrite: cacheWrite > 0 ? num(cost.cacheWrite) / cacheWrite : 0,
			});
		}

		const totalCost =
			num(cost.total) ||
			num(cost.input) + num(cost.output) + num(cost.cacheRead) + num(cost.cacheWrite);

		events.push({
			ts,
			model,
			input,
			output,
			cacheRead,
			cacheWrite,
			cost: totalCost,
			costKnown: true,
			source: "pi",
			key: currentKey,
		});
	}
	return events;
}

export async function collectPiEvents(sinceMs: number, sessionsDir = PI_SESSIONS_DIR): Promise<UsageEvent[]> {
	const paths = await listJsonlFiles(sessionsDir);
	const cutoff = sinceMs - MTIME_MARGIN_MS;
	const changed: Array<{ path: string; mtimeMs: number; size: number }> = [];

	for (const path of paths) {
		try {
			const info = await stat(path);
			if (info.mtimeMs >= cutoff) changed.push({ path, mtimeMs: info.mtimeMs, size: info.size });
		} catch {
			// ignore unreadable files
		}
	}

	// Oldest first so newer rate observations win.
	changed.sort((a, b) => a.mtimeMs - b.mtimeMs);

	const events: UsageEvent[] = [];
	for (const file of changed) {
		const cached = fileCache.get(file.path);
		let fileEvents: UsageEvent[];
		if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
			fileEvents = cached.events;
		} else {
			try {
				fileEvents = parsePiContent(await readFile(file.path, "utf8"));
			} catch {
				continue;
			}
			fileCache.set(file.path, { mtimeMs: file.mtimeMs, size: file.size, events: fileEvents });
		}
		events.push(...fileEvents);
	}

	return events.filter((event) => event.ts >= sinceMs);
}

// ---------------------------------------------------------------------------
// OpenCode client database
// ---------------------------------------------------------------------------

type OpenCodeMessage = {
	role?: string;
	providerID?: string;
	modelID?: string;
	cost?: number;
	tokens?: {
		input?: number;
		output?: number;
		cache?: { read?: number; write?: number };
	};
	time?: { created?: number };
};

async function readOpencodeKeyFingerprint(): Promise<string | undefined> {
	try {
		const parsed = JSON.parse(await readFile(OPENCODE_AUTH, "utf8")) as Record<string, { key?: unknown } | undefined>;
		const key = parsed?.[PROVIDER]?.key;
		return typeof key === "string" && key.length > 0 ? keyFingerprint(key) : undefined;
	} catch {
		return undefined;
	}
}

async function collectOpencodeEvents(sinceMs: number): Promise<UsageEvent[]> {
	let DatabaseSync: (new (path: string, options?: { readOnly?: boolean }) => {
		prepare(sql: string): { all(...params: unknown[]): unknown[] };
		close(): void;
	}) | undefined;

	try {
		// node:sqlite still prints an experimental warning on import; swallow
		// just that one so it does not corrupt the TUI.
		const original = process.emitWarning;
		const filtered = ((warning: string | Error, ...rest: unknown[]) => {
			const text = typeof warning === "string" ? warning : warning?.message ?? "";
			if (text.includes("SQLite is an experimental feature")) return;
			(original as (...args: unknown[]) => void)(warning, ...rest);
		}) as typeof process.emitWarning;
		process.emitWarning = filtered;
		try {
			DatabaseSync = (await import("node:sqlite")).DatabaseSync as typeof DatabaseSync;
		} finally {
			process.emitWarning = original;
		}
	} catch {
		return [];
	}
	if (!DatabaseSync) return [];

	let db: { prepare(sql: string): { all(...params: unknown[]): unknown[] }; close(): void };
	try {
		db = new DatabaseSync(OPENCODE_DB, { readOnly: true });
	} catch {
		return [];
	}

	const events: UsageEvent[] = [];
	const opencodeKey = await readOpencodeKeyFingerprint();
	try {
		const rows = db.prepare("SELECT data FROM message WHERE time_created >= ?").all(sinceMs);
		for (const row of rows) {
			const data = (row as { data?: unknown }).data;
			if (typeof data !== "string") continue;

			let message: OpenCodeMessage;
			try {
				message = JSON.parse(data) as OpenCodeMessage;
			} catch {
				continue;
			}
			if (message.role !== "assistant" || message.providerID !== PROVIDER) continue;

			const ts = message.time?.created;
			if (typeof ts !== "number" || !Number.isFinite(ts) || ts < sinceMs) continue;

			const input = num(message.tokens?.input);
			const output = num(message.tokens?.output);
			const cacheRead = num(message.tokens?.cache?.read);
			const cacheWrite = num(message.tokens?.cache?.write);
			const model = message.modelID ?? "unknown";

			let cost = num(message.cost);
			let costKnown = cost > 0;
			if (!costKnown) {
				const estimate = estimateCost(model, input, output, cacheRead, cacheWrite);
				cost = estimate.cost;
				costKnown = estimate.known;
			}

			events.push({ ts, model, input, output, cacheRead, cacheWrite, cost, costKnown, source: "opencode", key: opencodeKey });
		}
	} catch {
		// ignore: database may be locked or have an unexpected schema
	} finally {
		try {
			db.close();
		} catch {
			// ignore
		}
	}

	return events;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function collectEvents(sinceMs: number): Promise<UsageEvent[]> {
	const events = await collectPiEvents(sinceMs);
	events.push(...(await collectOpencodeEvents(sinceMs)));
	events.sort((a, b) => a.ts - b.ts);
	return events;
}

export function aggregate(events: UsageEvent[], start: number, end: number): WindowUsage {
	const byModel = new Map<string, ModelUsage>();
	const total: WindowUsage = { requests: 0, tokens: 0, cost: 0, models: [] };

	for (const event of events) {
		if (event.ts < start || event.ts >= end) continue;

		let model = byModel.get(event.model);
		if (!model) {
			model = {
				model: event.model,
				requests: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				tokens: 0,
				cost: 0,
				costKnown: true,
			};
			byModel.set(event.model, model);
		}

		model.requests += 1;
		model.input += event.input;
		model.output += event.output;
		model.cacheRead += event.cacheRead;
		model.cacheWrite += event.cacheWrite;
		model.tokens += event.input + event.output;
		model.cost += event.cost;
		if (!event.costKnown) model.costKnown = false;

		total.requests += 1;
		total.tokens += event.input + event.output;
		total.cost += event.cost;
	}

	total.models = [...byModel.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
	return total;
}
