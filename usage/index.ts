/**
 * OpenCode Go usage tracker for pi.
 *
 * - Footer status: rolling (5h), weekly, and monthly quota percentages,
 *   colored when getting close to a limit.
 * - `/usage`: quota snapshot plus a per-model breakdown of each quota window
 *   (reconstructed from local pi sessions and the OpenCode client database).
 * - `opencode_usage` tool: lets the model check quota and breakdown when asked.
 *
 * Quota comes from `<baseUrl>/usage` and is already scoped to the active API
 * key. The per-model breakdown is local-only and is attributed to keys using
 * session entries, so switching keys does not mix usage.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { currentKeyFingerprint, fingerprintFromEntries, KEY_ENTRY, readLabels, setLabel } from "./keys.ts";
import { aggregate, collectEvents, type ModelUsage, type UsageEvent, type WindowUsage } from "./local-usage.ts";
import {
	fetchUsage,
	getCachedSnapshot,
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
	/** Local usage with no key recorded (predates key tracking). */
	unattributed?: WindowUsage;
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
// Report building
// ---------------------------------------------------------------------------

async function buildReport(ctx: ExtensionContext, force: boolean): Promise<UsageReport | undefined> {
	const snapshot = await fetchUsage(ctx, force);
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

	// Usage attributed to the active key is the primary list. Requests recorded
	// before key tracking existed carry no key and are reported separately;
	// requests attributed to other keys are not this key's usage.
	const scoped = fingerprint ? events.filter((event) => event.key === fingerprint) : [];
	const unattributed = events.filter((event) => event.key === undefined);
	const labels = await readLabels();

	const windows: ReportWindow[] = ranges.map((range) => {
		const usage: WindowUsage = aggregate(scoped, range.start, range.end);
		const orphaned: WindowUsage = aggregate(unattributed, range.start, range.end);
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
		};
	});

	return {
		fetchedAt: snapshot.fetchedAt,
		snapshot,
		fingerprint,
		fingerprintLabel: fingerprint ? labels[fingerprint] : undefined,
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
	if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
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

function shareText(model: ModelUsage, total: WindowUsage): string {
	if (total.cost > 0) {
		if (!model.costKnown) return "?";
		return `${Math.round((model.cost / total.cost) * 100)}%`;
	}
	if (total.tokens > 0) return `~${Math.round((model.tokens / total.tokens) * 100)}%`;
	return "—";
}

function modelRows(models: ModelUsage[], total: WindowUsage, maxModels: number, dimmed: boolean): Line[] {
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

	for (const window of report.windows) {
		// Requests that produced no tokens and no cost (aborted calls) are noise
		// in the model list.
		const models = window.models
			.filter((model) => model.tokens > 0 || model.cost > 0)
			.slice(0, maxModels);
		const quota =
			typeof window.percent === "number" ? `${Math.round(window.percent)}% of limit` : "no quota data";
		const state = window.status && window.status !== "ok" ? ` [${window.status}]` : "";

		lines.push([]);
		lines.push([
			{ text: window.label, color: "accent", bold: true },
			{ text: `  ${quota}${state}`, color: percentColor(window.percent, window.status) },
			{ text: ` · ${window.total.requests.toLocaleString()} req · ${formatTokens(window.total.tokens)} tok · ${formatMoney(window.total.cost)} tracked`, color: "dim" },
		]);

		if (models.length > 0) {
			lines.push(...modelRows(models, window.total, maxModels, false));
		} else if (window.total.requests === 0) {
			lines.push([
				{ text: window.unattributed ? "  no tracked usage for this key" : "  no tracked usage", color: "dim" },
			]);
		}

		if (window.unattributed) {
			const orphan = window.unattributed;
			lines.push([
				{
					text: `  unattributed: ${orphan.requests.toLocaleString()} req · ${formatTokens(orphan.tokens)} tok · ${formatMoney(orphan.cost)} (no key recorded)`,
					color: "dim",
				},
			]);
			const orphanModels = orphan.models.filter((model) => model.tokens > 0 || model.cost > 0);
			lines.push(...modelRows(orphanModels, orphan, Math.min(maxModels, 4), true));
		}
	}

	const hasUnattributed = report.windows.some((window) => window.unattributed);

	lines.push([]);
	lines.push([
		{ text: "shares of locally tracked usage · other machines not included", color: "dim" },
	]);
	if (hasUnattributed) {
		lines.push([{ text: "unattributed rows were recorded before key tracking", color: "dim" }]);
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

function statusText(snapshot: UsageSnapshot, theme: Theme): string {
	const pieces: string[] = [];
	if (snapshot.rolling) pieces.push(statusPiece(theme, "5h", snapshot.rolling));
	if (snapshot.weekly) pieces.push(statusPiece(theme, "7d", snapshot.weekly));
	if (snapshot.monthly) pieces.push(statusPiece(theme, "30d", snapshot.monthly));
	return theme.fg("dim", `${STATUS_LABEL} `) + pieces.join(theme.fg("dim", " · "));
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let lastKeyFp: string | undefined;

	async function refreshStatus(ctx: ExtensionContext, force = false): Promise<void> {
		try {
			const snapshot = await fetchUsage(ctx, force);
			if (!snapshot) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			ctx.ui.setStatus(STATUS_KEY, statusText(snapshot, ctx.ui.theme));
		} catch {
			// Keep the last known status on background failures. The explicit
			// /usage command reports errors to the user.
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

	pi.registerCommand("usage", {
		description: "Show opencode-go quota and per-model usage breakdown (/usage label <name> names the active key)",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command === "label" || command.startsWith("label ")) {
				const label = command.slice("label".length).trim();
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
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to save label: ${message}`, "error");
				}
				return;
			}

			try {
				const report = await buildReport(ctx, true);
				if (!report) {
					ctx.ui.notify("No opencode-go credentials found. Run /login to add them.", "warning");
					return;
				}
				ctx.ui.setStatus(STATUS_KEY, statusText(report.snapshot, ctx.ui.theme));
				pi.appendEntry(ENTRY_TYPE, report);
				// The TUI renders the appended entry as a card; other modes have no
				// entry view, so they get the text as a notification instead.
				if (ctx.mode !== "tui") {
					ctx.ui.notify(linesToText(buildReportLines(report, 3)), "info");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to read opencode-go usage: ${message}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "opencode_usage",
		label: "OpenCode Go Usage",
		description:
			"Check the current opencode-go subscription quota (rolling 5-hour, weekly, and monthly windows with percentages and reset times) plus a per-model breakdown of locally tracked usage for each window. The breakdown covers the active API key on this machine only; usage from other machines is not included, and older local usage recorded before key tracking appears as a separate unattributed block. Use when the user asks how much of their opencode-go plan has been used, which models consumed it, or whether they are close to a limit.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const report = await buildReport(ctx, true);
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

	pi.on("session_start", (_event, ctx) => {
		lastKeyFp = fingerprintFromEntries(ctx.sessionManager.getEntries());
		void recordCurrentKey(ctx);
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

	pi.on("agent_end", (_event, ctx) => {
		void refreshStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		// Re-render with the current theme, then refresh if it has been a while.
		const snapshot = getCachedSnapshot();
		if (snapshot) ctx.ui.setStatus(STATUS_KEY, statusText(snapshot, ctx.ui.theme));
		void refreshStatus(ctx);
	});
}
