/**
 * OpenCode Go usage tracker for pi.
 *
 * - Footer status: rolling (5h), weekly, and monthly quota percentages,
 *   colored when getting close to a limit, prefixed with the active key name.
 * - `/oc-go`: quota snapshot with a per-model breakdown of each quota window,
 *   plus stored-key management (`keys`, `add`, `use`, `rm`, `label`) where
 *   switching logs in through pi's credential store.
 * - `opencode_usage` tool: lets the model check quota and breakdown when asked.
 *
 * Quota comes from `<baseUrl>/usage` and is scoped to the workspace of the
 * active API key, so keys from the same workspace report the same windows.
 * The per-model breakdown is local-only and is attributed to keys using
 * session entries, so switching keys does not mix usage.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	clearRuntimeOverride,
	isValidKeyName,
	loginKey,
	readPool,
	setRuntimeOverride,
	writePool,
	type KeyPool,
} from "./key-pool.ts";
import {
	currentKeyFingerprint,
	KEY_ENTRY,
	keyFingerprint,
	readLabels,
	setLabel,
} from "./keys.ts";
import { aggregate, collectEvents, type ModelUsage, type UsageEvent, type WindowUsage } from "./local-usage.ts";
import {
	fetchUsage,
	fetchUsageWithCredentials,
	PROVIDER,
	resolveRequestSettings,
	type UsageSnapshot,
	type UsageWindow,
	WINDOW_KEYS,
	WINDOW_TITLES,
	windowRange,
} from "./opencode-go.ts";

const ENTRY_TYPE = "opencode-go-usage";
const STATUS_KEY = "opencode-go-usage";
const STATUS_LABEL = "oc-go";
const REFRESH_INTERVAL_MS = 120_000;

type Theme = ExtensionContext["ui"]["theme"];

type UsageTotals = Pick<WindowUsage, "cost" | "tokens">;

type ReportWindow = {
	key: string;
	label: string;
	percent?: number;
	status?: string;
	resetsAt?: string;
	start: number;
	end: number;
	total: { requests: number; tokens: number; cost: number };
	models: ModelUsage[];
	/** Local usage not matched to a stored or labeled key. */
	unattributed?: WindowUsage;
	/** Stored or labeled credentials other than the active key. */
	keyRows?: KeyRow[];
};

type KeyRow = {
	fingerprint: string;
	label: string;
	requests: number;
	tokens: number;
	cost: number;
	models: ModelUsage[];
};

