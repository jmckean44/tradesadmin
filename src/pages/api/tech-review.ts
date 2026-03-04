import dns from 'dns/promises';

// Shared error message for unresolved domains
export const DOMAIN_NOT_FOUND_ERROR = 'The website address you entered could not be found. Please check for typos and try again.';
// Check if domain resolves
async function isDomainResolvable(url: string): Promise<boolean> {
	try {
		const normalized = normalizeUrl(url);
		const parsed = new URL(normalized);
		const hostname = String(parsed.hostname || '')
			.trim()
			.toLowerCase();
		if (!hostname) return false;

		const hostCandidates = Array.from(new Set([hostname, hostname.startsWith('www.') ? hostname.slice(4) : `www.${hostname}`].filter(Boolean)));

		for (const hostCandidate of hostCandidates) {
			try {
				await dns.lookup(hostCandidate);
				return true;
			} catch {
				// continue trying fallbacks
			}
		}

		for (const hostCandidate of hostCandidates) {
			try {
				const candidateUrl = new URL(normalized);
				candidateUrl.hostname = hostCandidate;
				const response = await withTimeout(
					fetch(candidateUrl.toString(), {
						method: 'HEAD',
						redirect: 'follow',
					}),
					7000,
					'Website reachability check',
				);

				if (response.status >= 100) return true;
			} catch {
				// continue trying fallbacks
			}
		}

		return false;
	} catch {
		return false;
	}
}
import type { APIRoute } from 'astro';
import nodemailer from 'nodemailer';

type TurnstileVerifyResponse = {
	success: boolean;
	'error-codes'?: string[];
	hostname?: string;
	action?: string;
	cdata?: string;
};

type TurnstileVerificationResult = {
	success: boolean;
	errorCodes: string[];
	hostname?: string;
};

type Review = {
	performance: number | null;
	seo: number | null;
	accessibility: number | null;
	bestPractices: number | null;
	lcp: string;
	cls: string;
	interactive: string;
	tbt: string;
};

type ReviewPreview = {
	available: boolean;
	scores: {
		performance: number | null;
		seo: number | null;
		accessibility: number | null;
		bestPractices: number | null;
	};
	reviewError?: string;
};

type CachedReview = {
	review: Review;
	expiresAt: number;
};

type ReviewRunResult = {
	review: Review;
	source: 'lighthouse' | 'pagespeed-key' | 'pagespeed-no-key';
};

type NotionPropertyType = 'title' | 'rich_text' | 'email' | 'url' | 'phone_number' | 'number' | 'checkbox' | 'date' | 'select' | 'status';

type NotionDatabaseProperty = {
	id: string;
	name: string;
	type: string;
};

type NotionDatabaseSchemaResponse = {
	properties?: Record<string, NotionDatabaseProperty>;
};

type NotionDatabaseQueryResponse = {
	results?: Array<{ id?: string }>;
};

type NotionSubmissionInput = {
	company: string;
	email: string;
	url: string;
	phone: string;
	message: string;
	liveScanError: string;
	reportFilename: string;
	preview: ReviewPreview;
	review: Review | null;
	reviewError: string;
	siteChecks: {
		sslValid: boolean | null;
		httpStatus: number | null;
		dnsFound: boolean | null;
		sitemapExists: boolean | null;
		cspPresent: boolean | null;
		error: string;
	};
};

const REVIEW_CACHE_TTL_MS_DEFAULT = 6 * 60 * 60 * 1000;
const REQUEST_TIME_BUDGET_MS_DEFAULT = 9000;
const reviewCache = new Map<string, CachedReview>();
const PAGESPEED_KEY_COOLDOWN_MS = 15 * 60 * 1000;
let pageSpeedKeyCooldownUntil = 0;

// PageSpeed Insights API key is loaded from Netlify environment as PAGESPEED_API_KEY
// To use, set PAGESPEED_API_KEY in netlify.toml or Netlify dashboard

function getEnv(name: string): string {
	const value = (import.meta.env[name] ?? process.env[name] ?? '') as string;
	return String(value).trim();
}

