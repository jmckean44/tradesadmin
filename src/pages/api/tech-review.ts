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
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';

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
	source: 'lighthouse';
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
const REVIEW_TIMEOUT_MS_DEFAULT = 60000;
const reviewCache = new Map<string, CachedReview>();

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

function normalizeNotionErrorForUser(message: string): string {
	const text = String(message || '');
	if (!text) return 'Notion sync failed. Check integration access and database settings.';
	if (/unauthorized|forbidden|401|403/i.test(text)) return 'Notion sync failed: integration token is invalid or missing permissions.';
	if (/object_not_found|404|database lookup failed/i.test(text)) return 'Notion sync failed: database ID is invalid or integration is not shared to that database.';
	if (/validation_error|400/i.test(text)) return 'Notion sync failed: database property schema does not match expected field types.';
	if (/timed out|timeout/i.test(text)) return 'Notion sync failed: Notion request timed out.';
	return 'Notion sync failed. Check integration access, database ID, and property schema.';
}

// Normalize scan errors for user-facing messages
function normalizeLiveScanErrorForUser(message: string): string {
	const text = String(message || '');
	if (!text) return 'A technical scan error occurred. Please try again later.';
	if (/timeout|timed out/i.test(text)) return 'The website scan timed out. Please try again later.';
	if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(text)) return 'The website address could not be found. Please check for typos and try again.';
	if (/net::ERR_CERT/i.test(text)) return 'The website has an invalid SSL certificate.';
	if (/lighthouse did not return a result/i.test(text)) return 'The scan could not be completed for this website.';
	return 'A technical scan error occurred. Please try again later.';
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

	// Only map SEO, performance, best practices, and accessibility scores to Notion

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