type UsageReport = {
	fetchedAt: number;
	snapshot: UsageSnapshot;
	/** Fingerprint of the API key the report is scoped to. */
	fingerprint?: string;
	fingerprintLabel?: string;
	windows: ReportWindow[];
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const OC_GO_COMMANDS: ReadonlyArray<{ verb: string; label: string; usage: string; description: string }> = [
	{ verb: "usage", label: "usage", usage: "/oc-go", description: "Quota and local usage breakdown" },
	{ verb: "keys", label: "keys", usage: "/oc-go keys", description: "Stored keys with per-key quota" },
	{
		verb: "add",
		label: "add <name> [key]",
		usage: "/oc-go add <name> [key]",
		description: "Store a key (default: current login)",
	},
	{ verb: "use", label: "use <name>", usage: "/oc-go use <name>", description: "Log in with a stored key" },
	{ verb: "rm", label: "rm <name>", usage: "/oc-go rm <name>", description: "Remove a stored key" },
	{ verb: "label", label: "label <name>", usage: "/oc-go label <name>", description: "Label the active key" },
	{ verb: "help", label: "help", usage: "/oc-go help", description: "List these commands" },
];

/**
 * Argument hints for `/oc-go`: subcommands, plus stored key names for `use`
 * and `rm`. Returned items replace the whole argument text, so the value of a
 * second-level completion includes the subcommand.
 */
async function ocGoArgumentCompletions(prefix: string): Promise<AutocompleteItem[] | null> {
	const text = prefix.trimStart();
	const lower = text.toLowerCase();

	const keyArg = /^(use|rm)\s+(\S*)$/i.exec(text);
	if (keyArg) {
		const verb = keyArg[1]!.toLowerCase();
		const namePrefix = keyArg[2]!.toLowerCase();
		const items: AutocompleteItem[] = [];
		try {
			for (const stored of (await readPool()).keys) {
				if (stored.name.toLowerCase().startsWith(namePrefix)) {
					items.push({
						value: `${verb} ${stored.name}`,
						label: stored.name,
						description: keyFingerprint(stored.key),
					});
				}
			}
		} catch {
			// Completion can stay empty; commands surface pool errors themselves.
		}
		return items.length > 0 ? items : null;
	}

	const subcommands: AutocompleteItem[] = OC_GO_COMMANDS.filter((command) =>
		command.verb.startsWith(lower),
	).map((command) => ({
		value: command.verb,
		label: command.label,
		description: command.description,
	}));
	return subcommands.length > 0 ? subcommands : null;
}

// ---------------------------------------------------------------------------
// Report building
// ---------------------------------------------------------------------------

async function buildReport(
	ctx: ExtensionContext,
	force: boolean,
	signal?: AbortSignal,
): Promise<UsageReport | undefined> {
	const snapshot = await fetchUsage(ctx, force, signal);
	if (!snapshot) return undefined;

	const fingerprint = await currentKeyFingerprint(ctx);
	const ranges = WINDOW_KEYS.map((key) => ({ key, ...windowRange(key, snapshot) }));
	const since = Math.min(...ranges.map((range) => range.start));

	let events: UsageEvent[] = [];
	try {
		events = await collectEvents(since);
	} catch {
		events = [];
	}

	// The active key is the primary block; other stored/labeled fingerprints get
	// a row each. Everything without a recorded key, or with a fingerprint that
	// is neither stored nor labeled, is unattributed.
	const scoped = fingerprint ? events.filter((event) => event.key === fingerprint) : [];
	const names = await readLabels();
	const keyEvents = new Map<string, UsageEvent[]>();
	const unattributed: UsageEvent[] = [];
	for (const event of events) {
		if (event.key === undefined) {
			unattributed.push(event);
		} else if (event.key !== fingerprint) {
			if (names[event.key]) {
				const list = keyEvents.get(event.key);
				if (list) list.push(event);
				else keyEvents.set(event.key, [event]);
			} else {
				unattributed.push(event);
			}
		}
	}

	const windows: ReportWindow[] = ranges.map((range) => {
		const usage: WindowUsage = aggregate(scoped, range.start, range.end);
		const orphaned: WindowUsage = aggregate(unattributed, range.start, range.end);
		const keyRows: KeyRow[] = [...keyEvents.entries()]
			.map(([key, list]) => {
				const entry: WindowUsage = aggregate(list, range.start, range.end);
				return {
					fingerprint: key,
					label: names[key] ?? key,
					requests: entry.requests,
					tokens: entry.tokens,
					cost: entry.cost,
					models: entry.models,
				};
			})
			.filter((row) => row.tokens > 0 || row.cost > 0)
			.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
		const window = snapshot[range.key];
		return {
			key: range.key,
			label: WINDOW_TITLES[range.key],
			percent: window?.percent,
			status: window?.status,
			resetsAt: window?.resetsAt,
			start: range.start,
			end: range.end,
			total: { requests: usage.requests, tokens: usage.tokens, cost: usage.cost },
			models: usage.models,
			unattributed: orphaned.requests > 0 ? orphaned : undefined,
			keyRows: keyRows.length > 0 ? keyRows : undefined,
		};
	});

	return {
		fetchedAt: snapshot.fetchedAt,
		snapshot,
		fingerprint,
		fingerprintLabel: fingerprint ? names[fingerprint] : undefined,
		windows,
	};
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

type Color = "accent" | "dim" | "muted" | "success" | "warning" | "error";
type Segment = { text: string; color?: Color; bold?: boolean };
type Line = Segment[];

function formatTokens(value: number): string {
	// Thresholds sit just below the unit boundary so a value never rounds up
	// into "1000k" or "1000.0M".
	if (value >= 999_950_000) return `${(value / 1e9).toFixed(1)}B`;
	if (value >= 999_500) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(0)}k`;
	return String(Math.round(value));
}

function formatMoney(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0";
	if (value < 0.01) return "<$0.01";
	return `$${value.toFixed(2)}`;
}

function formatRelative(ms: number): string {
	if (ms <= 0) return "now";
	const totalMinutes = Math.ceil(ms / 60_000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

function formatReset(resetsAt: string | undefined): string {
	if (!resetsAt) return "unknown";
	const time = Date.parse(resetsAt);
	if (!Number.isFinite(time)) return resetsAt;
	const local = new Date(time).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
	const delta = time - Date.now();
	return delta > 0 ? `${local} (in ${formatRelative(delta)})` : local;
}

function percentColor(percent?: number, status?: string): Color {
	if (status && status !== "ok") return "error";
	if ((percent ?? 0) >= 90) return "error";
	if ((percent ?? 0) >= 70) return "warning";
	return "muted";
}

function padEnd(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
	return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function quotaLine(label: string, window: UsageWindow | undefined): Line {
	if (!window) return [{ text: `${label}: no data`, color: "muted" }];
	const percent = typeof window.percent === "number" ? `${Math.round(window.percent)}%` : "?";
	const state = window.status && window.status !== "ok" ? ` [${window.status}]` : "";
	return [
		{ text: `${label}: `, color: "muted" },
		{ text: `${percent}${state}`, color: percentColor(window.percent, window.status) },
		{ text: ` — resets ${formatReset(window.resetsAt)}`, color: "dim" },
	];
}

function shareText(model: ModelUsage, total: UsageTotals): string {
	if (total.cost > 0) {
		if (!model.costKnown) return "?";
		return `${Math.round((model.cost / total.cost) * 100)}%`;
	}
	if (total.tokens > 0) return `~${Math.round((model.tokens / total.tokens) * 100)}%`;
	return "—";
}

function modelRows(models: ModelUsage[], total: UsageTotals, maxModels: number, dimmed: boolean): Line[] {
	const rows: Line[] = [];
	const shown = models.slice(0, maxModels);
	if (shown.length === 0) return rows;

	const nameWidth = Math.min(26, Math.max(14, ...shown.map((model) => model.model.length)));
	for (const model of shown) {
		rows.push([
			{ text: `  ${padEnd(model.model, nameWidth)}  `, color: dimmed ? "dim" : "muted" },
			{
				text: `${padStart(shareText(model, total), 5)}  `,
				color: model.costKnown ? (dimmed ? "dim" : undefined) : "dim",
			},
			{ text: `${padStart(formatMoney(model.cost), 8)}  `, color: "dim" },
			{ text: `${formatTokens(model.tokens)} tok`, color: "dim" },
		]);
	}
	if (models.length > shown.length) {
		rows.push([{ text: `  +${models.length - shown.length} more`, color: "dim" }]);
	}
	return rows;
}

function buildReportLines(report: UsageReport, maxModels: number): Line[] {
	const lines: Line[] = [];

	lines.push([
		{ text: "opencode-go usage", color: "accent", bold: true },
		{ text: `  fetched ${new Date(report.fetchedAt).toLocaleTimeString()}`, color: "dim" },
	]);
	if (report.fingerprint) {
		const label = report.fingerprintLabel
			? `${report.fingerprintLabel} (${report.fingerprint})`
			: report.fingerprint;
		lines.push([{ text: `key: ${label}`, color: "dim" }]);
	}
	lines.push(quotaLine("rolling (5h)", report.snapshot.rolling));
	lines.push(quotaLine("weekly", report.snapshot.weekly));
	lines.push(quotaLine("monthly", report.snapshot.monthly));

	lines.push([]);
	lines.push([
		{ text: "quota % is server-side and includes other machines", color: "dim" },
	]);
	lines.push([
		{ text: "model % is each group's share of locally tracked usage (this machine)", color: "dim" },
	]);

	for (const window of report.windows) {
		// Requests that produced no tokens and no cost (aborted calls) are noise
		// in the model list.
		const models = window.models.filter((model) => model.tokens > 0 || model.cost > 0);
		const quota =
			typeof window.percent === "number" ? `${Math.round(window.percent)}% of limit` : "no quota data";
		const state = window.status && window.status !== "ok" ? ` [${window.status}]` : "";

		lines.push([]);
		lines.push([
			{ text: window.label, color: "accent", bold: true },
			{ text: `  ${quota}${state}`, color: percentColor(window.percent, window.status) },
			{ text: ` · active key (local): ${window.total.requests.toLocaleString()} req · ${formatTokens(window.total.tokens)} tok · ${formatMoney(window.total.cost)} tracked`, color: "dim" },
		]);

		if (models.length > 0) {
			const active = report.fingerprintLabel ?? "unnamed";
			const activeFp = report.fingerprint ? ` (${report.fingerprint})` : "";
			lines.push([{ text: `  ${active}${activeFp} [active]`, color: "muted" }]);
			lines.push(...modelRows(models, window.total, maxModels, false));
		} else {
			lines.push([{ text: "  no tracked usage for this key", color: "dim" }]);
		}

		for (const row of window.keyRows ?? []) {
			lines.push([
				{
					text: `  key ${row.label} (${row.fingerprint}): ${row.requests.toLocaleString()} req · ${formatTokens(row.tokens)} tok · ${formatMoney(row.cost)}`,
					color: "dim",
				},
			]);
			const rowModels = row.models.filter((model) => model.tokens > 0 || model.cost > 0);
			lines.push(...modelRows(rowModels, row, Math.min(maxModels, 3), true));
		}

		if (window.unattributed) {
			const orphan = window.unattributed;
			lines.push([
				{
					text: `  unattributed: ${orphan.requests.toLocaleString()} req · ${formatTokens(orphan.tokens)} tok · ${formatMoney(orphan.cost)} (no matching key)`,
					color: "dim",
				},
			]);
			const orphanModels = orphan.models.filter((model) => model.tokens > 0 || model.cost > 0);
			lines.push(...modelRows(orphanModels, orphan, Math.min(maxModels, 4), true));
		}
	}

	const hasUnattributed = report.windows.some((window) => window.unattributed);
	const hasKeyRows = report.windows.some((window) => window.keyRows);

	if (hasUnattributed || hasKeyRows) {
		lines.push([]);
	}
	if (hasUnattributed) {
		lines.push([
			{ text: "unattributed rows have no recorded key or match no stored/labeled key", color: "dim" },
		]);
	}
	if (hasKeyRows) {
		lines.push([{ text: "key rows are stored or labeled credentials (see /oc-go keys)", color: "dim" }]);
	}

	return lines;
}

function linesToText(lines: Line[]): string {
	return lines.map((line) => line.map((segment) => segment.text).join("")).join("\n");
}

function linesToStyled(lines: Line[], theme: Theme): string {
	return lines
		.map((line) =>
			line
				.map((segment) => {
					let text = segment.text;
					if (segment.color) text = theme.fg(segment.color, text);
					if (segment.bold) text = theme.bold(text);
					return text;
				})
				.join(""),
		)
		.join("\n");
}

// ---------------------------------------------------------------------------
// Footer status
// ---------------------------------------------------------------------------

function statusPiece(theme: Theme, label: string, window: UsageWindow): string {
	const percent = typeof window.percent === "number" ? `${Math.round(window.percent)}%` : "?";
	const state = window.status && window.status !== "ok" ? ` ${window.status}` : "";
	let text = `${label} ${percent}${state}`;

	// Only show reset countdowns when a window is close to its limit, where the
	// reset time actually matters for the next requests.
	const color = percentColor(window.percent, window.status);
	if (color !== "muted" && window.resetsAt) {
		const resetAt = Date.parse(window.resetsAt);
		if (Number.isFinite(resetAt)) text += ` (reset ${formatRelative(resetAt - Date.now())})`;
	}

	return theme.fg(color, text);
}

function statusText(snapshot: UsageSnapshot, theme: Theme, keyLabel?: string): string {
	const pieces: string[] = [];
	if (snapshot.rolling) pieces.push(statusPiece(theme, "5h", snapshot.rolling));
	if (snapshot.weekly) pieces.push(statusPiece(theme, "7d", snapshot.weekly));
	if (snapshot.monthly) pieces.push(statusPiece(theme, "30d", snapshot.monthly));
	const label = keyLabel ? `${STATUS_LABEL} (${keyLabel})` : STATUS_LABEL;
	return `${theme.fg("dim", label)} ${pieces.join(theme.fg("dim", " · "))}`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let lastKeyFp: string | undefined;
	/** Display name of the effective key, shown in the footer. */
	let lastKeyLabel: string | undefined;

	async function refreshStatus(ctx: ExtensionContext, force = false): Promise<void> {
		try {
			const snapshot = await fetchUsage(ctx, force);
			if (!snapshot) {
				lastKeyLabel = undefined;
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			const fingerprint = await currentKeyFingerprint(ctx);
			lastKeyLabel = fingerprint ? ((await readLabels())[fingerprint] ?? fingerprint) : undefined;
			ctx.ui.setStatus(STATUS_KEY, statusText(snapshot, ctx.ui.theme, lastKeyLabel));
		} catch {
			// Keep the last known status on background failures; the report
			// surfaces errors to the user.
		}
	}

	async function recordCurrentKey(ctx: ExtensionContext): Promise<void> {
		const fingerprint = await currentKeyFingerprint(ctx);
		if (!fingerprint || fingerprint === lastKeyFp) return;
		// Claim the fingerprint first so concurrent callers cannot append twice.
		lastKeyFp = fingerprint;
		try {
			pi.appendEntry(KEY_ENTRY, { fp: fingerprint, at: Date.now() });
		} catch {
			if (lastKeyFp === fingerprint) lastKeyFp = undefined;
		}
	}

	function errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	const SHORT_WINDOW_NAMES: Record<(typeof WINDOW_KEYS)[number], string> = {
		rolling: "5h",
		weekly: "7d",
		monthly: "30d",
	};

	async function loadPool(ctx: ExtensionContext): Promise<KeyPool | undefined> {
		try {
			return await readPool();
		} catch (error) {
			ctx.ui.notify(`Failed to read key pool: ${errorMessage(error)}`, "error");
			return undefined;
		}
	}

	async function showPoolKeys(ctx: ExtensionContext): Promise<void> {
		const pool = await loadPool(ctx);
		if (!pool) return;

		const settings = await resolveRequestSettings(ctx);
		const effective = await currentKeyFingerprint(ctx);
		const source = ctx.modelRegistry.getProviderAuthStatus(PROVIDER).source;

		const lines: string[] = [];
		if (pool.keys.length === 0) {
			lines.push("No stored keys. Add the current login with /oc-go add <name>.");
		} else {
			lines.push(`Stored keys (${pool.keys.length}):`);
			const rows = await Promise.all(
				pool.keys.map(async (stored) => {
					const fingerprint = keyFingerprint(stored.key);
					const marker = fingerprint === effective ? "*" : " ";
					let quota = "quota unavailable";
					try {
						const snapshot = await fetchUsageWithCredentials(
							{ ...settings, apiKey: stored.key },
							ctx.signal,
						);
						quota = WINDOW_KEYS.map((key) => {
							const window = snapshot[key];
							const percent = typeof window?.percent === "number" ? `${Math.round(window.percent)}%` : "?";
							const state = window?.status && window.status !== "ok" ? ` [${window.status}]` : "";
							return `${SHORT_WINDOW_NAMES[key]} ${percent}${state}`;
						}).join(" · ");
					} catch (error) {
						quota = `quota error: ${errorMessage(error)}`;
					}
					return `  ${marker} ${stored.name} (${fingerprint}): ${quota}`;
				}),
			);
			lines.push(...rows);
		}

		if (!effective) {
			lines.push("active: no opencode-go credential");
		} else {
			const storedActive = pool.keys.find((stored) => keyFingerprint(stored.key) === effective);
			const origin =
				source === "runtime"
					? "runtime override"
					: source === "stored"
						? "auth.json"
						: (source ?? "unknown source");
			lines.push(
				storedActive
					? `active: ${storedActive.name} (${origin})`
					: `active: ${origin}, fingerprint ${effective} (not stored)`,
			);
		}

		ctx.ui.notify(lines.join("\n"), "info");
	}

	async function addPoolKey(ctx: ExtensionContext, rest: string): Promise<void> {
		const [name, keyArg, ...extra] = rest.split(/\s+/).filter(Boolean);
		if (!name || !isValidKeyName(name) || extra.length > 0) {
			ctx.ui.notify(
				"Usage: /oc-go add <name> [key] — name may use letters, digits, dot, dash, underscore.",
				"warning",
			);
			return;
		}
		const pool = await loadPool(ctx);
		if (!pool) return;
		if (pool.keys.some((stored) => stored.name === name)) {
			ctx.ui.notify(`A key named "${name}" already exists. Remove it first with /oc-go rm ${name}.`, "warning");
			return;
		}

		let key: string | undefined = keyArg;
		if (!key) {
			const current = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
			if (ctx.hasUI) {
				const enter = "Enter a key…";
				const options = current
					? [`Use current effective key (${keyFingerprint(current)})`, enter]
					: [enter];
				const choice = await ctx.ui.select(`Key to store as "${name}"`, options);
				if (choice === undefined) return;
				if (choice === enter) {
					const entered = await ctx.ui.input(`API key for "${name}"`, "sk-…");
					key = entered?.trim() || undefined;
					if (!key) return;
				} else {
					key = current;
				}
			} else {
				key = current;
			}
			if (!key) {
				ctx.ui.notify(
					"No effective opencode-go key to adopt. Run /login first or pass the key: /oc-go add <name> <key>",
					"warning",
				);
				return;
			}
		}

		const fingerprint = keyFingerprint(key);
		const duplicate = pool.keys.find((stored) => keyFingerprint(stored.key) === fingerprint);
		if (duplicate) {
			ctx.ui.notify(`That key is already stored as "${duplicate.name}".`, "warning");
			return;
		}

		pool.keys.push({ name, key });
		try {
			await writePool(pool);
		} catch (error) {
			ctx.ui.notify(`Failed to save key pool: ${errorMessage(error)}`, "error");
			return;
		}
		try {
			await setLabel(fingerprint, name);
		} catch (error) {
			ctx.ui.notify(`Stored "${name}" but failed to save its label: ${errorMessage(error)}`, "warning");
			return;
		}
		ctx.ui.notify(`Added "${name}" (${fingerprint}). Activate it with /oc-go use ${name}.`, "info");
	}

	async function usePoolKey(ctx: ExtensionContext, name: string): Promise<void> {
		if (!name) {
			ctx.ui.notify("Usage: /oc-go use <name>", "warning");
			return;
		}
		const pool = await loadPool(ctx);
		if (!pool) return;
		const stored = pool.keys.find((entry) => entry.name === name);
		if (!stored) {
			ctx.ui.notify(`No stored key named "${name}". See /oc-go keys.`, "warning");
			return;
		}

		// Logging in overwrites the outgoing credential, so park an un-stored
		// outgoing login as "auth" first while that name is free.
		const hadOverride = ctx.modelRegistry.getProviderAuthStatus(PROVIDER).source === "runtime";
		const outgoing = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
		let parked = false;
		let parkedFingerprint: string | undefined;
		let parkedNote = "";
		if (outgoing) {
			const outgoingFp = keyFingerprint(outgoing);
			const outgoingStored = pool.keys.some((entry) => keyFingerprint(entry.key) === outgoingFp);
			if (!outgoingStored) {
				if (pool.keys.some((entry) => entry.name === "auth")) {
					parkedNote = ' Previous login was not saved because "auth" is already a stored key.';
				} else {
					pool.keys.push({ name: "auth", key: outgoing });
					parked = true;
					parkedFingerprint = outgoingFp;
					parkedNote = ' Previous login saved as "auth".';
				}
			}
		}
		if (parked) {
			try {
				await writePool(pool);
			} catch (error) {
				// Do not overwrite a login that could not be parked first.
				ctx.ui.notify(`Failed to save the key pool: ${errorMessage(error)}`, "error");
				return;
			}
			if (parkedFingerprint) {
				try {
					await setLabel(parkedFingerprint, "auth");
				} catch {
					// The label is cosmetic; the parked key matters.
				}
			}
		}

		try {
			// A runtime override (pi --api-key) would shadow the login we are
			// about to write, so drop it first.
			if (hadOverride) await clearRuntimeOverride(ctx);
			await loginKey(ctx, stored.key);
		} catch (error) {
			// A credential synchronization error can leave auth.json holding the
			// new key even though the provider sync failed; keep it and say so.
			if ((await currentKeyFingerprint(ctx)) === keyFingerprint(stored.key)) {
				await recordCurrentKey(ctx);
				void refreshStatus(ctx, true);
				ctx.ui.notify(
					`Switched to "${name}" (${keyFingerprint(stored.key)}), but syncing provider state failed: ${errorMessage(error)}`,
					"warning",
				);
				return;
			}
			// Put an external override back so a failed switch leaves the
			// effective credential untouched.
			if (hadOverride && outgoing) {
				try {
					await setRuntimeOverride(ctx, outgoing);
				} catch {
					// The error below reports the failure either way.
				}
			}
			ctx.ui.notify(`Failed to activate "${name}": ${errorMessage(error)}`, "error");
			return;
		}

		await recordCurrentKey(ctx);
		void refreshStatus(ctx, true);
		ctx.ui.notify(`Using stored key "${name}" (${keyFingerprint(stored.key)}).${parkedNote}`, "info");
	}

	async function removePoolKey(ctx: ExtensionContext, name: string): Promise<void> {
		if (!name) {
			ctx.ui.notify("Usage: /oc-go rm <name>", "warning");
			return;
		}
		const pool = await loadPool(ctx);
		if (!pool) return;
		const index = pool.keys.findIndex((entry) => entry.name === name);
		if (index < 0) {
			ctx.ui.notify(`No stored key named "${name}".`, "warning");
			return;
		}

		const [removed] = pool.keys.splice(index, 1);
		try {
			await writePool(pool);
		} catch (error) {
			ctx.ui.notify(`Failed to save key pool: ${errorMessage(error)}`, "error");
			return;
		}
		const stillEffective = (await currentKeyFingerprint(ctx)) === keyFingerprint(removed.key);
		ctx.ui.notify(
			`Removed "${name}" (${keyFingerprint(removed.key)})${
				stillEffective ? "; it stays the effective login until /oc-go use or /login changes it" : ""
			}.`,
			"info",
		);
	}

	async function labelActiveKey(ctx: ExtensionContext, label: string): Promise<void> {
		const fingerprint = await currentKeyFingerprint(ctx);
		if (!fingerprint) {
			ctx.ui.notify("No opencode-go credentials found. Run /login to add them.", "warning");
			return;
		}
		try {
			await setLabel(fingerprint, label || undefined);
			ctx.ui.notify(
				label ? `Labeled key ${fingerprint} as "${label}".` : `Cleared label for key ${fingerprint}.`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(`Failed to save label: ${errorMessage(error)}`, "error");
		}
	}

	async function showReport(ctx: ExtensionContext): Promise<void> {
		try {
			const report = await buildReport(ctx, true, ctx.signal);
			if (!report) {
				ctx.ui.notify("No opencode-go credentials found. Run /login to add them.", "warning");
				return;
			}
			lastKeyLabel = report.fingerprintLabel ?? report.fingerprint;
			ctx.ui.setStatus(STATUS_KEY, statusText(report.snapshot, ctx.ui.theme, lastKeyLabel));
			pi.appendEntry(ENTRY_TYPE, report);
			// The TUI renders the appended entry as a card; other modes have no
			// entry view, so they get the text as a notification instead.
			if (ctx.mode !== "tui") {
				ctx.ui.notify(linesToText(buildReportLines(report, 3)), "info");
			}
		} catch (error) {
			ctx.ui.notify(`Failed to read opencode-go usage: ${errorMessage(error)}`, "error");
		}
	}

	type PoolAction = (ctx: ExtensionContext, rest: string) => Promise<void>;

	pi.registerCommand("oc-go", {
		description: "Show opencode-go quota and local usage, and manage stored keys",
		getArgumentCompletions: ocGoArgumentCompletions,
		handler: async (args, ctx) => {
			const command = args.trim();
			const verb = command.split(/\s+/, 1)[0] ?? "";
			const rest = command.slice(verb.length).trim();
			if (verb === "" || verb === "usage" || verb === "status") {
				await showReport(ctx);
				return;
			}
			const actions: Record<string, PoolAction> = {
				keys: (target) => showPoolKeys(target),
				add: (target, argument) => addPoolKey(target, argument),
				use: (target, argument) => usePoolKey(target, argument),
				rm: (target, argument) => removePoolKey(target, argument),
				label: (target, argument) => labelActiveKey(target, argument),
			};
			const action = actions[verb];
			if (action) {
				await action(ctx, rest);
				return;
			}
			ctx.ui.notify(
				OC_GO_COMMANDS.map((entry) => `${entry.usage} — ${entry.description}`).join("\n"),
				"info",
			);
		},
	});

	pi.registerTool({
		name: "opencode_usage",
		label: "OpenCode Go Usage",
		description:
			"Check the current opencode-go subscription quota (rolling 5-hour, weekly, and monthly windows with percentages and reset times) plus a per-model breakdown of locally tracked usage for each window. The breakdown covers this machine only; usage from other machines is not included, stored or labeled keys appear as separate key blocks, and usage that matches no stored or labeled key appears as an unattributed block. Use when the user asks how much of their opencode-go plan has been used, which models consumed it, or whether they are close to a limit.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const report = await buildReport(ctx, true, signal);
			if (!report) {
				return {
					content: [{ type: "text", text: "No opencode-go credentials are configured." }],
					details: {},
				};
			}
			return {
				content: [{ type: "text", text: linesToText(buildReportLines(report, 10)) }],
				details: { report },
			};
		},
	});

	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as UsageReport | UsageSnapshot | undefined;
		if (data && Array.isArray((data as UsageReport).windows)) {
			return new Text(linesToStyled(buildReportLines(data as UsageReport, 6), theme), 1, 0);
		}

		// Legacy entries from the first version stored only the quota snapshot.
		const legacy = data as UsageSnapshot | undefined;
		const lines: Line[] = [
			[
				{ text: "opencode-go usage", color: "accent", bold: true },
				{ text: `  fetched ${legacy?.fetchedAt ? new Date(legacy.fetchedAt).toLocaleTimeString() : "unknown"}`, color: "dim" },
			],
			quotaLine("rolling (5h)", legacy?.rolling),
			quotaLine("weekly", legacy?.weekly),
			quotaLine("monthly", legacy?.monthly),
		];
		return new Text(linesToStyled(lines, theme), 1, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		// A new session starts a fresh attribution history, so its first key
		// entry is appended even when the key is unchanged.
		lastKeyFp = undefined;
		await recordCurrentKey(ctx);
		void refreshStatus(ctx, true);
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => {
			void refreshStatus(ctx);
		}, REFRESH_INTERVAL_MS);
	});

	pi.on("agent_start", async (_event, ctx) => {
		// Record which key this turn will use so local usage stays attributable
		// even when keys are switched between turns or sessions.
		await recordCurrentKey(ctx);
	});

	pi.on("session_shutdown", () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		void refreshStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		// refreshStatus re-renders with the current theme and clears the footer
		// when the credential is gone, so no stale snapshot can be redrawn.
		void refreshStatus(ctx);
	});
}