function normalizeUrl(input: string): string {
	const value = (input || '').trim();
	if (!value) return '';
	return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function isValidEmail(input: string): boolean {
	const value = String(input || '').trim();
	if (!value) return false;
	return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function isLighthouseAssetErrorMessage(message: string): boolean {
	const text = String(message || '');
	return text.includes('standalone-flow-template.html') || text.includes('flow-report/assets') || text.includes('ENOENT');
}

function getReviewCacheTtlMs(): number {
	const raw = getEnv('TECH_REVIEW_CACHE_TTL_MS');
	if (!raw) return REVIEW_CACHE_TTL_MS_DEFAULT;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return REVIEW_CACHE_TTL_MS_DEFAULT;
	return Math.round(parsed);
}

function getRequestTimeBudgetMs(): number {
	const raw = getEnv('TECH_REVIEW_REQUEST_BUDGET_MS');
	if (!raw) return REQUEST_TIME_BUDGET_MS_DEFAULT;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 6000) return REQUEST_TIME_BUDGET_MS_DEFAULT;
	return Math.round(parsed);
}

function getReviewCacheKey(inputUrl: string): string {
	try {
		const parsed = new URL(normalizeUrl(inputUrl));
		parsed.hash = '';
		if (parsed.pathname.endsWith('/') && parsed.pathname !== '/') {
			parsed.pathname = parsed.pathname.slice(0, -1);
		}
		return parsed.toString();
	} catch {
		return normalizeUrl(inputUrl).toLowerCase();
	}
}

function getCachedReview(inputUrl: string): Review | null {
	const key = getReviewCacheKey(inputUrl);
	const cached = reviewCache.get(key);
	if (!cached) return null;
	if (cached.expiresAt <= Date.now()) {
		reviewCache.delete(key);
		return null;
	}
	return cached.review;
}

function getAnyCachedReview(inputUrl: string): Review | null {
	const key = getReviewCacheKey(inputUrl);
	const cached = reviewCache.get(key);
	return cached?.review ?? null;
}

function setCachedReview(inputUrl: string, review: Review): void {
	const key = getReviewCacheKey(inputUrl);
	reviewCache.set(key, {
		review,
		expiresAt: Date.now() + getReviewCacheTtlMs(),
	});
}

function pct(score: number | null | undefined): number | null {
	return score == null ? null : Math.round(score * 100);
}

function reviewFromLhrLike(lhr: { categories?: Record<string, { score?: number | null }>; audits?: Record<string, { displayValue?: string }> }): Review {
	const categories = lhr.categories ?? {};
	const audits = lhr.audits ?? {};

	return {
		performance: pct(categories.performance?.score),
		seo: pct(categories.seo?.score),
		accessibility: pct(categories.accessibility?.score),
		bestPractices: pct(categories['best-practices']?.score),
		lcp: audits['largest-contentful-paint']?.displayValue ?? 'N/A',
		cls: audits['cumulative-layout-shift']?.displayValue ?? 'N/A',
		interactive: audits['interactive']?.displayValue ?? 'N/A',
		tbt: audits['total-blocking-time']?.displayValue ?? 'N/A',
	};
}

function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function hasAnyLiveScore(review: Review): boolean {
	return [review.performance, review.seo, review.accessibility, review.bestPractices].some((value) => typeof value === 'number' && Number.isFinite(value));
}

function hasPerformanceScore(review: Review): boolean {
	return typeof review.performance === 'number' && Number.isFinite(review.performance);
}

function getPerformanceLabDataUnavailableGuidance(): string {
	return 'Live scan performance data is currently unavailable. Review and reduce render-blocking JavaScript/CSS, then retry the scan.';
}

function normalizeReviewErrorForUser(message: string): string {
	const text = String(message || '');
	if (!text) return 'Live scan data is currently unavailable.';
	if (isLighthouseAssetErrorMessage(text)) return 'Live scan data is currently unavailable.';
	if (/429|rate limit|quota/i.test(text)) return 'Live scan data is temporarily unavailable due to scan capacity limits.';
	if (/performance data unavailable|performance lab data|partial category data|could not complete lab metrics/i.test(text)) {
		return getPerformanceLabDataUnavailableGuidance();
	}
	return text;
}

function normalizeLiveScanErrorForUser(message: string): string {
	const text = String(message || '');
	if (!text) return 'Live scan data is currently unavailable.';
	if (/performance data unavailable|performance lab data|partial category data|could not complete lab metrics/i.test(text)) {
		return getPerformanceLabDataUnavailableGuidance();
	}
	if (/api key|forbidden|accessnotconfigured|permission denied|403|401/i.test(text)) {
		return 'Live scan data is unavailable because the PageSpeed API key is missing, invalid, or restricted.';
	}
	if (/429|rate limit|quota/i.test(text)) {
		return 'Live scan data is temporarily unavailable due to PageSpeed API quota limits.';
	}
	if (/timed out|timeout/i.test(text)) {
		return 'Live scan data request timed out. Please try again.';
	}
	if (isLighthouseAssetErrorMessage(text)) {
		return 'Live scan data is currently unavailable in this server environment.';
	}
	return normalizeReviewErrorForUser(text);
}

function normalizeNotionErrorForUser(message: string): string {
	const text = String(message || '');
	if (!text) return 'Notion sync failed. Check integration access and database settings.';
	if (/unauthorized|forbidden|401|403/i.test(text)) return 'Notion sync failed: integration token is invalid or missing permissions.';
	if (/object_not_found|404|database lookup failed/i.test(text)) return 'Notion sync failed: database ID is invalid or integration is not shared to that database.';
	if (/validation_error|400/i.test(text)) return 'Notion sync failed: database property schema does not match expected field types.';
	if (/timed out|timeout/i.test(text)) return 'Notion sync failed: Notion request timed out.';
	return 'Notion sync failed. Check integration access, database ID, and property schema.';
}

function getNotionHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		'Notion-Version': '2022-06-28',
		'Content-Type': 'application/json',
	};
}

