/**
 * API key attribution helpers.
 *
 * opencode-go quota is tracked per credential, but local usage records do not
 * contain the key that was used. A short SHA-256 fingerprint of the active key
 * is stored in session entries (`opencode-go-key`) so local usage can be
 * attributed to a key without persisting the secret itself.
 *
 * Run `/usage label <name>` to name the key that is currently active; labels
 * are kept in `opencode-go-usage-labels.json` inside the pi agent directory.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PROVIDER } from "./opencode-go.ts";

export const KEY_ENTRY = "opencode-go-key";

const LABELS_FILE = join(getAgentDir(), "opencode-go-usage-labels.json");

export function keyFingerprint(key: string): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export async function currentKeyFingerprint(ctx: ExtensionContext): Promise<string | undefined> {
	try {
		const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER);
		const key = auth?.auth?.apiKey;
		return key ? keyFingerprint(key) : undefined;
	} catch {
		return undefined;
	}
}

export function fingerprintFromEntries(entries: readonly unknown[]): string | undefined {
	let fingerprint: string | undefined;
	for (const raw of entries) {
		const entry = raw as { type?: string; customType?: string; data?: { fp?: unknown } };
		if (entry?.type === "custom" && entry.customType === KEY_ENTRY && typeof entry.data?.fp === "string") {
			fingerprint = entry.data.fp;
		}
	}
	return fingerprint;
}

export async function readLabels(): Promise<Record<string, string>> {
	try {
		const parsed = JSON.parse(await readFile(LABELS_FILE, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, string>;
		}
	} catch {
		// missing or invalid file
	}
	return {};
}

export async function setLabel(fingerprint: string, label: string | undefined): Promise<void> {
	const labels = await readLabels();
	if (label) labels[fingerprint] = label;
	else delete labels[fingerprint];
	await writeFile(LABELS_FILE, `${JSON.stringify(labels, null, 2)}\n`, "utf8");
}