async function runReview(url: string): Promise<ReviewRunResult> {
	// Run Lighthouse using chrome-launcher and the lighthouse npm package
	const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless', '--no-sandbox', '--disable-gpu'] });
	try {
		const options = { port: chrome.port, logLevel: 'error' as const };
		const config = undefined; // Use default Lighthouse config
		const runnerResult = await lighthouse(url, options, config);
		if (!runnerResult || !runnerResult.lhr) throw new Error('Lighthouse did not return a result');
		return {
			review: reviewFromLhrLike(runnerResult.lhr),
			source: 'lighthouse',
		};
	} finally {
		await chrome.kill();
	}
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
		const reviewTimeoutMs = Number.isFinite(configuredReviewTimeout) && configuredReviewTimeout > 0 ? Math.round(configuredReviewTimeout) : REVIEW_TIMEOUT_MS_DEFAULT;
		const smtpVerifyTimeoutMs = isDev ? 10000 : 3000;
		const notionSyncTimeoutMs = isDev ? 12000 : 2500;
		const smtpSendTimeoutMs = isDev ? 12000 : 2500;
		const body = await parseRequestBody(request);

		// Declare all variables that will be used throughout the handler
		let liveScanError = '';
		let reportFilename = '';
		let preview: ReviewPreview = {
			available: false,
			scores: {
				performance: null,
				seo: null,
				accessibility: null,
				bestPractices: null,
			},
		};
		let review: Review | null = null;
		let reviewError = '';
		let siteChecks: NotionSubmissionInput['siteChecks'] = {
			sslValid: null,
			httpStatus: null,
			dnsFound: null,
			sitemapExists: null,
			cspPresent: null,
			error: '',
		};
		let html = '';
		let emailSent = false;
		let emailError = '';
		let forceUnavailablePreview = false;
		// psiApiErrors removed

		const turnstileToken = (typeof body.turnstileToken === 'string' && body.turnstileToken.trim()) || (typeof body['cf-turnstile-response'] === 'string' && body['cf-turnstile-response'].trim()) || '';

		const forwardedFor = request.headers.get('x-forwarded-for') || '';
		const remoteIp = forwardedFor.split(',')[0]?.trim() || undefined;

		const verification = await verifyTurnstileToken(turnstileToken, remoteIp);
		if (!verification.success) {
			return new Response(
				JSON.stringify({
					ok: false,
					message: 'Invalid verification.',
					preview: {
						available: false,
						scores: {
							performance: null,
							seo: null,
							accessibility: null,
							bestPractices: null,
						},
						reviewError: 'Verification failed.',
					},
					scan: {
						available: false,
						source: 'fallback',
						error: 'Verification failed.',
					},
					diagnostics: isDev
						? {
								errorCodes: verification.errorCodes,
								hostname: verification.hostname,
								tokenPresent: Boolean(turnstileToken),
								secretPresent: Boolean(getEnv('TURNSTILE_SECRET_KEY')),
								contentType: request.headers.get('content-type') || '',
								bodyKeys: Object.keys(body),
								turnstileTokenType: typeof body.turnstileToken,
								turnstileTokenLength: typeof body.turnstileToken === 'string' ? body.turnstileToken.length : 0,
						  }
						: undefined,
				}),
				{ status: 200 },
			);
		}

		const company = typeof body.company === 'string' ? body.company.trim() : '';
		const email = typeof body.email === 'string' ? body.email.trim() : '';
		const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
		const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
		const message = typeof body.message === 'string' ? body.message.trim() : '';
		if (!company) {
			return new Response(
				JSON.stringify({
					ok: false,
					message: 'Company is required.',
					preview: {
						available: false,
						scores: {
							performance: null,
							seo: null,
							accessibility: null,
							bestPractices: null,
						},
						reviewError: 'Company is required.',
					},
					scan: {
						available: false,
						source: 'fallback',
						error: 'Company is required.',
					},
				}),
				{ status: 200 },
			);
		}

		if (!email) {
			return new Response(
				JSON.stringify({
					ok: false,
					message: 'Email is required.',
					preview: {
						available: false,
						scores: {
							performance: null,
							seo: null,
							accessibility: null,
							bestPractices: null,
						},
						reviewError: 'Email is required.',
					},
					scan: {
						available: false,
						source: 'fallback',
						error: 'Email is required.',
					},
				}),
				{ status: 200 },
			);
		}

		if (!isValidEmail(email)) {
			return new Response(
				JSON.stringify({
					ok: false,
					message: 'Invalid email address.',
					preview: {
						available: false,
						scores: {
							performance: null,
							seo: null,
							accessibility: null,
							bestPractices: null,
						},
						reviewError: 'Invalid email address.',
					},
					scan: {
						available: false,
						source: 'fallback',
						error: 'Invalid email address.',
					},
				}),
				{ status: 200 },
			);
		}

		const url = rawUrl ? normalizeUrl(rawUrl) : '';
		const displayUrl = rawUrl || url || 'N/A';
		const notionUrl = url;
		if (url) {
			try {
				new URL(url);
			} catch {
				return new Response(
					JSON.stringify({
						ok: false,
						message: 'Invalid URL.',
						preview: {
							available: false,
							scores: {
								performance: null,
								seo: null,
								accessibility: null,
								bestPractices: null,
							},
							reviewError: 'Invalid URL.',
						},
						scan: {
							available: false,
							source: 'fallback',
							error: 'Invalid URL.',
						},
					}),
					{ status: 200 },
				);
			}
			// DNS resolution check
			if (!(await isDomainResolvable(url))) {
				return new Response(
					JSON.stringify({
						ok: false,
						message: DOMAIN_NOT_FOUND_ERROR,
						preview: {
							available: false,
							scores: {
								performance: null,
								seo: null,
								accessibility: null,
								bestPractices: null,
							},
							reviewError: DOMAIN_NOT_FOUND_ERROR,
						},
						scan: {
							available: false,
							source: 'fallback',
							error: DOMAIN_NOT_FOUND_ERROR,
						},
					}),
					{ status: 200 },
				);
			}
		}

		// --- SCAN LOGIC (moved up to ensure all variables are set before integrations) ---
		review = null;
		let scanSource: 'lighthouse' | 'cache-fresh' | 'cache-stale' | 'fallback' = 'fallback';
		reviewError = '';
		liveScanError = '';
		forceUnavailablePreview = false;
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
					} catch (lhErr) {
						const lhMsg = lhErr instanceof Error ? lhErr.message : String(lhErr);
						// Extra logging for diagnostics
						console.error('[Lighthouse SCAN FAILURE]', {
							url,
							lhMsg,
							env: {
								NODE_ENV: getEnv('NODE_ENV') || 'unset',
								BASE_URL: getEnv('BASE_URL') || 'unset',
							},
							boundedReviewTimeoutMs,
							requestBudgetMs,
							startedAt: new Date(requestStartedAt).toISOString(),
							now: new Date().toISOString(),
						});
						throw lhErr;
					}
				}
			} catch (err) {
				console.error('Review failed:', err);
				const message = err instanceof Error ? err.message : String(err);
				liveScanError = message;
				reviewError = normalizeLiveScanErrorForUser(message);
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

		// Always build preview from latest review before integrations
		preview = buildReviewPreview(review, reviewError, forceUnavailablePreview);

		// Log Notion payload for debugging

		let notionError: string | null = null;
		try {
			await withTimeout(
				logSubmissionToNotion({
					company,
					email,
					url: displayUrl,
					phone,
					message,
					liveScanError,
					reportFilename,
					preview,
					review,
					reviewError,
					siteChecks,
				}),
				12000,
				'Notion sync',
			);
		} catch (err) {
			notionError = err instanceof Error ? err.message : String(err);
			const errorDetails = {
				type: 'notion',
				time: new Date().toISOString(),
				error: notionError,
				stack: err instanceof Error ? err.stack : undefined,
				payload: {
					company,
					email,
					url: displayUrl,
					phone,
					message,
					liveScanError,
					reportFilename,
					preview,
					review,
					reviewError,
					siteChecks,
				},
			};
			console.error('Notion sync failed:', errorDetails);
		}

		// Now perform email submission (after all variables are assigned)
		try {
			// Compose the email HTML (already defined above as html)
			const primaryRecipient = getEnv('CONTACT_TO') || 'hello@tradesadmin.ca';
			const fallbackRecipient = getEnv('SMTP_USER');
			// Setup nodemailer transporter (should be configured at top-level, but safe to re-use)
			const transporter = nodemailer.createTransport({
				host: getEnv('SMTP_HOST'),
				port: Number(getEnv('SMTP_PORT')) || 465,
				secure: true,
				auth: {
					user: getEnv('SMTP_USER'),
					pass: getEnv('SMTP_PASS'),
				},
			});
			await withTimeout(
				transporter.sendMail({
					from: getEnv('SMTP_FROM') || getEnv('SMTP_USER'),
					to: primaryRecipient,
					replyTo: email,
					subject: `New submission: ${company}`,
					html,
				}),
				25000,
				'SMTP send',
			);
			emailSent = true;
		} catch (err) {
			const primaryErr = err as { message?: string };
			const primaryMessage = primaryErr?.message || 'SMTP send failed.';
			const errorDetails = {
				type: 'email',
				time: new Date().toISOString(),
				error: primaryMessage,
				stack: err instanceof Error ? err.stack : undefined,
				payload: {
					company,
					email,
					url: displayUrl,
					phone,
					message,
					html,
				},
			};
			console.error('SMTP send failed:', errorDetails);

			const primaryRecipient = getEnv('CONTACT_TO') || 'hello@tradesadmin.ca';
			const fallbackRecipient = getEnv('SMTP_USER');
			const canRetryWithFallback = Boolean(fallbackRecipient && primaryRecipient && fallbackRecipient !== primaryRecipient);
			if (canRetryWithFallback) {
				try {
					// Setup nodemailer transporter again (safe to re-use)
					const transporter = nodemailer.createTransport({
						host: getEnv('SMTP_HOST'),
						port: Number(getEnv('SMTP_PORT')) || 465,
						secure: true,
						auth: {
							user: getEnv('SMTP_USER'),
							pass: getEnv('SMTP_PASS'),
						},
					});
					await withTimeout(
						transporter.sendMail({
							from: getEnv('SMTP_USER') || getEnv('SMTP_FROM'),
							to: fallbackRecipient,
							replyTo: email,
							subject: `New submission: ${company}`,
							html,
						}),
						25000,
						'SMTP send retry',
					);
					emailSent = true;
					emailError = '';
				} catch (retryErr) {
					const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
					emailError = `Primary send failed: ${primaryMessage}. Retry failed: ${retryMessage}`;
					const retryErrorDetails = {
						type: 'email-retry',
						time: new Date().toISOString(),
						error: retryMessage,
						stack: retryErr instanceof Error ? retryErr.stack : undefined,
						payload: {
							company,
							email,
							url: displayUrl,
							phone,
							message,
							html,
						},
					};
					console.error('SMTP send retry failed:', retryErrorDetails);
				}
			} else {
				emailError = primaryMessage;
			}
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
			'cache-fresh': 'Cached live result (fresh)',
			'cache-stale': 'Cached live result (stale fallback)',
			fallback: 'Fallback site checks only',
		};
		const displayLiveScanError = liveScanError ? (isDev ? liveScanError : normalizeLiveScanErrorForUser(liveScanError)) : '';

		html = `
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

		reportFilename = url ? `technical-review-${new URL(url).hostname}.pdf` : 'technical-review-request.pdf';
		preview = buildReviewPreview(review, reviewError, forceUnavailablePreview);
		// If the review or preview is missing a date, add a user-facing message
		let missingDateMessage = '';
		// Example: if review or preview should have a date property, check here (adjust as needed for your data structure)
		// if (!review?.date && !preview?.date) {
		//     missingDateMessage = 'No scan date was returned for this site. This may indicate a temporary scan issue or missing data.';
		// }
		// For now, if you want to check for a specific field, add the logic above and include the message below in the preview or response.
		if (missingDateMessage) {
			preview.reviewError = preview.reviewError ? `${preview.reviewError} ${missingDateMessage}` : missingDateMessage;
		}
		siteChecks = {
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
		let sheetsResponseText = null;
		let sheetsResponseError = null;
		try {
			// Build the API response object to send to Sheets
			const apiResponse = {
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
			};
			const nowIso = new Date().toISOString();
			// Log Sheets payload for debugging

			const sheetsResponse = await fetch('https://script.google.com/macros/s/AKfycbyys70cFFF9cBcXEnD47j3rSC8AEZ7JRaKOmeh2Ehg1rQOLQtYu7pAsk8smrHS3hV0n/exec', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					apiKey: getEnv('GS_API_KEY'),
					company,
					email,
					url: displayUrl.replace(/^https?:\/\//, ''),
					phone,
					message,
					performance: review?.performance ?? null,
					seo: review?.seo ?? null,
					accessibility: review?.accessibility ?? null,
					bestPractices: review?.bestPractices ?? null,
					apiResponse: JSON.stringify(apiResponse),
					timestamp: nowIso,
					date: nowIso, // Explicitly add a date field for Google Sheets
				}),
			});
			sheetsResponseText = await sheetsResponse.text();
		} catch (sheetErr) {
			sheetsResponseError = sheetErr instanceof Error ? sheetErr.message : String(sheetErr);
			console.error('Google Sheets submission failed:', sheetErr);
		}

		// Send email notification to hello@tradesadmin.ca (SMTP)
		// (Declarations moved to top)
		try {
			// Compose the email HTML (already defined above as html)
			const primaryRecipient = getEnv('CONTACT_TO') || 'hello@tradesadmin.ca';
			const fallbackRecipient = getEnv('SMTP_USER');
			// Setup nodemailer transporter (should be configured at top-level, but safe to re-use)
			const transporter = nodemailer.createTransport({
				host: getEnv('SMTP_HOST'),
				port: Number(getEnv('SMTP_PORT')) || 465,
				secure: true,
				auth: {
					user: getEnv('SMTP_USER'),
					pass: getEnv('SMTP_PASS'),
				},
			});
			await withTimeout(
				transporter.sendMail({
					from: getEnv('SMTP_FROM') || getEnv('SMTP_USER'),
					to: primaryRecipient,
					replyTo: email,
					subject: `New submission: ${company}`,
					html,
				}),
				25000,
				'SMTP send',
			);
			emailSent = true;
		} catch (err) {
			const primaryErr = err as { message?: string };
			const primaryMessage = primaryErr?.message || 'SMTP send failed.';
			const errorDetails = {
				type: 'email',
				time: new Date().toISOString(),
				error: primaryMessage,
				stack: err instanceof Error ? err.stack : undefined,
				payload: {
					company,
					email,
					url: displayUrl,
					phone,
					message,
					html,
				},
			};
			console.error('SMTP send failed:', errorDetails);

			const primaryRecipient = getEnv('CONTACT_TO') || 'hello@tradesadmin.ca';
			const fallbackRecipient = getEnv('SMTP_USER');
			const canRetryWithFallback = Boolean(fallbackRecipient && primaryRecipient && fallbackRecipient !== primaryRecipient);
			if (canRetryWithFallback) {
				try {
					// Setup nodemailer transporter again (safe to re-use)
					const transporter = nodemailer.createTransport({
						host: getEnv('SMTP_HOST'),
						port: Number(getEnv('SMTP_PORT')) || 465,
						secure: true,
						auth: {
							user: getEnv('SMTP_USER'),
							pass: getEnv('SMTP_PASS'),
						},
					});
					await withTimeout(
						transporter.sendMail({
							from: getEnv('SMTP_USER') || getEnv('SMTP_FROM'),
							to: fallbackRecipient,
							replyTo: email,
							subject: `New submission: ${company}`,
							html,
						}),
						25000,
						'SMTP send retry',
					);
					emailSent = true;
					emailError = '';
				} catch (retryErr) {
					const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
					emailError = `Primary send failed: ${primaryMessage}. Retry failed: ${retryMessage}`;
					const retryErrorDetails = {
						type: 'email-retry',
						time: new Date().toISOString(),
						error: retryMessage,
						stack: retryErr instanceof Error ? retryErr.stack : undefined,
						payload: {
							company,
							email,
							url: displayUrl,
							phone,
							message,
							html,
						},
					};
					console.error('SMTP send retry failed:', retryErrorDetails);
				}
			} else {
				emailError = primaryMessage;
			}
		}

		// Always return a minimal, clear JSON response, including all PSI API errors and Sheets/Notion response
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
				notionError: notionError,
				sheetsResponse: sheetsResponseText,
				sheetsResponseError,
				email: {
					sent: emailSent,
					error: emailError ? (isDev ? emailError : 'Unable to send your request email right now. Please contact us directly at hello@tradesadmin.ca.') : undefined,
				},
			}),
			{ status: 200 },
		);
	} catch (err) {
		const isDev = import.meta.env.DEV;
		const message = err instanceof Error ? err.message : String(err);
		const errorObj = err instanceof Error ? err : new Error(String(err));
		// Gather request context for diagnostics
		let requestBody = null;
		try {
			requestBody = await request.clone().text();
		} catch {}
		const envVars = {
			NODE_ENV: process.env.NODE_ENV,
			BASE_URL: process.env.BASE_URL,
			NOTION_API_KEY: process.env.NOTION_API_KEY ? 'set' : 'unset',
			NOTION_DATABASE_ID: process.env.NOTION_DATABASE_ID ? 'set' : 'unset',
			GS_API_KEY: process.env.GS_API_KEY ? 'set' : 'unset',
			SMTP_USER: process.env.SMTP_USER ? 'set' : 'unset',
			SMTP_HOST: process.env.SMTP_HOST ? 'set' : 'unset',
		};
		// Log everything for diagnostics
		console.error('[tech-review error]', {
			error: message,
			stack: errorObj.stack,
			requestHeaders: Object.fromEntries(request.headers.entries()),
			requestBody,
			envVars,
			timestamp: new Date().toISOString(),
		});
		// Always return a consistent error response for the frontend
		return new Response(
			JSON.stringify({
				ok: false,
				message: isDev ? `Lighthouse error: ${message}` : 'Live scan data is currently unavailable.',
				preview: {
					available: false,
					scores: {
						performance: null,
						seo: null,
						accessibility: null,
						bestPractices: null,
					},
					reviewError: 'Live scan data is currently unavailable.' + (isDev ? `\nLighthouse error: ${message}` : ''),
				},
				scan: {
					available: false,
					source: 'fallback',
					error: isDev ? `Lighthouse error: ${message}` : 'Live scan data is currently unavailable.',
				},
				diagnostics: isDev
					? {
							error: message,
							stack: errorObj.stack,
							requestHeaders: Object.fromEntries(request.headers.entries()),
							requestBody,
							envVars,
							timestamp: new Date().toISOString(),
					  }
					: undefined,
			}),
			{ status: 200 },
		);
	}
};