function normalizePropertyName(input: string): string {
	return String(input || '')
		.trim()
		.toLowerCase()
		.replace(/[_-]+/g, ' ')
		.replace(/\s+/g, ' ');
}

function findPropertyKeyByType(properties: Record<string, NotionDatabaseProperty>, type: NotionPropertyType, candidates: string[] = []): string | null {
	const exactNames = new Set(candidates.map((name) => normalizePropertyName(name)));

	for (const [key, property] of Object.entries(properties)) {
		if (property.type !== type) continue;
		if (!exactNames.size || exactNames.has(normalizePropertyName(property.name || key))) return key;
	}

	if (exactNames.size) {
		for (const [key, property] of Object.entries(properties)) {
			if (property.type !== type) continue;
			const current = normalizePropertyName(property.name || key);
			if (Array.from(exactNames).some((candidate) => current.includes(candidate) || candidate.includes(current))) return key;
		}
	}

	return null;
}

function findPropertyKeyByTypeExact(properties: Record<string, NotionDatabaseProperty>, type: NotionPropertyType, candidates: string[] = []): string | null {
	const exactNames = new Set(candidates.map((name) => normalizePropertyName(name)));
	if (!exactNames.size) return null;

	for (const [key, property] of Object.entries(properties)) {
		if (property.type !== type) continue;
		if (exactNames.has(normalizePropertyName(property.name || key))) return key;
	}

	return null;
}

function buildNotionTextValue(value: string): Array<{ type: 'text'; text: { content: string } }> {
	const content = String(value || '').trim();
	if (!content) return [];
	return [{ type: 'text', text: { content: content.slice(0, 1900) } }];
}

function stripUrlProtocol(value: string): string {
	return String(value || '')
		.trim()
		.replace(/^https?:\/\//i, '');
}

function normalizeUrlForNotion(value: string): string {
	const normalized = normalizeUrl(value);
	if (!normalized) return '';

	try {
		const parsed = new URL(normalized);
		// Remove trailing slash from pathname unless root
		if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
			parsed.pathname = parsed.pathname.replace(/\/+$/, '');
		}
		if (parsed.pathname === '/') parsed.pathname = '';
		return parsed.toString();
	} catch {
		return normalized;
	}
}

async function getNotionDatabaseProperties(token: string, databaseId: string): Promise<Record<string, NotionDatabaseProperty>> {
	const response = await withTimeout(fetch(`https://api.notion.com/v1/databases/${databaseId}`, { headers: getNotionHeaders(token) }), 12000, 'Notion database lookup');

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(`Notion database lookup failed (${response.status}) ${body}`.trim());
	}

	const data = (await response.json()) as NotionDatabaseSchemaResponse;
	return data.properties ?? {};
}

async function findExistingNotionPageIdByWebsite(token: string, databaseId: string, websitePropertyName: string, websitePropertyType: 'url' | 'rich_text', websiteUrl: string): Promise<string | null> {
	const response = await withTimeout(
		fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
			method: 'POST',
			headers: getNotionHeaders(token),
			body: JSON.stringify({
				filter:
					websitePropertyType === 'url'
						? {
								property: websitePropertyName,
								url: { equals: websiteUrl },
						  }
						: {
								property: websitePropertyName,
								rich_text: { equals: stripUrlProtocol(websiteUrl) },
						  },
				page_size: 1,
			}),
		}),
		12000,
		'Notion database query',
	);

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(`Notion database query failed (${response.status}) ${body}`.trim());
	}

	const data = (await response.json()) as NotionDatabaseQueryResponse;
	const firstId = data.results?.[0]?.id;
	return typeof firstId === 'string' && firstId ? firstId : null;
}

async function createOrUpdateNotionPage(token: string, databaseId: string, pageId: string | null, properties: Record<string, unknown>): Promise<void> {
	const endpoint = pageId ? `https://api.notion.com/v1/pages/${pageId}` : 'https://api.notion.com/v1/pages';
	const method = pageId ? 'PATCH' : 'POST';
	const body = pageId ? { properties } : { parent: { database_id: databaseId }, properties };

	const response = await withTimeout(
		fetch(endpoint, {
			method,
			headers: getNotionHeaders(token),
			body: JSON.stringify(body),
		}),
		12000,
		pageId ? 'Notion page update' : 'Notion page create',
	);

	if (!response.ok) {
		const responseBody = await response.text().catch(() => '');
		throw new Error(`Notion page ${pageId ? 'update' : 'create'} failed (${response.status}) ${responseBody}`.trim());
	}
}

