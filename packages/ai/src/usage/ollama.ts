import { ProviderHttpError } from "../error";
import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport } from "../usage";
import { isRecord } from "../utils";
import { HOUR_MS, usageStatus, WEEK_MS } from "./shared";

const OLLAMA_PROVIDER = "ollama";
const OLLAMA_CLOUD_PROVIDER = "ollama-cloud";

/**
 * Ollama Cloud account usage endpoint. Returns per-window fractional usage
 * (`limits.session.usage` / `limits.weekly.usage`, 0..1) plus rolling-day
 * activity metadata; authenticated with the same API key used for inference.
 * Reset timestamps are not part of the payload — the pricing page documents
 * the cadence (5-hour session / 7-day weekly) but not the phase.
 */
const OLLAMA_CLOUD_USAGE_URL = "https://ollama.com/api/usage";

/**
 * Parse one `limits.*` window. `usage` values are fractions (0..1) of the
 * window quota — a 4.6% used session arrives as 0.046.
 */
function parseWindowLimit(
	raw: unknown,
	provider: UsageFetchParams["provider"],
	window: { id: "session" | "weekly"; windowId: "5h" | "7d"; label: string; durationMs: number },
): UsageLimit | null {
	if (!isRecord(raw)) return null;
	const usedFraction = raw.usage;
	if (typeof usedFraction !== "number" || !Number.isFinite(usedFraction) || usedFraction < 0) return null;
	return {
		id: `ollama-cloud:${window.id}`,
		label: `Ollama Cloud ${window.label}`,
		scope: { provider, windowId: window.windowId, shared: true },
		window: { id: window.windowId, label: window.label, durationMs: window.durationMs },
		amount: {
			unit: "percent",
			used: Math.round(usedFraction * 10_000) / 100,
			usedFraction,
			remainingFraction: Math.max(1 - usedFraction, 0),
		},
		status: usageStatus(usedFraction),
	};
}

async function fetchOllamaLocalUsage(params: UsageFetchParams, _ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== OLLAMA_PROVIDER) {
		return null;
	}

	const metadata: Record<string, unknown> = {};
	if (params.credential.email) metadata.email = params.credential.email;
	if (params.credential.accountId) metadata.accountId = params.credential.accountId;
	if (params.credential.projectId) metadata.projectId = params.credential.projectId;

	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits: [],
		notes: ["Self-hosted Ollama has no quota usage API; per-response token usage is reported during requests."],
		metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
	};
}

async function fetchOllamaCloudUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== OLLAMA_CLOUD_PROVIDER) {
		return null;
	}
	if (params.credential.type !== "api_key" || !params.credential.apiKey) {
		return null;
	}

	const response = await ctx.fetch(OLLAMA_CLOUD_USAGE_URL, {
		headers: { Authorization: `Bearer ${params.credential.apiKey}` },
		signal: params.signal,
	});
	if (!response.ok) {
		throw new ProviderHttpError(
			`Ollama Cloud usage endpoint returned ${response.status} ${response.statusText}`.trim(),
			response.status,
			{ headers: response.headers },
		);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload)) return null;

	const rawLimits = isRecord(payload.limits) ? payload.limits : undefined;
	const limits: UsageLimit[] = [];
	const session = parseWindowLimit(rawLimits?.session, params.provider, {
		id: "session",
		windowId: "5h",
		label: "Session",
		durationMs: 5 * HOUR_MS,
	});
	if (session) limits.push(session);
	const weekly = parseWindowLimit(rawLimits?.weekly, params.provider, {
		id: "weekly",
		windowId: "7d",
		label: "Weekly",
		durationMs: WEEK_MS,
	});
	if (weekly) limits.push(weekly);

	if (limits.length === 0) return null;

	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		metadata: { endpoint: OLLAMA_CLOUD_USAGE_URL },
		raw: payload,
	};
}

/** Self-hosted Ollama has no quota concept; register the account in usage views with an explanatory note. */
export const ollamaUsageProvider: UsageProvider = {
	id: OLLAMA_PROVIDER,
	fetchUsage: fetchOllamaLocalUsage,
	supports: params => params.provider === OLLAMA_PROVIDER,
	validatesCredentials: false,
};

/** Ollama Cloud usage via the account `/api/usage` endpoint. */
export const ollamaCloudUsageProvider: UsageProvider = {
	id: OLLAMA_CLOUD_PROVIDER,
	fetchUsage: fetchOllamaCloudUsage,
	supports: params =>
		params.provider === OLLAMA_CLOUD_PROVIDER &&
		params.credential.type === "api_key" &&
		Boolean(params.credential.apiKey),
	validatesCredentials: true,
};
