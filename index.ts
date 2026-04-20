/**
 * pi-usage — Usage limit checker for pi coding agent
 *
 * Checks Codex (5hr & weekly) and OpenCode Go usage limits at startup
 * and displays a clean summary widget above the editor.
 *
 * Also provides `/usage` command to refresh on demand.
 *
 * Setup:
 *   Codex:        Uses OAuth token from pi's auth.json (same as openai-codex provider)
 *   OpenCode Go:  Uses OPENCODE_API_KEY env var
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

// ───────── Types ─────────

interface CodexUsage {
	planType: string;
	activeLimit: string;
	primaryUsedPercent: number;      // 5hr window
	secondaryUsedPercent: number;    // weekly window
	primaryWindowMinutes: number;
	secondaryWindowMinutes: number;
	primaryResetAfterSeconds: number;
	secondaryResetAfterSeconds: number;
	primaryResetAt: number;          // unix timestamp seconds
	secondaryResetAt: number;
	primaryOverSecondaryLimitPercent: number;
	creditsHasCredits: boolean;
	creditsBalance: string;
	creditsUnlimited: boolean;
	error?: string;
}

type GoModelStatus = "available" | "rate_limited" | "credits_error" | "error" | "no_key";

interface OpenCodeGoUsage {
	available: boolean;
	status: GoModelStatus;
	workingModel?: string;
	rateLimitedModel?: string;
	errorMessage?: string;
	error?: string;
}

// ───────── Config ─────────

const WIDGET_ID = "pi-usage";
const CHECK_TIMEOUT_MS = 15_000;
const AUTO_REFRESH_MINUTES = 30;

// ───────── Helpers ─────────

function authJsonPath(): string {
	return path.join(os.homedir(), ".pi/agent/auth.json");
}

function extractAccountId(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
	} catch {
		return undefined;
	}
}

function getCodexToken(): { token: string; accountId: string } | undefined {
	try {
		const authPath = authJsonPath();
		if (!fs.existsSync(authPath)) return undefined;
		const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
		const codex = auth["openai-codex"];
		if (!codex?.access) return undefined;
		const accountId = extractAccountId(codex.access);
		if (!accountId) return undefined;
		return { token: codex.access, accountId };
	} catch {
		return undefined;
	}
}

function getOpenCodeApiKey(): string | undefined {
	return process.env.OPENCODE_API_KEY;
}

function formatDuration(seconds: number): string {
	if (seconds <= 0) return "now";
	if (seconds < 60) return `${Math.round(seconds)}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.round(seconds / 3600 * 10) / 10}h`;
	return `${Math.round(seconds / 86400 * 10) / 10}d`;
}

function formatResetTime(unixTsSec: number): string {
	const diff = unixTsSec * 1000 - Date.now();
	if (diff <= 0) return "now";
	return formatDuration(diff / 1000);
}

function progressBar(percent: number, width: number = 20): string {
	const filled = Math.round((Math.min(percent, 100) / 100) * width);
	const empty = width - filled;
	return "█".repeat(filled) + "░".repeat(empty);
}

function usageColor(percent: number): string {
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

function statusIcon(status: GoModelStatus): string {
	switch (status) {
		case "available": return "✓";
		case "rate_limited": return "⏳";
		case "credits_error": return "✗";
		case "error": return "⚠";
		case "no_key": return "—";
	}
}

// ───────── Codex Usage Check ─────────

async function checkCodexUsage(token: string, accountId: string): Promise<CodexUsage> {
	const baseUrl = "https://chatgpt.com/backend-api/codex/responses";

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

		const response = await fetch(baseUrl, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${token}`,
				"chatgpt-account-id": accountId,
				"Content-Type": "application/json",
				"OpenAI-Beta": "responses=experimental",
				"accept": "text/event-stream",
				"originator": "pi-usage",
				"User-Agent": `pi-usage (${os.platform()} ${os.release()}; ${os.arch()})`,
			},
			body: JSON.stringify({
				model: "gpt-5.4-mini",
				instructions: "Reply with just: ok",
				input: [{ type: "message", role: "user", content: "hi" }],
				store: false,
				stream: true,
			}),
			signal: controller.signal,
		});

		clearTimeout(timeout);

		const getHeader = (name: string): string | undefined =>
			response.headers.get(name) ?? undefined;

		if (response.ok) {
			// Consume the body to complete the stream
			try {
				const reader = response.body?.getReader();
				if (reader) {
					while (true) {
						const { done } = await reader.read();
						if (done) break;
					}
					reader.releaseLock();
				}
			} catch { /* stream already ended or aborted */ }

			return {
				planType: getHeader("x-codex-plan-type") ?? "unknown",
				activeLimit: getHeader("x-codex-active-limit") ?? "unknown",
				primaryUsedPercent: parseFloat(getHeader("x-codex-primary-used-percent") ?? "0"),
				secondaryUsedPercent: parseFloat(getHeader("x-codex-secondary-used-percent") ?? "0"),
				primaryWindowMinutes: parseInt(getHeader("x-codex-primary-window-minutes") ?? "300", 10),
				secondaryWindowMinutes: parseInt(getHeader("x-codex-secondary-window-minutes") ?? "10080", 10),
				primaryResetAfterSeconds: parseInt(getHeader("x-codex-primary-reset-after-seconds") ?? "0", 10),
				secondaryResetAfterSeconds: parseInt(getHeader("x-codex-secondary-reset-after-seconds") ?? "0", 10),
				primaryResetAt: parseInt(getHeader("x-codex-primary-reset-at") ?? "0", 10),
				secondaryResetAt: parseInt(getHeader("x-codex-secondary-reset-at") ?? "0", 10),
				primaryOverSecondaryLimitPercent: parseFloat(getHeader("x-codex-primary-over-secondary-limit-percent") ?? "0"),
				creditsHasCredits: getHeader("x-codex-credits-has-credits") === "True",
				creditsBalance: getHeader("x-codex-credits-balance") ?? "",
				creditsUnlimited: getHeader("x-codex-credits-unlimited") === "True",
			};
		}

		// 429 = rate limited
		if (response.status === 429) {
			let resetAt = 0;
			try {
				const body = await response.text();
				const parsed = JSON.parse(body);
				resetAt = parsed?.error?.resets_at ?? 0;
			} catch { /* ignore */ }

			return {
				planType: "unknown",
				activeLimit: "rate_limited",
				primaryUsedPercent: 100,
				secondaryUsedPercent: 100,
				primaryWindowMinutes: 300,
				secondaryWindowMinutes: 10080,
				primaryResetAfterSeconds: resetAt ? Math.max(0, Math.round(resetAt - Date.now() / 1000)) : 0,
				secondaryResetAfterSeconds: 0,
				primaryResetAt: resetAt,
				secondaryResetAt: 0,
				primaryOverSecondaryLimitPercent: 0,
				creditsHasCredits: false,
				creditsBalance: "",
				creditsUnlimited: false,
				error: "Rate limited (429)",
			};
		}

		// Other errors
		let errorMsg = `HTTP ${response.status}`;
		try {
			const body = await response.text();
			const parsed = JSON.parse(body);
			errorMsg = parsed?.error?.message ?? parsed?.detail ?? errorMsg;
		} catch { /* ignore */ }

		return {
			planType: "unknown",
			activeLimit: "error",
			primaryUsedPercent: 0,
			secondaryUsedPercent: 0,
			primaryWindowMinutes: 300,
			secondaryWindowMinutes: 10080,
			primaryResetAfterSeconds: 0,
			secondaryResetAfterSeconds: 0,
			primaryResetAt: 0,
			secondaryResetAt: 0,
			primaryOverSecondaryLimitPercent: 0,
			creditsHasCredits: false,
			creditsBalance: "",
			creditsUnlimited: false,
			error: errorMsg,
		};
	} catch (e: unknown) {
		return {
			planType: "unknown",
			activeLimit: "error",
			primaryUsedPercent: 0,
			secondaryUsedPercent: 0,
			primaryWindowMinutes: 300,
			secondaryWindowMinutes: 10080,
			primaryResetAfterSeconds: 0,
			secondaryResetAfterSeconds: 0,
			primaryResetAt: 0,
			secondaryResetAt: 0,
			primaryOverSecondaryLimitPercent: 0,
			creditsHasCredits: false,
			creditsBalance: "",
			creditsUnlimited: false,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

// ───────── OpenCode Go Usage Check ─────────

const GO_CHECK_MODELS = ["glm-5.1", "kimi-k2.5", "qwen3.5-plus"];

async function checkOpenCodeGoUsage(apiKey: string): Promise<OpenCodeGoUsage> {
	try {
		for (const model of GO_CHECK_MODELS) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

			const response = await fetch("https://opencode.ai/zen/go/v1/chat/completions", {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					messages: [{ role: "user", content: "hi" }],
					max_tokens: 1,
				}),
				signal: controller.signal,
			});

			clearTimeout(timeout);

			if (response.ok) {
				try { await response.text(); } catch { /* ignore */ }
				return { available: true, status: "available", workingModel: model };
			}

			if (response.status === 429) {
				let errorMsg = "Rate limited";
				try {
					const body = await response.text();
					const parsed = JSON.parse(body);
					errorMsg = parsed?.error?.message ?? errorMsg;
				} catch { /* ignore */ }

				// If it's a global quota error, no point trying other models
				if (errorMsg.includes("Insufficient") || errorMsg.includes("quota")) {
					return {
						available: false,
						status: "rate_limited",
						rateLimitedModel: model,
						errorMessage: errorMsg,
					};
				}
				// Otherwise try next model
				continue;
			}

			if (response.status === 401 || response.status === 403) {
				let errorMsg = "Authentication error";
				try {
					const body = await response.text();
					const parsed = JSON.parse(body);
					if (parsed?.error?.type === "CreditsError" || parsed?.type === "error") {
						const msg = parsed?.error?.message ?? parsed?.error?.error?.message;
						return {
							available: false,
							status: "credits_error",
							errorMessage: msg ?? "Credits exhausted",
						};
					}
					errorMsg = parsed?.error?.message ?? errorMsg;
				} catch { /* ignore */ }

				return { available: false, status: "error", errorMessage: errorMsg };
			}

			// Other error
			let errorMsg = `HTTP ${response.status}`;
			try {
				const body = await response.text();
				const parsed = JSON.parse(body);
				errorMsg = parsed?.error?.message ?? errorMsg;
			} catch { /* ignore */ }

			return { available: false, status: "error", errorMessage: errorMsg };
		}

		// All models rate limited
		return {
			available: false,
			status: "rate_limited",
			errorMessage: "All Go models rate limited",
		};
	} catch (e: unknown) {
		return {
			available: false,
			status: "error",
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

// ───────── Widget Rendering ─────────

function buildUsageWidget(
	codex: CodexUsage | undefined,
	go: OpenCodeGoUsage | undefined,
	theme: any,
	loading: boolean,
): Text {
	if (loading) {
		return new Text(theme.fg("muted", "⚡ Checking usage limits..."), 0, 0);
	}

	const lines: string[] = [];
	const sep = "─";

	// Header
	lines.push(theme.bold(theme.fg("accent", "⚡ Usage Limits")));

	// ── Codex ──
	if (codex) {
		if (codex.error && codex.activeLimit === "error") {
			lines.push(theme.fg("dim", sep.repeat(40)));
			lines.push(`${theme.fg("error", "✗ Codex")} ${theme.fg("dim", "— " + codex.error)}`);
		} else {
			const planLabel = codex.planType !== "unknown" ? ` (${codex.planType})` : "";
			const limitLabel = codex.activeLimit !== "unknown" ? ` [${codex.activeLimit}]` : "";

			// 5hr window
			const p5 = codex.primaryUsedPercent;
			const p5Color = usageColor(p5);
			const p5Bar = progressBar(p5);
			const p5Window = codex.primaryWindowMinutes === 300 ? "5hr" : `${codex.primaryWindowMinutes / 60}h`;
			const p5Reset = codex.primaryResetAt > 0
				? ` resets ${formatResetTime(codex.primaryResetAt)}`
				: codex.primaryResetAfterSeconds > 0
					? ` resets in ${formatDuration(codex.primaryResetAfterSeconds)}`
					: "";

			// Weekly window
			const pW = codex.secondaryUsedPercent;
			const pWColor = usageColor(pW);
			const pWBar = progressBar(pW);
			const pWReset = codex.secondaryResetAt > 0
				? ` resets ${formatResetTime(codex.secondaryResetAt)}`
				: codex.secondaryResetAfterSeconds > 0
					? ` resets in ${formatDuration(codex.secondaryResetAfterSeconds)}`
					: "";

			lines.push(theme.fg("dim", sep.repeat(40)));
			lines.push(`${theme.fg("accent", "Codex")}${theme.fg("dim", planLabel + limitLabel)}`);
			lines.push(
				`  ${p5Window}  ${theme.fg(p5Color, p5Bar)} ${theme.fg(p5Color, `${p5.toFixed(0)}%`)}${theme.fg("dim", p5Reset)}`,
			);
			lines.push(
				`  week  ${theme.fg(pWColor, pWBar)} ${theme.fg(pWColor, `${pW.toFixed(0)}%`)}${theme.fg("dim", pWReset)}`,
			);

			// Credits info
			if (codex.creditsHasCredits && codex.creditsBalance) {
				lines.push(`  ${theme.fg("dim", `credits: ${codex.creditsBalance}`)}`);
			}
			if (codex.primaryOverSecondaryLimitPercent > 0) {
				lines.push(`  ${theme.fg("warning", `⚠ 5hr exceeds weekly allocation: ${codex.primaryOverSecondaryLimitPercent}%`)}`);
			}
		}
	} else {
		lines.push(theme.fg("dim", sep.repeat(40)));
		lines.push(theme.fg("dim", "Codex — not configured"));
	}

	// ── OpenCode Go ──
	if (go) {
		lines.push(theme.fg("dim", sep.repeat(40)));
		const icon = statusIcon(go.status);
		const goColorMap: Record<GoModelStatus, string> = {
			available: "success",
			rate_limited: "warning",
			credits_error: "error",
			error: "warning",
			no_key: "dim",
		};
		const goColor = goColorMap[go.status];
		const statusText: Record<GoModelStatus, string> = {
			available: "available",
			rate_limited: "rate limited",
			credits_error: "credits exhausted",
			error: "error",
			no_key: "no key",
		};
		lines.push(`${theme.fg(goColor, `${icon} OpenCode Go`)} ${theme.fg("dim", "— " + statusText[go.status])}`);
		if (go.workingModel) {
			lines.push(`  ${theme.fg("dim", `working: ${go.workingModel}`)}`);
		}
		if (go.rateLimitedModel) {
			lines.push(`  ${theme.fg("warning", `limited: ${go.rateLimitedModel}`)}`);
		}
		if (go.errorMessage) {
			lines.push(`  ${theme.fg("dim", go.errorMessage.substring(0, 80))}`);
		}
		if (go.error) {
			lines.push(`  ${theme.fg("dim", go.error.substring(0, 80))}`);
		}
	} else {
		lines.push(theme.fg("dim", sep.repeat(40)));
		lines.push(theme.fg("dim", "OpenCode Go — not configured"));
	}

	return new Text(lines.join("\n"), 0, 0);
}

// ───────── Status Line ─────────

function updateFooterStatus(ctx: any, codex: CodexUsage | undefined, go: OpenCodeGoUsage | undefined): void {
	if (!ctx.hasUI) return;

	const parts: string[] = [];
	if (codexUsageHasData(codex)) {
		parts.push(`Codex:${codex!.primaryUsedPercent.toFixed(0)}%/${codex!.secondaryUsedPercent.toFixed(0)}%`);
	}
	if (go) {
		parts.push(`Go:${go.available ? "✓" : "⏳"}`);
	}
	if (parts.length > 0) {
		ctx.ui.setStatus("pi-usage", `⚡ ${parts.join(" │ ")}`);
	} else {
		ctx.ui.setStatus("pi-usage", undefined);
	}
}

function codexUsageHasData(codex: CodexUsage | undefined): codex is CodexUsage & { error: undefined } {
	return codex !== undefined && codex.error === undefined && codex.activeLimit !== "error";
}

// ───────── Extension ─────────

export default function (pi: ExtensionAPI) {
	let codexUsage: CodexUsage | undefined;
	let goUsage: OpenCodeGoUsage | undefined;
	let isLoading = false;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let currentCtx: any;

	async function refreshUsage(ctx: any): Promise<void> {
		if (isLoading) return;
		isLoading = true;
		currentCtx = ctx;

		// Show loading state
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_ID, (_tui: any, theme: any) =>
				buildUsageWidget(codexUsage, goUsage, theme, true),
			);
		}

		const checks: Promise<void>[] = [];

		// Check Codex
		const codexAuth = getCodexToken();
		if (codexAuth) {
			checks.push(
				checkCodexUsage(codexAuth.token, codexAuth.accountId).then((result) => {
					codexUsage = result;
				}),
			);
		}

		// Check OpenCode Go
		const goKey = getOpenCodeApiKey();
		if (goKey) {
			checks.push(
				checkOpenCodeGoUsage(goKey).then((result) => {
					goUsage = result;
				}),
			);
		}

		// Run checks in parallel
		await Promise.allSettled(checks);

		isLoading = false;

		// Update widget with results
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_ID, (_tui: any, theme: any) =>
				buildUsageWidget(codexUsage, goUsage, theme, false),
			);

			// Footer status
			updateFooterStatus(ctx, codexUsage, goUsage);

			// Quick notification
			const parts: string[] = [];
			if (codexUsageHasData(codexUsage)) {
				parts.push(`Codex 5hr:${codexUsage!.primaryUsedPercent.toFixed(0)}% week:${codexUsage!.secondaryUsedPercent.toFixed(0)}%`);
			} else if (codexUsage?.error) {
				parts.push(`Codex: ✗ ${codexUsage.error.substring(0, 30)}`);
			}
			if (goUsage) {
				parts.push(`Go: ${goUsage.available ? "✓" : "⏳"}`);
			}
			if (parts.length > 0) {
				ctx.ui.notify(`⚡ ${parts.join(" │ ")}`, "info");
			}
		}
	}

	// ── Startup check ──
	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup" || event.reason === "reload") {
			// Small delay to let TUI settle
			setTimeout(() => refreshUsage(ctx), 500);
		}
	});

	// ── Auto-refresh ──
	pi.on("session_start", async (_event, ctx) => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => {
			if (currentCtx) refreshUsage(currentCtx).catch(() => {});
		}, AUTO_REFRESH_MINUTES * 60 * 1000);
	});

	pi.on("session_shutdown", async () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
	});

	// ── /usage command ──
	pi.registerCommand("usage", {
		description: "Refresh and show Codex & OpenCode Go usage limits",
		handler: async (_args, ctx) => {
			await refreshUsage(ctx);
		},
	});
}