async function logSubmissionToNotion(input: NotionSubmissionInput): Promise<void> {
	const notionToken = getEnv('NOTION_API_KEY') || getEnv('NOTION_TOKEN');
	const notionDatabaseId = getEnv('NOTION_DATABASE_ID');
	if (!notionToken || !notionDatabaseId) return;

	const propertiesSchema = await getNotionDatabaseProperties(notionToken, notionDatabaseId);
	const properties: Record<string, unknown> = {};

	const titleKey = findPropertyKeyByType(propertiesSchema, 'title');
	if (!titleKey) throw new Error('Notion database has no title property.');

	const titleValue = input.company;
	properties[titleKey] = { title: buildNotionTextValue(titleValue) };

	const setTextLikeProperty = (type: 'rich_text' | 'email' | 'url' | 'phone_number', names: string[], value: string): void => {
		if (!value) return;
		const key = findPropertyKeyByType(propertiesSchema, type, names);
		if (!key) return;

		if (type === 'rich_text') {
			properties[key] = { rich_text: buildNotionTextValue(value) };
			return;
		}

		if (type === 'email') {
			properties[key] = { email: value };
			return;
		}

		if (type === 'url') {
			properties[key] = { url: normalizeUrlForNotion(value) };
			return;
		}

		properties[key] = { phone_number: value };
	};

	const setNumberProperty = (names: string[], value: number | null | undefined): void => {
		if (value == null || !Number.isFinite(value)) return;
		const key = findPropertyKeyByType(propertiesSchema, 'number', names);
		if (!key) return;
		properties[key] = { number: value };
	};

	const emailKey = findPropertyKeyByType(propertiesSchema, 'email', ['email', 'e-mail']);
	if (emailKey && input.email) {
		properties[emailKey] = { email: input.email };
	}

	const normalizedWebsiteUrl = normalizeUrlForNotion(input.url);
	setTextLikeProperty('url', ['url', 'website', 'site', 'domain'], normalizedWebsiteUrl);
	setTextLikeProperty('rich_text', ['url', 'website', 'site', 'domain'], stripUrlProtocol(normalizedWebsiteUrl));
	setTextLikeProperty('phone_number', ['phone', 'telephone'], input.phone);
	setTextLikeProperty('rich_text', ['message', 'details', 'comments', 'notes'], input.message);

	const submittedAtKey = findPropertyKeyByType(propertiesSchema, 'date', ['submitted at', 'submitted', 'date']);
	if (submittedAtKey) properties[submittedAtKey] = { date: { start: new Date().toISOString() } };

	setNumberProperty(['performance', 'performance score'], input.preview.scores.performance);
	setNumberProperty(['seo', 'seo score'], input.preview.scores.seo);
	setNumberProperty(['accessibility', 'accessibility score'], input.preview.scores.accessibility);
	setNumberProperty(['best practices', 'best practices score'], input.preview.scores.bestPractices);

	let existingPageId: string | null = null;
	if (normalizedWebsiteUrl) {
		const websiteUrlKey = findPropertyKeyByType(propertiesSchema, 'url', ['url', 'website', 'site', 'domain']);
		if (websiteUrlKey) {
			const websitePropertyName = propertiesSchema[websiteUrlKey]?.name || websiteUrlKey;
			existingPageId = await findExistingNotionPageIdByWebsite(notionToken, notionDatabaseId, websitePropertyName, 'url', normalizedWebsiteUrl);
		} else {
			const websiteTextKey = findPropertyKeyByType(propertiesSchema, 'rich_text', ['url', 'website', 'site', 'domain']);
			if (websiteTextKey) {
				const websitePropertyName = propertiesSchema[websiteTextKey]?.name || websiteTextKey;
				existingPageId = await findExistingNotionPageIdByWebsite(notionToken, notionDatabaseId, websitePropertyName, 'rich_text', normalizedWebsiteUrl);
			}
		}
	}

	// Only set Status = New if creating a new page (not updating)
	const statusKey = findPropertyKeyByType(propertiesSchema, 'status', ['status']);
	if (statusKey && !existingPageId) {
		properties[statusKey] = { status: { name: 'New' } };
	}

	await createOrUpdateNotionPage(notionToken, notionDatabaseId, existingPageId, properties);
}

function buildReviewPreview(review: Review | null, reviewError: string, forceUnavailable = false): ReviewPreview {
	if (!review || forceUnavailable) {
		return {
			available: false,
			scores: {
				performance: null,
				seo: null,
				accessibility: null,
				bestPractices: null,
			},
			reviewError: reviewError || undefined,
		};
	}

	return {
		available: true,
		scores: {
			performance: review.performance,
			seo: review.seo,
			accessibility: review.accessibility,
			bestPractices: review.bestPractices,
		},
	};
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	const timeoutPromise = new Promise<T>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
	});

	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timer) clearTimeout(timer);
	}) as Promise<T>;
}

async function parseRequestBody(request: Request): Promise<Record<string, unknown>> {
	const contentType = (request.headers.get('content-type') || '').toLowerCase();

	if (contentType.includes('application/json')) {
		const raw = await request.text();
		if (!raw.trim()) return {};
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	}

	if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
		const form = await request.formData().catch(() => null);
		if (!form) return {};

		const out: Record<string, unknown> = {};
		for (const [key, value] of form.entries()) {
			out[key] = typeof value === 'string' ? value : value.name;
		}
		return out;
	}

	return {};
}

