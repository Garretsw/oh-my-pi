import { describe, expect, test } from "bun:test";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { ollamaCloudUsageProvider, ollamaUsageProvider } from "@oh-my-pi/pi-ai/usage/ollama";

function params(apiKey: string): UsageFetchParams {
	return {
		provider: "ollama-cloud",
		credential: { type: "api_key", apiKey },
		accountKey: "account-1",
	};
}

/**
 * Payload shape observed from `GET https://ollama.com/api/usage` (first
 * reported in ollama/ollama#12532, 2026-07-29): per-window fractional usage
 * plus request counts per model, no reset timestamps.
 */
function happyPayload() {
	return {
		activity: {
			cost: "0.00000",
			period: { type: "last_4_weeks", starting_at: "2026-07-06T00:00:00Z", ending_at: "2026-08-01T12:00:00Z" },
			models: [],
		},
		limits: {
			session: { usage: 0.046, models: [{ name: "glm-5.2", request_count: 34 }] },
			weekly: { usage: 0.051, models: [{ name: "glm-5.2", request_count: 254 }] },
		},
	};
}

describe("ollama-cloud usage provider", () => {
	test("fetches the account usage endpoint with the API key and parses window fractions", async () => {
		const requests: { url: string; init?: RequestInit }[] = [];
		const fetchMock: FetchImpl = (input, init) => {
			requests.push({ url: String(input), init });
			return Promise.resolve(Response.json(happyPayload()));
		};

		const report = await ollamaCloudUsageProvider.fetchUsage(params("sk-test"), { fetch: fetchMock });

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://ollama.com/api/usage");
		expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe("Bearer sk-test");
		expect(report).toMatchObject({
			provider: "ollama-cloud",
			limits: [
				{
					id: "ollama-cloud:session",
					window: { id: "5h", durationMs: 18_000_000 },
					amount: { used: 4.6, usedFraction: 0.046, unit: "percent" },
					status: "ok",
				},
				{
					id: "ollama-cloud:weekly",
					window: { id: "7d", durationMs: 604_800_000 },
					amount: { used: 5.1, usedFraction: 0.051, unit: "percent" },
					status: "ok",
				},
			],
		});
	});

	test("flags exhausted and warning windows from the fraction", async () => {
		const payload = happyPayload();
		payload.limits.session.usage = 1.0;
		payload.limits.weekly.usage = 0.93;
		const fetchMock: FetchImpl = () => Promise.resolve(Response.json(payload));

		const report = await ollamaCloudUsageProvider.fetchUsage(params("sk-test"), { fetch: fetchMock });

		expect(report?.limits.map(limit => limit.status)).toEqual(["exhausted", "warning"]);
		expect(report?.limits[0]?.amount.remainingFraction).toBe(0);
		expect(report?.limits[1]?.amount.remainingFraction).toBeCloseTo(0.07);
	});

	test("skips a window whose usage fraction is missing but keeps the other", async () => {
		const payload = happyPayload();
		payload.limits.session = { models: [] } as unknown as typeof payload.limits.session;
		const fetchMock: FetchImpl = () => Promise.resolve(Response.json(payload));

		const report = await ollamaCloudUsageProvider.fetchUsage(params("sk-test"), { fetch: fetchMock });

		expect(report?.limits.map(limit => limit.id)).toEqual(["ollama-cloud:weekly"]);
	});

	test("returns null when neither window carries a usage fraction", async () => {
		const fetchMock: FetchImpl = () => Promise.resolve(Response.json({ limits: {} }));

		const report = await ollamaCloudUsageProvider.fetchUsage(params("sk-test"), { fetch: fetchMock });

		expect(report).toBeNull();
	});

	test("returns null for non-cloud providers and non-api-key credentials without fetching", async () => {
		const fetchMock: FetchImpl = () => {
			throw new Error("fetch must not be called");
		};

		expect(
			await ollamaCloudUsageProvider.fetchUsage({ ...params("sk-test"), provider: "ollama" }, { fetch: fetchMock }),
		).toBeNull();
		expect(
			await ollamaCloudUsageProvider.fetchUsage(
				{ ...params(""), credential: { type: "oauth", accessToken: "tok" } },
				{ fetch: fetchMock },
			),
		).toBeNull();
	});

	test("throws ProviderHttpError on non-2xx so credential health checks see the failure", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response("unauthorized", { status: 401, statusText: "Unauthorized" }));

		const promise = ollamaCloudUsageProvider.fetchUsage(params("sk-bad"), { fetch: fetchMock });

		await expect(promise).rejects.toBeInstanceOf(ProviderHttpError);
		await expect(promise).rejects.toMatchObject({ status: 401 });
	});
});

describe("ollama local usage provider", () => {
	test("reports no limits with an explanatory note and never fetches", async () => {
		const fetchMock: FetchImpl = () => {
			throw new Error("fetch must not be called");
		};

		const report = await ollamaUsageProvider.fetchUsage({ ...params(""), provider: "ollama" }, { fetch: fetchMock });

		expect(report?.limits).toEqual([]);
		expect(report?.notes?.[0]).toContain("no quota usage API");
	});
});