async function verifyTurnstileToken(token: string, remoteIp?: string): Promise<TurnstileVerificationResult> {
	const secret = getEnv('TURNSTILE_SECRET_KEY');
	if (!secret || !token) {
		return {
			success: false,
			errorCodes: ['missing-input-secret-or-response'],
		};
	}

	const form = new URLSearchParams();
	form.append('secret', secret);
	form.append('response', token);
	if (remoteIp) form.append('remoteip', remoteIp);

	let resp: Response;
	try {
		resp = await withTimeout(
			fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: form.toString(),
			}),
			8000,
			'Turnstile verification',
		);
	} catch {
		return {
			success: false,
			errorCodes: ['siteverify-network-error'],
		};
	}

	if (!resp.ok) {
		return {
			success: false,
			errorCodes: ['siteverify-http-error'],
		};
	}

	let data: TurnstileVerifyResponse;
	try {
		data = (await resp.json()) as TurnstileVerifyResponse;
	} catch {
		return {
			success: false,
			errorCodes: ['siteverify-parse-error'],
		};
	}

	if (!data.success) {
		console.error('Turnstile verify failed:', {
			errorCodes: data['error-codes'],
			hostname: data.hostname,
			tokenPresent: Boolean(token),
			secretPresent: Boolean(secret),
		});
	}

	return {
		success: data.success === true,
		errorCodes: data['error-codes'] ?? [],
		hostname: data.hostname,
	};
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPageSpeedApiKeyIfUsable(): string {
	const key = getEnv('PAGESPEED_API_KEY');
	if (!key) return '';
	if (Date.now() < pageSpeedKeyCooldownUntil) return '';
	return key;
}

function includeKeyQuotaOrAuthFailure(message: string): boolean {
	return /403|401|429|forbidden|accessnotconfigured|api key|permission denied|keyinvalid|iprefererblocked|rate limit|quota/i.test(message);
}

function extractPageSpeedProjectNumber(text: string): string {
	const source = String(text || '');
	const direct = source.match(/project_number:(\d{6,})/i)?.[1];
	if (direct) return direct;
	const consumer = source.match(/consumer["']?\s*[:=]\s*["']?projects\/(\d{6,})/i)?.[1];
	if (consumer) return consumer;
	return '';
}

function getExpectedPageSpeedProjectNumber(): string {
	return getEnv('PAGESPEED_PROJECT_NUMBER').replace(/\D/g, '');
}

function getPageSpeedPerformanceScore(categories: Record<string, { score?: number | null }> | undefined): number | null {
	const raw = categories?.performance?.score;
	return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function shouldLogPageSpeedDebug(): boolean {
	return getEnv('TECH_REVIEW_DEBUG_PAGESPEED').toLowerCase() === 'true';
}

async function runReview(url: string): Promise<ReviewRunResult> {
	async function runReviewWithPageSpeedInsights(targetUrl: string): Promise<ReviewRunResult> {
		async function requestPageSpeed(strategy: 'mobile' | 'desktop'): Promise<ReviewRunResult> {
			const pageSpeedApiKey = getPageSpeedApiKeyIfUsable();
			const expectedProjectNumber = getExpectedPageSpeedProjectNumber();

			const executePageSpeedRequest = async (includeApiKey: boolean, mode: 'full' | 'minimal' = 'full'): Promise<ReviewRunResult> => {
				const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
				endpoint.searchParams.set('url', targetUrl);
				endpoint.searchParams.set('category', 'performance');
				if (mode === 'full') {
					endpoint.searchParams.append('category', 'seo');
					endpoint.searchParams.append('category', 'accessibility');
					endpoint.searchParams.append('category', 'best-practices');
				}
				endpoint.searchParams.set('strategy', strategy);
				if (includeApiKey && pageSpeedApiKey) endpoint.searchParams.set('key', pageSpeedApiKey);

				let lastError: Error | null = null;
				for (let attempt = 1; attempt <= 3; attempt += 1) {
					try {
						const response = await withTimeout(fetch(endpoint.toString()), 30000, 'PageSpeed API request');
						if (!response.ok) {
							const body = await response.text().catch(() => '');
							const detectedProjectNumber = extractPageSpeedProjectNumber(body);
							if (expectedProjectNumber && detectedProjectNumber && expectedProjectNumber !== detectedProjectNumber) {
								throw new Error(
									`PageSpeed API key project mismatch: expected project ${expectedProjectNumber} but request used project ${detectedProjectNumber}. Update PAGESPEED_API_KEY in this deploy context.`,
								);
							}
							const message = `PageSpeed API failed (${response.status}) ${body}`.trim();
							// Detect per-minute quota (HTTP 429)
							if (response.status === 429) {
								console.warn('[PageSpeed API] Per-minute quota exceeded (HTTP 429). This likely means you are hitting the rate limit of ~400 requests per 100 seconds.');
							}
							const transientFailure = /5\d\d|timed out|timeout|internal|network|fetch failed|ecconnreset|eai_again/i.test(message);
							if (attempt < 3 && transientFailure) {
								await wait(300 * attempt);
								continue;
							}
							throw new Error(message);
						}

						const payload = (await response.json()) as {
							lighthouseResult?: {
								categories?: Record<string, { score?: number | null }>;
								audits?: Record<string, { displayValue?: string }>;
							};
						};

						if (shouldLogPageSpeedDebug()) {
							console.log(`[PageSpeed API][${strategy}] categories:`, payload?.lighthouseResult?.categories ?? null);
						}

						if (!payload.lighthouseResult) throw new Error('PageSpeed response missing lighthouseResult');
						const performanceScore = getPageSpeedPerformanceScore(payload.lighthouseResult.categories);
						if (performanceScore == null) {
							const labDataError = new Error(`PageSpeed performance data unavailable (${strategy}). Lighthouse could not complete lab metrics in time for this run.`);
							if (attempt < 3) {
								await wait(300 * attempt);
								continue;
							}
							throw labDataError;
						}
						return {
							review: reviewFromLhrLike(payload.lighthouseResult),
							source: includeApiKey ? 'pagespeed-key' : 'pagespeed-no-key',
						};
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						const transientFailure = /5\d\d|timed out|timeout|internal|network|fetch failed|ecconnreset|eai_again/i.test(message);
						lastError = err instanceof Error ? err : new Error(message);
						if (attempt < 3 && transientFailure) {
							await wait(300 * attempt);
							continue;
						}
						throw lastError;
					}
				}

				throw lastError ?? new Error('PageSpeed API request failed');
			};

			// Try with API key first (if available)
			let result: ReviewRunResult | null = null;
			let triedWithKey = false;
			if (pageSpeedApiKey) {
				try {
					result = await executePageSpeedRequest(true, 'full');
					// If metrics are missing, retry without key
					const hasMetrics = result && result.review && hasPerformanceScore(result.review);
					if (!hasMetrics) {
						// Retry without API key
						const retryResult = await executePageSpeedRequest(false, 'full');
						// If retry yields more metrics, use it
						const retryHasMetrics = retryResult && retryResult.review && hasPerformanceScore(retryResult.review);
						if (retryHasMetrics) {
							return retryResult;
						}
					}
					return result;
				} catch (err) {
					// If error, fallback to no-key
					try {
						return await executePageSpeedRequest(false, 'full');
					} catch (retryErr) {
						const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
						const quotaLikeFailure = /429|rate limit|quota/i.test(retryMessage);
						if (!quotaLikeFailure) throw retryErr;
						return executePageSpeedRequest(false, 'minimal');
					}
				}
			} else {
				// No API key, just try without
				try {
					return await executePageSpeedRequest(false, 'full');
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const quotaLikeFailure = /429|rate limit|quota/i.test(message);
					if (!quotaLikeFailure) throw err;
					return executePageSpeedRequest(false, 'minimal');
				}
			}
		}

		const mobileResult = await requestPageSpeed('mobile');
		if (hasPerformanceScore(mobileResult.review)) return mobileResult;

		const desktopResult = await requestPageSpeed('desktop');
		if (hasPerformanceScore(desktopResult.review)) return desktopResult;

		if (hasAnyLiveScore(mobileResult.review) || hasAnyLiveScore(desktopResult.review)) {
			throw new Error('PageSpeed returned partial category data, but performance lab data was unavailable.');
		}

		return hasAnyLiveScore(mobileResult.review) ? mobileResult : desktopResult;
	}

	// Always use PageSpeed API for scans (never attempt to run Lighthouse/Chrome in serverless)
	return await runReviewWithPageSpeedInsights(url);
}

export const GET: APIRoute = async () => {
	return new Response(JSON.stringify({ ok: true, route: '/api/tech-review/' }), { status: 200 });
};

export const POST: APIRoute = async ({ request }) => {
	try {
		const isDev = import.meta.env.DEV;
		const requestStartedAt = Date.now();
		const requestBudgetMs = isDev ? Math.max(30000, getRequestTimeBudgetMs()) : getRequestTimeBudgetMs();
		const hasTimeBudget = (reserveMs = 0): boolean => Date.now() - requestStartedAt < requestBudgetMs - reserveMs;
		const configuredReviewTimeout = Number(getEnv('TECH_REVIEW_REVIEW_TIMEOUT_MS'));
		const reviewTimeoutMs = Number.isFinite(configuredReviewTimeout) && configuredReviewTimeout > 0 ? Math.round(configuredReviewTimeout) : isDev ? 30000 : 6500;
		const smtpVerifyTimeoutMs = isDev ? 10000 : 3000;
		const notionSyncTimeoutMs = isDev ? 12000 : 2500;
		const smtpSendTimeoutMs = isDev ? 12000 : 2500;
		const body = await parseRequestBody(request);

		const turnstileToken = (typeof body.turnstileToken === 'string' && body.turnstileToken.trim()) || (typeof body['cf-turnstile-response'] === 'string' && body['cf-turnstile-response'].trim()) || '';

		const forwardedFor = request.headers.get('x-forwarded-for') || '';
		const remoteIp = forwardedFor.split(',')[0]?.trim() || undefined;

		const verification = await verifyTurnstileToken(turnstileToken, remoteIp);
		if (!verification.success) {
			return new Response(
				JSON.stringify(
					isDev
						? {
								error: 'Invalid verification.',
								turnstile: {
									errorCodes: verification.errorCodes,
									hostname: verification.hostname,
									tokenPresent: Boolean(turnstileToken),
									secretPresent: Boolean(getEnv('TURNSTILE_SECRET_KEY')),
									contentType: request.headers.get('content-type') || '',
									bodyKeys: Object.keys(body),
									turnstileTokenType: typeof body.turnstileToken,
									turnstileTokenLength: typeof body.turnstileToken === 'string' ? body.turnstileToken.length : 0,
								},
						  }
						: { error: 'Invalid verification.' },
				),
				{ status: 400 },
			);
		}

		const company = typeof body.company === 'string' ? body.company.trim() : '';
		const email = typeof body.email === 'string' ? body.email.trim() : '';
		const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
		const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
		const message = typeof body.message === 'string' ? body.message.trim() : '';
		if (!company) {
			return new Response(JSON.stringify({ error: 'Company is required.' }), { status: 400 });
		}

		if (!email) {
			return new Response(JSON.stringify({ error: 'Email is required.' }), { status: 400 });
		}

		if (!isValidEmail(email)) {
			return new Response(JSON.stringify({ error: 'Invalid email address.' }), { status: 400 });
		}

		const url = rawUrl ? normalizeUrl(rawUrl) : '';
		const displayUrl = rawUrl || url || 'N/A';
		const notionUrl = url;
		if (url) {
			try {
				new URL(url);
			} catch {
				return new Response(JSON.stringify({ error: 'Invalid URL.' }), { status: 400 });
			}
			// DNS resolution check
			if (!(await isDomainResolvable(url))) {
				return new Response(JSON.stringify({ error: DOMAIN_NOT_FOUND_ERROR }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}
		}

		// SMTP and Notion submission removed for testing reliability

		let review: Review | null = null;
		let scanSource: 'lighthouse' | 'pagespeed-key' | 'pagespeed-no-key' | 'cache-fresh' | 'cache-stale' | 'fallback' = 'fallback';
		let reviewError = '';
		let liveScanError = '';
		let forceUnavailablePreview = false;
		let psiApiErrors: string[] = [];
		if (!url) {
			reviewError = 'No URL provided.';
			liveScanError = reviewError;
		} else {
			const staleCachedReview = getAnyCachedReview(url);
			try {
				const cachedReview = getCachedReview(url);
				if (cachedReview) {
					review = cachedReview;
					scanSource = 'cache-fresh';
				} else if (!hasTimeBudget(4500)) {
					reviewError = 'Live scan skipped due to server time budget. Submission still saved.';
					liveScanError = reviewError;
				} else {
					const remainingMs = requestBudgetMs - (Date.now() - requestStartedAt);
					const boundedReviewTimeoutMs = Math.max(3500, Math.min(reviewTimeoutMs, remainingMs - 3000));
					try {
						const runResult = await withTimeout(runReview(url), boundedReviewTimeoutMs, 'Lighthouse review');
						review = runResult.review;
						scanSource = runResult.source;
						setCachedReview(url, review);
					} catch (psiErr) {
						const psiMsg = psiErr instanceof Error ? psiErr.message : String(psiErr);
						psiApiErrors.push(psiMsg);
						throw psiErr;
					}
				}
			} catch (err) {
				console.error('Review failed:', err);
				const message = err instanceof Error ? err.message : String(err);
				liveScanError = message;
				reviewError = normalizeReviewErrorForUser(message);
				if (staleCachedReview && hasAnyLiveScore(staleCachedReview)) {
					review = staleCachedReview;
					scanSource = 'cache-stale';
					reviewError = 'Live scan data is temporarily unavailable. Showing recent cached results.';
				}
				// Simplified mode: skip extra fallback checks.
			}

			if (review && !hasAnyLiveScore(review)) {
				forceUnavailablePreview = true;
				scanSource = 'fallback';
				reviewError = reviewError || 'Live scan data is currently unavailable.';
				liveScanError = liveScanError || reviewError;
			}

			if (!review) {
				scanSource = 'fallback';
			}

			// Simplified mode: skip extended scan modules.
		}

		const reviewHtml = review
			? `
                <h3 style="margin:16px 0 8px;">Technical Review</h3>
                <ul>
                    <li><strong>Performance:</strong> ${review.performance ?? 'N/A'}</li>
                    <li><strong>SEO:</strong> ${review.seo ?? 'N/A'}</li>
                    <li><strong>Accessibility:</strong> ${review.accessibility ?? 'N/A'}</li>
                    <li><strong>Best Practices:</strong> ${review.bestPractices ?? 'N/A'}</li>
                    <li><strong>LCP:</strong> ${review.lcp}</li>
                    <li><strong>CLS:</strong> ${review.cls}</li>
                    <li><strong>Interactive:</strong> ${review.interactive}</li>
                    <li><strong>Total Blocking Time:</strong> ${review.tbt}</li>
                </ul>
            `
			: `<h3 style="margin:16px 0 8px;">Technical Review</h3><p>Technical review unavailable.</p>${reviewError ? `<p><strong>Reason:</strong> ${escapeHtml(reviewError)}</p>` : ''}`;

		const scanSourceLabel: Record<typeof scanSource, string> = {
			lighthouse: 'Lighthouse (server)',
			'pagespeed-key': 'PageSpeed API (with key)',
			'pagespeed-no-key': 'PageSpeed API (without key)',
			'cache-fresh': 'Cached live result (fresh)',
			'cache-stale': 'Cached live result (stale fallback)',
			fallback: 'Fallback site checks only',
		};
		const displayLiveScanError = liveScanError ? (isDev ? liveScanError : normalizeLiveScanErrorForUser(liveScanError)) : '';

		const html = `
            <h2>New Contact Submission</h2>
            <ul>
                <li><strong>Company:</strong> ${escapeHtml(company)}</li>
                <li><strong>Email:</strong> ${escapeHtml(email)}</li>
				<li><strong>URL:</strong> ${escapeHtml(displayUrl)}</li>
				<li><strong>Scan Source:</strong> ${escapeHtml(scanSourceLabel[scanSource])}</li>
				${displayLiveScanError ? `<li><strong>Scan Error:</strong> ${escapeHtml(displayLiveScanError)}</li>` : ''}
                ${phone ? `<li><strong>Phone:</strong> ${escapeHtml(phone)}</li>` : ''}
                ${message ? `<li><strong>Message:</strong> ${escapeHtml(message)}</li>` : ''}
            </ul>
            <hr />
            ${reviewHtml}
        `;

		const reportFilename = url ? `technical-review-${new URL(url).hostname}.pdf` : 'technical-review-request.pdf';
		const preview = buildReviewPreview(review, reviewError, forceUnavailablePreview);
		let siteChecks: NotionSubmissionInput['siteChecks'] = {
			sslValid: null,
			httpStatus: null,
			dnsFound: null,
			sitemapExists: null,
			cspPresent: null,
			error: '',
		};
		siteChecks.error = 'Skipped in simplified mode.';
		// Notion and SMTP submission removed for testing reliability

		// Send submission to Google Sheets Web App
		try {
			await fetch('https://script.google.com/macros/s/AKfycby2hDFPsBn_p0aeQEyLprvi4t1rGc1p0LsnzMmqeMx7XgBuTHlhgfksvfAX4x6qXrWQ/exec', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					apiKey: getEnv('GS_API_KEY'),
					company,
					email,
					url: displayUrl,
					phone,
					message,
					performance: review?.performance ?? null,
					seo: review?.seo ?? null,
					accessibility: review?.accessibility ?? null,
					bestPractices: review?.bestPractices ?? null,
					scanSource,
					psiApiErrors,
				}),
			});
		} catch (sheetErr) {
			console.error('Google Sheets submission failed:', sheetErr);
		}

		// Always return a minimal, clear JSON response, including all PSI API errors
		return new Response(
			JSON.stringify({
				ok: true,
				message: 'Submitted successfully.',
				preview: {
					available: preview.available,
					scores: preview.scores,
					reviewError: preview.reviewError,
				},
				scan: {
					available: preview.available === true,
					source: scanSource,
					error: liveScanError ? (isDev ? liveScanError : normalizeLiveScanErrorForUser(liveScanError)) : undefined,
				},
				psiApiErrors,
			}),
			{ status: 200 },
		);
	} catch (err) {
		console.error('tech-review route error:', err);
		const isDev = import.meta.env.DEV;
		const message = err instanceof Error ? err.message : String(err);
		const errorObj = err instanceof Error ? err : new Error(String(err));
		return new Response(
			JSON.stringify({
				ok: true,
				message: 'Submitted with fallback scan data.',
				preview: {
					available: false,
					scores: {
						performance: null,
						seo: null,
						accessibility: null,
						bestPractices: null,
					},
					reviewError: 'Live scan data is currently unavailable.',
				},
				scan: {
					available: false,
					source: 'fallback',
					error: isDev ? message : 'Live scan data is currently unavailable.',
				},
				error: {
					errorType: errorObj.name || 'Error',
					errorMessage: message,
					stack: isDev ? errorObj.stack : undefined,
				},
			}),
			{ status: 200 },
		);
	}
};
