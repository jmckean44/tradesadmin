import dns from 'dns/promises';
import tls from 'tls';

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
	vitals: {
		lcp: string;
		interactive: string;
		tbt: string;
		cls: string;
	};
	recommendedFixes: string[];
	reviewError?: string;
};

type ScanModuleKey = 'dns' | 'ssl' | 'forms' | 'links' | 'nap';

type ScanModuleResult = {
	status: 'ok' | 'warning' | 'error' | 'skipped';
	summary: string;
	issues: string[];
	metrics?: Record<string, string | number | boolean | null>;
	error?: string;
};

type ExtendedScanModules = Record<ScanModuleKey, ScanModuleResult>;

type ExtendedScanReport = {
	selected: ScanModuleKey[];
	modules: ExtendedScanModules;
	recommendedFixes: string[];
};

type BasicSiteChecks = {
	recommendedFixes: string[];
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
	extendedScan?: ExtendedScanReport;
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
const ALL_SCAN_MODULES: ScanModuleKey[] = ['dns', 'ssl', 'forms', 'links', 'nap'];

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

function normalizeScanModules(input: unknown): ScanModuleKey[] {
	const collectFromString = (value: string): string[] =>
		value
			.split(',')
			.map((item) => item.trim().toLowerCase())
			.filter(Boolean);

	const rawValues: string[] = Array.isArray(input)
		? input.filter((value): value is string => typeof value === 'string').flatMap((value) => collectFromString(value))
		: typeof input === 'string'
		? collectFromString(input)
		: [];

	const mapped = rawValues
		.map((value) => {
			if (value === 'dns') return 'dns';
			if (value === 'ssl') return 'ssl';
			if (value === 'forms') return 'forms';
			if (value === 'links') return 'links';
			if (value === 'nap') return 'nap';
			return null;
		})
		.filter((value): value is ScanModuleKey => Boolean(value));

	const unique = Array.from(new Set(mapped));
	return unique.length ? unique : [...ALL_SCAN_MODULES];
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

function firstNumber(value: string): number | null {
	const match = String(value || '').match(/[\d.]+/);
	if (!match) return null;
	const parsed = Number(match[0]);
	return Number.isFinite(parsed) ? parsed : null;
}

function hasAnyLiveScore(review: Review): boolean {
	return [review.performance, review.seo, review.accessibility, review.bestPractices].some((value) => typeof value === 'number' && Number.isFinite(value));
}

function normalizeReviewErrorForUser(message: string): string {
	const text = String(message || '');
	if (!text) return 'Live scan data is currently unavailable.';
	if (isLighthouseAssetErrorMessage(text)) return 'Live scan data is currently unavailable.';
	if (/429|rate limit|quota/i.test(text)) return 'Live scan data is temporarily unavailable due to scan capacity limits.';
	return text;
}

function normalizeLiveScanErrorForUser(message: string): string {
	const text = String(message || '');
	if (!text) return 'Live scan data is currently unavailable.';
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

	const setRichTextPropertyExact = (names: string[], value: string): boolean => {
		if (!value) return false;
		const key = findPropertyKeyByTypeExact(propertiesSchema, 'rich_text', names);
		if (!key) return false;
		properties[key] = { rich_text: buildNotionTextValue(value) };
		return true;
	};

	const setNumberProperty = (names: string[], value: number | null | undefined): void => {
		if (value == null || !Number.isFinite(value)) return;
		const key = findPropertyKeyByType(propertiesSchema, 'number', names);
		if (!key) return;
		properties[key] = { number: value };
	};

	const setCheckboxProperty = (names: string[], value: boolean): void => {
		const key = findPropertyKeyByType(propertiesSchema, 'checkbox', names);
		if (!key) return;
		properties[key] = { checkbox: value };
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

	setTextLikeProperty('rich_text', ['lcp'], input.preview.vitals.lcp || 'N/A');
	setTextLikeProperty('rich_text', ['interactive', 'tti'], input.preview.vitals.interactive || 'N/A');
	setTextLikeProperty('rich_text', ['tbt', 'total blocking time'], input.preview.vitals.tbt || 'N/A');
	setTextLikeProperty('rich_text', ['cls'], input.preview.vitals.cls || 'N/A');
	setTextLikeProperty('rich_text', ['ssl valid'], input.siteChecks.sslValid == null ? 'Unknown' : input.siteChecks.sslValid ? 'Yes' : 'No');
	setTextLikeProperty('rich_text', ['http status'], input.siteChecks.httpStatus == null ? '' : String(input.siteChecks.httpStatus));
	setTextLikeProperty('rich_text', ['dns found'], input.siteChecks.dnsFound == null ? 'Unknown' : input.siteChecks.dnsFound ? 'Yes' : 'No');
	setTextLikeProperty('rich_text', ['sitemap exists'], input.siteChecks.sitemapExists == null ? 'Unknown' : input.siteChecks.sitemapExists ? 'Yes' : 'No');
	setTextLikeProperty('rich_text', ['csp present'], input.siteChecks.cspPresent == null ? 'Unknown' : input.siteChecks.cspPresent ? 'Yes' : 'No');
	const notionErrorText = String(input.reviewError || input.preview.reviewError || input.liveScanError || input.siteChecks.error || '').trim();
	setTextLikeProperty('rich_text', ['review error', 'scan error', 'errors', 'error'], notionErrorText);
	setTextLikeProperty('rich_text', ['recommended fixes', 'fixes', 'recommendations'], (input.preview.recommendedFixes || []).join('\n'));
	setTextLikeProperty('rich_text', ['report', 'report filename', 'pdf'], input.reportFilename);

	const scanFailureReason = notionErrorText;
	const scanFailed = input.preview.available === false || Boolean(scanFailureReason);
	setCheckboxProperty(['scan failed', 'live scan failed', 'cwv failed'], scanFailed);
	if (scanFailed) {
		setTextLikeProperty('rich_text', ['scan failure reason', 'failure reason', 'scan fail reason'], scanFailureReason || 'Live scan data is currently unavailable.');
	}

	const moduleResults = input.extendedScan?.modules;
	if (moduleResults) {
		const moduleOrder: ScanModuleKey[] = ['dns', 'ssl', 'forms', 'links', 'nap'];
		const moduleLabel: Record<ScanModuleKey, string> = {
			dns: 'DNS',
			ssl: 'SSL',
			forms: 'Forms',
			links: 'Links',
			nap: 'NAP',
		};

		const moduleLines = moduleOrder
			.map((key) => {
				const result = moduleResults[key];
				if (!result || result.status === 'skipped') return '';
				const issues = Array.isArray(result.issues) && result.issues.length ? ` | Issues: ${result.issues.join(' ; ')}` : '';
				return `${moduleLabel[key]} (${result.status.toUpperCase()}): ${result.summary}${issues}`;
			})
			.filter(Boolean);

		if (moduleLines.length) {
			const moduleSummaryText = moduleLines.join('\n');
			const moduleSummaryFieldNames = ['extended scan modules', 'extended scan module', 'extended scan', 'scan modules', 'scan module', 'module results'];
			const wroteExactModuleSummary = setRichTextPropertyExact(moduleSummaryFieldNames, moduleSummaryText);
			if (!wroteExactModuleSummary) {
				setTextLikeProperty('rich_text', moduleSummaryFieldNames, moduleSummaryText);
			}
		}

		const setModuleProperty = (key: ScanModuleKey, names: string[]): void => {
			const result = moduleResults[key];
			if (!result || result.status === 'skipped') return;
			const issues = Array.isArray(result.issues) && result.issues.length ? ` | Issues: ${result.issues.join(' ; ')}` : '';
			setTextLikeProperty('rich_text', names, `${result.status.toUpperCase()}: ${result.summary}${issues}`);
		};

		setModuleProperty('dns', ['dns module', 'dns results']);
		setModuleProperty('ssl', ['ssl module', 'ssl results']);
		setModuleProperty('forms', ['forms module', 'forms results']);
		setModuleProperty('links', ['links module', 'links results']);
		setModuleProperty('nap', ['nap module', 'name address phone module', 'name address phone results']);
	}

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

async function runBasicSiteChecks(url: string): Promise<BasicSiteChecks> {
	const startedAt = Date.now();
	const response = await withTimeout(fetch(url, { redirect: 'follow' }), 15000, 'Basic site check');
	const durationMs = Date.now() - startedAt;

	const contentType = (response.headers.get('content-type') || '').toLowerCase();
	const cacheControl = (response.headers.get('cache-control') || '').toLowerCase();
	const html = contentType.includes('text/html') ? await response.text() : '';

	const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
	const titleText = titleMatch?.[1]?.trim() || '';
	const hasMetaDescription = /<meta[^>]+name=["']description["'][^>]*content=["'][^"']{20,}["']/i.test(html) || /<meta[^>]+content=["'][^"']{20,}["'][^>]+name=["']description["']/i.test(html);
	const h1Count = (html.match(/<h1\b/gi) || []).length;
	const hasCanonical = /<link[^>]+rel=["']canonical["']/i.test(html);
	const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
	const imageTags = html.match(/<img\b[^>]*>/gi) || [];
	const missingAltCount = imageTags.filter((tag) => !/\balt\s*=\s*["'][^"']*["']/i.test(tag)).length;
	const hasMixedContent = /^https:\/\//i.test(url) && /(src|href)=["']http:\/\//i.test(html);

	const fixes: string[] = [];

	if (!response.ok) fixes.push(`Your page returned an HTTP ${response.status} response. Fixing this should be the first priority.`);
	if (durationMs > 1500) fixes.push('Server response appears slow. Improve hosting performance, caching, and heavy plugin/script usage.');
	if (!titleText || titleText.length < 10) fixes.push('Add a clear page title so search results show your service and location properly.');
	if (!hasMetaDescription) fixes.push('Add a meta description to improve how your page appears in Google search snippets.');
	if (h1Count === 0) fixes.push('Add one clear H1 heading that describes the page service and location.');
	if (h1Count > 1) fixes.push('Use a single primary H1 heading and keep the rest as H2/H3 for cleaner page structure.');
	if (!hasCanonical) fixes.push('Add canonical tags to reduce duplicate-page confusion for search engines.');
	if (!hasViewport) fixes.push('Add a viewport meta tag to ensure proper mobile rendering and avoid usability issues.');
	if (missingAltCount > 0) fixes.push(`Add descriptive alt text to ${missingAltCount} image${missingAltCount === 1 ? '' : 's'} for accessibility and SEO.`);
	if (hasMixedContent) fixes.push('Remove HTTP asset links on HTTPS pages to prevent mixed-content warnings and blocked resources.');
	if (!cacheControl) fixes.push('Set cache-control headers for static assets to improve repeat-load speed.');

	if (!fixes.length) {
		fixes.push('Core technical foundations look healthy. Continue monitoring performance and indexing regularly.');
	}

	return { recommendedFixes: fixes.slice(0, 4) };
}

async function runSubmissionSiteChecks(url: string): Promise<NotionSubmissionInput['siteChecks']> {
	const result: NotionSubmissionInput['siteChecks'] = {
		sslValid: null,
		httpStatus: null,
		dnsFound: null,
		sitemapExists: null,
		cspPresent: null,
		error: '',
	};

	if (!url) return result;

	let hostname = '';
	try {
		hostname = new URL(normalizeUrl(url)).hostname;
	} catch {
		result.error = 'Invalid URL for site checks.';
		return result;
	}

	try {
		await dns.lookup(hostname);
		result.dnsFound = true;
	} catch {
		result.dnsFound = false;
	}

	try {
		const pageResponse = await withTimeout(fetch(normalizeUrl(url), { method: 'GET', redirect: 'follow' }), 15000, 'HTTP status check');
		result.httpStatus = pageResponse.status;
		result.cspPresent = Boolean(pageResponse.headers.get('content-security-policy'));

		let resolvedProtocol = '';
		try {
			resolvedProtocol = new URL(pageResponse.url || normalizeUrl(url)).protocol;
		} catch {
			resolvedProtocol = '';
		}

		result.sslValid = resolvedProtocol === 'https:';
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
	}

	try {
		const sitemapUrl = new URL('/sitemap.xml', normalizeUrl(url)).toString();
		let sitemapResponse = await withTimeout(fetch(sitemapUrl, { method: 'HEAD', redirect: 'follow' }), 10000, 'Sitemap check');

		if (sitemapResponse.status === 405) {
			sitemapResponse = await withTimeout(fetch(sitemapUrl, { method: 'GET', redirect: 'follow' }), 10000, 'Sitemap check fallback');
		}

		result.sitemapExists = sitemapResponse.ok;
	} catch {
		result.sitemapExists = false;
	}

	return result;
}

async function runDnsModule(url: string): Promise<ScanModuleResult> {
	const issues: string[] = [];
	try {
		const hostname = new URL(normalizeUrl(url)).hostname;
		const [aRecords, aaaaRecords, mxRecords, txtRecords, nsRecords] = await Promise.all([
			dns.resolve4(hostname).catch(() => [] as string[]),
			dns.resolve6(hostname).catch(() => [] as string[]),
			dns.resolveMx(hostname).catch(() => [] as Array<{ exchange: string; priority: number }>),
			dns.resolveTxt(hostname).catch(() => [] as string[][]),
			dns.resolveNs(hostname).catch(() => [] as string[]),
		]);

		if (!aRecords.length && !aaaaRecords.length) issues.push('No A/AAAA DNS records were found.');
		if (!mxRecords.length) issues.push('No MX records were found (email delivery may be misconfigured).');

		const flattenedTxt = txtRecords.flat().map((entry) => String(entry || '').toLowerCase());
		const hasSpf = flattenedTxt.some((entry) => entry.includes('v=spf1'));
		if (!hasSpf) issues.push('No SPF TXT record was detected.');

		const dmarcRecords = await dns.resolveTxt(`_dmarc.${hostname}`).catch(() => [] as string[][]);
		const hasDmarc = dmarcRecords.flat().some((entry) =>
			String(entry || '')
				.toLowerCase()
				.includes('v=dmarc1'),
		);
		if (!hasDmarc) issues.push('No DMARC record was detected.');

		const status: ScanModuleResult['status'] = issues.length ? 'warning' : 'ok';
		return {
			status,
			summary: issues.length ? 'DNS configuration has items to review.' : 'DNS configuration looks healthy.',
			issues: issues.slice(0, 4),
			metrics: {
				aRecords: aRecords.length,
				aaaaRecords: aaaaRecords.length,
				mxRecords: mxRecords.length,
				nsRecords: nsRecords.length,
				hasSpf,
				hasDmarc,
			},
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			status: 'error',
			summary: 'DNS checks could not complete.',
			issues: [],
			error: message,
		};
	}
}

async function runSslModule(url: string): Promise<ScanModuleResult> {
	try {
		const parsed = new URL(normalizeUrl(url));
		if (parsed.protocol !== 'https:') {
			return {
				status: 'warning',
				summary: 'Site is not using HTTPS by default.',
				issues: ['Primary URL is not HTTPS.'],
			};
		}

		const certInfo = await withTimeout(
			new Promise<{ validTo: string; issuer: string; protocol: string; cipher: string | null }>((resolve, reject) => {
				const socket = tls.connect(
					{
						host: parsed.hostname,
						port: Number(parsed.port || 443),
						servername: parsed.hostname,
						rejectUnauthorized: false,
					},
					() => {
						const cert = socket.getPeerCertificate();
						const protocol = socket.getProtocol() || 'unknown';
						const cipher = socket.getCipher()?.name || null;
						socket.end();
						if (!cert || !cert.valid_to) {
							reject(new Error('SSL certificate details unavailable.'));
							return;
						}
						const issuer = cert.issuer?.O || cert.issuer?.CN || 'Unknown issuer';
						resolve({ validTo: cert.valid_to, issuer, protocol, cipher });
					},
				);
				socket.on('error', (error) => reject(error));
			}),
			10000,
			'SSL check',
		);

		const expiryDate = new Date(certInfo.validTo);
		const daysRemaining = Number.isFinite(expiryDate.getTime()) ? Math.ceil((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null;
		const issues: string[] = [];

		if (daysRemaining != null && daysRemaining <= 21) {
			issues.push(`SSL certificate expires in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}.`);
		}
		if (certInfo.protocol.toUpperCase().includes('TLSV1') && !certInfo.protocol.toUpperCase().includes('1.3')) {
			issues.push('TLS protocol appears older than TLS 1.3.');
		}

		return {
			status: issues.length ? 'warning' : 'ok',
			summary: issues.length ? 'SSL is active with some risk signals.' : 'SSL certificate and protocol look healthy.',
			issues: issues.slice(0, 4),
			metrics: {
				issuer: certInfo.issuer,
				protocol: certInfo.protocol,
				cipher: certInfo.cipher,
				daysRemaining: daysRemaining ?? 'unknown',
			},
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			status: 'error',
			summary: 'SSL checks could not complete.',
			issues: [],
			error: message,
		};
	}
}

async function runFormsModule(url: string): Promise<ScanModuleResult> {
	try {
		const response = await withTimeout(fetch(normalizeUrl(url), { redirect: 'follow' }), 12000, 'Forms check');
		const html = await response.text();
		const forms = html.match(/<form\b[\s\S]*?<\/form>/gi) || [];
		if (!forms.length) {
			return {
				status: 'warning',
				summary: 'No forms detected on the scanned page.',
				issues: ['No <form> elements were found on the submitted URL.'],
			};
		}

		const issues: string[] = [];
		let formsMissingAction = 0;
		let formsWithoutSubmit = 0;
		let formsMissingMethod = 0;

		for (const formMarkup of forms) {
			const hasAction = /\baction\s*=\s*['"][^'"]+['"]/i.test(formMarkup);
			const hasMethod = /\bmethod\s*=\s*['"](post|get)['"]/i.test(formMarkup);
			const hasSubmit = /<button\b[^>]*type\s*=\s*['"]submit['"][^>]*>|<input\b[^>]*type\s*=\s*['"]submit['"][^>]*>/i.test(formMarkup);

			if (!hasAction) formsMissingAction += 1;
			if (!hasMethod) formsMissingMethod += 1;
			if (!hasSubmit) formsWithoutSubmit += 1;
		}

		if (formsMissingAction > 0) issues.push(`${formsMissingAction} form${formsMissingAction === 1 ? '' : 's'} missing explicit action URL.`);
		if (formsMissingMethod > 0) issues.push(`${formsMissingMethod} form${formsMissingMethod === 1 ? '' : 's'} missing explicit method attribute.`);
		if (formsWithoutSubmit > 0) issues.push(`${formsWithoutSubmit} form${formsWithoutSubmit === 1 ? '' : 's'} missing a submit control.`);

		return {
			status: issues.length ? 'warning' : 'ok',
			summary: issues.length ? 'Form setup has potential conversion risks.' : 'Form structure appears technically healthy.',
			issues: issues.slice(0, 4),
			metrics: {
				formCount: forms.length,
				formsMissingAction,
				formsMissingMethod,
				formsWithoutSubmit,
			},
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			status: 'error',
			summary: 'Form checks could not complete.',
			issues: [],
			error: message,
		};
	}
}

async function runLinksModule(url: string): Promise<ScanModuleResult> {
	try {
		const base = new URL(normalizeUrl(url));
		const response = await withTimeout(fetch(base.toString(), { redirect: 'follow' }), 12000, 'Links check');
		const html = await response.text();
		const hrefMatches = Array.from(html.matchAll(/<a\b[^>]*href\s*=\s*['"]([^'"]+)['"]/gi));
		const rawHrefs = hrefMatches
			.map((match) => (match[1] || '').trim())
			.filter((href) => href && !href.startsWith('#') && !href.startsWith('mailto:') && !href.startsWith('tel:') && !href.startsWith('javascript:'));

		const normalizedInternal = Array.from(
			new Set(
				rawHrefs
					.map((href) => {
						try {
							const absolute = new URL(href, base);
							if (absolute.hostname !== base.hostname) return '';
							absolute.hash = '';
							return absolute.toString();
						} catch {
							return '';
						}
					})
					.filter(Boolean),
			),
		).slice(0, 25);

		let brokenCount = 0;
		const issues: string[] = [];

		for (const link of normalizedInternal) {
			try {
				const linkResponse = await withTimeout(fetch(link, { method: 'HEAD', redirect: 'follow' }), 8000, 'Link check');
				if (linkResponse.status >= 400) {
					brokenCount += 1;
					if (issues.length < 4) issues.push(`Broken internal link detected: ${link} (${linkResponse.status}).`);
				}
			} catch {
				brokenCount += 1;
				if (issues.length < 4) issues.push(`Unreachable internal link detected: ${link}.`);
			}
		}

		return {
			status: brokenCount > 0 ? 'warning' : 'ok',
			summary: brokenCount > 0 ? 'Internal link health needs review.' : 'No broken internal links found in sampled pages.',
			issues,
			metrics: {
				internalLinksChecked: normalizedInternal.length,
				brokenLinks: brokenCount,
			},
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			status: 'error',
			summary: 'Link checks could not complete.',
			issues: [],
			error: message,
		};
	}
}

async function runNapModule(url: string): Promise<ScanModuleResult> {
	try {
		const response = await withTimeout(fetch(normalizeUrl(url), { redirect: 'follow' }), 12000, 'Name, Address, Phone check');
		const html = await response.text();
		const issues: string[] = [];

		const hasLocalBusinessSchema = /"@type"\s*:\s*"(LocalBusiness|Organization|ProfessionalService|HomeAndConstructionBusiness)"/i.test(html);
		const phoneMatches = Array.from(new Set((html.match(/\+?\d[\d\s().-]{8,}\d/g) || []).map((value) => value.replace(/\s+/g, ' ').trim())));
		const hasAddressSignals = /streetAddress|addressLocality|addressRegion|postalCode|addressCountry/i.test(html);

		if (!hasLocalBusinessSchema) issues.push('No local business schema markup detected.');
		if (!phoneMatches.length) issues.push('No visible phone number detected in page content/schema.');
		if (phoneMatches.length > 1) issues.push('Multiple phone number formats were detected. Normalize Name, Address, Phone details.');
		if (!hasAddressSignals) issues.push('No clear address signals detected for Name, Address, Phone consistency.');

		return {
			status: issues.length ? 'warning' : 'ok',
			summary: issues.length ? 'Name, Address, Phone consistency signals need improvement.' : 'Name, Address, Phone and local business signals look consistent.',
			issues: issues.slice(0, 4),
			metrics: {
				hasLocalBusinessSchema,
				phoneVariants: phoneMatches.length,
				hasAddressSignals,
			},
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			status: 'error',
			summary: 'Name, Address, Phone checks could not complete.',
			issues: [],
			error: message,
		};
	}
}

function getModuleFixes(moduleKey: ScanModuleKey, moduleResult: ScanModuleResult): string[] {
	if (moduleResult.status === 'skipped' || moduleResult.status === 'ok') return [];

	if (moduleResult.issues.length) return moduleResult.issues.slice(0, 2);

	if (moduleResult.error) {
		return [`${moduleKey.toUpperCase()} check failed during scanning: ${moduleResult.error}`];
	}

	return [];
}

async function runExtendedScanModules(url: string, selectedModules: ScanModuleKey[]): Promise<ExtendedScanReport> {
	const selectedSet = new Set(selectedModules);

	const baseSkipped: ScanModuleResult = {
		status: 'skipped',
		summary: 'Module was not selected for this run.',
		issues: [],
	};

	const modulePromises: Record<ScanModuleKey, Promise<ScanModuleResult>> = {
		dns: selectedSet.has('dns') ? runDnsModule(url) : Promise.resolve(baseSkipped),
		ssl: selectedSet.has('ssl') ? runSslModule(url) : Promise.resolve(baseSkipped),
		forms: selectedSet.has('forms') ? runFormsModule(url) : Promise.resolve(baseSkipped),
		links: selectedSet.has('links') ? runLinksModule(url) : Promise.resolve(baseSkipped),
		nap: selectedSet.has('nap') ? runNapModule(url) : Promise.resolve(baseSkipped),
	};

	const [dnsResult, sslResult, formsResult, linksResult, napResult] = await Promise.all([modulePromises.dns, modulePromises.ssl, modulePromises.forms, modulePromises.links, modulePromises.nap]);

	const modules: ExtendedScanModules = {
		dns: dnsResult,
		ssl: sslResult,
		forms: formsResult,
		links: linksResult,
		nap: napResult,
	};

	const moduleFixes = ALL_SCAN_MODULES.flatMap((moduleKey) => getModuleFixes(moduleKey, modules[moduleKey]));
	const recommendedFixes = Array.from(new Set(moduleFixes)).slice(0, 6);

	return {
		selected: selectedModules,
		modules,
		recommendedFixes,
	};
}

function buildReviewPreview(review: Review | null, reviewError: string, fallbackFixes: string[] = [], forceUnavailable = false): ReviewPreview {
	if (!review || forceUnavailable) {
		return {
			available: false,
			scores: {
				performance: null,
				seo: null,
				accessibility: null,
				bestPractices: null,
			},
			vitals: {
				lcp: 'N/A',
				interactive: 'N/A',
				tbt: 'N/A',
				cls: 'N/A',
			},
			recommendedFixes: fallbackFixes.length ? fallbackFixes : ['Run a full technical review with us and we will send a prioritized fix list.'],
			reviewError: reviewError || undefined,
		};
	}

	const lcpSeconds = firstNumber(review.lcp);
	const interactiveSeconds = firstNumber(review.interactive);
	const tbtMs = firstNumber(review.tbt);
	const clsValue = firstNumber(review.cls);

	const recommendedFixes: string[] = [];

	if ((review.performance ?? 100) < 80) recommendedFixes.push('Improve page speed by compressing large images, reducing third-party scripts, and enabling stronger caching.');
	if (lcpSeconds != null && lcpSeconds > 2.5) recommendedFixes.push('Reduce LCP by optimizing above-the-fold content and preloading your main hero image/font.');
	if (interactiveSeconds != null && interactiveSeconds > 5) recommendedFixes.push('Improve interactivity by deferring non-critical JavaScript and splitting heavy bundles.');
	if (tbtMs != null && tbtMs > 200) recommendedFixes.push('Lower Total Blocking Time by removing unused JavaScript and delaying long-running scripts.');
	if ((review.bestPractices ?? 100) < 90) recommendedFixes.push('Address best-practice issues like console errors, deprecated APIs, and insecure resource requests.');
	if (clsValue != null && clsValue > 0.1) recommendedFixes.push('Stabilize layout by reserving space for media/embeds and avoiding late-loading content shifts.');
	if ((review.seo ?? 100) < 90) recommendedFixes.push('Strengthen SEO signals by refining meta tags, headings, crawlability, and structured data.');

	if (!recommendedFixes.length) {
		recommendedFixes.push('Overall technical baseline is strong. Keep monitoring Core Web Vitals and plugin/script changes monthly.');
	}

	return {
		available: true,
		scores: {
			performance: review.performance,
			seo: review.seo,
			accessibility: review.accessibility,
			bestPractices: review.bestPractices,
		},
		vitals: {
			lcp: review.lcp,
			interactive: review.interactive,
			tbt: review.tbt,
			cls: review.cls,
		},
		recommendedFixes: recommendedFixes.slice(0, 4),
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

async function runReview(url: string): Promise<ReviewRunResult> {
	async function runReviewWithPageSpeedInsights(targetUrl: string): Promise<ReviewRunResult> {
		// Debug log for API responses
		function logPageSpeedApiResponse(strategy: string, responsePayload: any) {
			try {
				console.log(`[PageSpeed API][${strategy}] Response:`, JSON.stringify(responsePayload, null, 2));
			} catch (err) {
				console.log(`[PageSpeed API][${strategy}] Response (raw):`, responsePayload);
			}
		}
		async function requestPageSpeed(strategy: 'mobile' | 'desktop'): Promise<ReviewRunResult> {
			const pageSpeedApiKey = getPageSpeedApiKeyIfUsable();

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

						logPageSpeedApiResponse(strategy, payload);

						if (!payload.lighthouseResult) throw new Error('PageSpeed response missing lighthouseResult');
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
					const hasMetrics =
						result &&
						result.review &&
						(typeof result.review.performance === 'number' ||
							typeof result.review.seo === 'number' ||
							typeof result.review.accessibility === 'number' ||
							typeof result.review.bestPractices === 'number');
					if (!hasMetrics) {
						// Retry without API key
						const retryResult = await executePageSpeedRequest(false, 'full');
						// If retry yields more metrics, use it
						const retryHasMetrics =
							retryResult &&
							retryResult.review &&
							(typeof retryResult.review.performance === 'number' ||
								typeof retryResult.review.seo === 'number' ||
								typeof retryResult.review.accessibility === 'number' ||
								typeof retryResult.review.bestPractices === 'number');
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
		if (hasAnyLiveScore(mobileResult.review)) return mobileResult;

		const desktopResult = await requestPageSpeed('desktop');
		if (hasAnyLiveScore(desktopResult.review)) return desktopResult;

		return desktopResult;
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
		const extendedModulesTimeoutMs = isDev ? 12000 : 3000;
		const smtpVerifyTimeoutMs = isDev ? 10000 : 3000;
		const siteChecksTimeoutMs = isDev ? 8000 : 2500;
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
		const selectedModules = normalizeScanModules(body.scanModules);

		if (!company) {
			return new Response(JSON.stringify({ error: 'Company is required.' }), { status: 400 });
		}

		if (email && !isValidEmail(email)) {
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

		const transporter = nodemailer.createTransport({
			host: getEnv('SMTP_HOST'),
			port: getEnv('SMTP_PORT') ? parseInt(getEnv('SMTP_PORT'), 10) : 587,
			secure: getEnv('SMTP_SECURE') === 'true',
			connectionTimeout: 15000,
			greetingTimeout: 15000,
			socketTimeout: 20000,
			auth: {
				user: getEnv('SMTP_USER'),
				pass: getEnv('SMTP_PASS'),
			},
		});

		if (hasTimeBudget(4500)) {
			try {
				await withTimeout(transporter.verify(), smtpVerifyTimeoutMs, 'SMTP verify');
			} catch (err) {
				console.warn('SMTP verify skipped due to timeout/error:', err);
			}
		}

		let review: Review | null = null;
		let scanSource: 'lighthouse' | 'pagespeed-key' | 'pagespeed-no-key' | 'cache-fresh' | 'cache-stale' | 'fallback' = 'fallback';
		let reviewError = '';
		let liveScanError = '';
		let fallbackFixes: string[] = [];
		let extendedScan: ExtendedScanReport = {
			selected: selectedModules,
			modules: {
				dns: { status: 'skipped', summary: 'Module was not selected for this run.', issues: [] },
				ssl: { status: 'skipped', summary: 'Module was not selected for this run.', issues: [] },
				forms: { status: 'skipped', summary: 'Module was not selected for this run.', issues: [] },
				links: { status: 'skipped', summary: 'Module was not selected for this run.', issues: [] },
				nap: { status: 'skipped', summary: 'Module was not selected for this run.', issues: [] },
			},
			recommendedFixes: [],
		};
		let forceUnavailablePreview = false;
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
					const runResult = await withTimeout(runReview(url), boundedReviewTimeoutMs, 'Lighthouse review');
					review = runResult.review;
					scanSource = runResult.source;
					setCachedReview(url, review);
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
				try {
					const basicChecks = await runBasicSiteChecks(url);
					fallbackFixes = basicChecks.recommendedFixes;
				} catch (basicErr) {
					console.error('Basic site checks failed:', basicErr);
				}
			}

			if (review && !hasAnyLiveScore(review)) {
				forceUnavailablePreview = true;
				scanSource = 'fallback';
				reviewError = reviewError || 'Live scan data is currently unavailable.';
				liveScanError = liveScanError || reviewError;

				if (!fallbackFixes.length) {
					try {
						const basicChecks = await runBasicSiteChecks(url);
						fallbackFixes = basicChecks.recommendedFixes;
					} catch (basicErr) {
						console.error('Basic site checks failed:', basicErr);
					}
				}
			}

			if (!review) {
				scanSource = 'fallback';
			}

			if (hasTimeBudget(2500)) {
				try {
					extendedScan = await withTimeout(runExtendedScanModules(url, selectedModules), extendedModulesTimeoutMs, 'Extended module checks');
				} catch (moduleErr) {
					console.error('Extended module checks failed:', moduleErr);
				}
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
		const preview = buildReviewPreview(review, reviewError, Array.from(new Set([...fallbackFixes, ...extendedScan.recommendedFixes])).slice(0, 6), forceUnavailablePreview);
		let siteChecks: NotionSubmissionInput['siteChecks'] = {
			sslValid: null,
			httpStatus: null,
			dnsFound: null,
			sitemapExists: null,
			cspPresent: null,
			error: '',
		};
		if (hasTimeBudget(2000)) {
			try {
				siteChecks = await withTimeout(runSubmissionSiteChecks(url), siteChecksTimeoutMs, 'Submission site checks');
			} catch (siteCheckErr) {
				console.warn('Submission site checks skipped due to timeout/error:', siteCheckErr);
				siteChecks.error = 'Submission site checks timed out.';
			}
		} else {
			siteChecks.error = 'Skipped due to request time budget.';
		}
		const pageSpeedApiKeyConfigured = Boolean(getEnv('PAGESPEED_API_KEY'));
		const notionConfigured = Boolean(getEnv('NOTION_DATABASE_ID') && (getEnv('NOTION_API_KEY') || getEnv('NOTION_TOKEN')));
		let notionSynced = false;
		let notionError = '';
		let emailSent = false;
		let emailError = '';

		if (hasTimeBudget(1200)) {
			try {
				await withTimeout(
					logSubmissionToNotion({
						company,
						email,
						url: notionUrl,
						phone,
						message,
						liveScanError,
						reportFilename,
						preview,
						review,
						extendedScan,
						reviewError,
						siteChecks,
					}),
					notionSyncTimeoutMs,
					'Notion sync',
				);
				notionSynced = true;
			} catch (notionErr) {
				console.error('Notion sync failed:', notionErr);
				notionError = notionErr instanceof Error ? notionErr.message : String(notionErr);
			}
		} else if (notionConfigured) {
			notionError = 'Notion sync skipped due to request time budget.';
		}

		if (hasTimeBudget(500)) {
			try {
				const primaryRecipient = getEnv('CONTACT_TO') || getEnv('SMTP_USER');
				const fallbackRecipient = getEnv('SMTP_USER');

				await withTimeout(
					transporter.sendMail({
						from: getEnv('SMTP_FROM') || getEnv('SMTP_USER'),
						to: primaryRecipient,
						replyTo: email,
						subject: `New submission: ${company}`,
						html,
					}),
					smtpSendTimeoutMs,
					'SMTP send',
				);
				emailSent = true;
			} catch (err) {
				const primaryErr = err as { message?: string };
				const primaryMessage = primaryErr?.message || 'SMTP send failed.';
				console.error('SMTP send failed:', err);

				const primaryRecipient = getEnv('CONTACT_TO') || getEnv('SMTP_USER');
				const fallbackRecipient = getEnv('SMTP_USER');
				const canRetryWithFallback = Boolean(fallbackRecipient && primaryRecipient && fallbackRecipient !== primaryRecipient);

				if (canRetryWithFallback && hasTimeBudget(300)) {
					try {
						await withTimeout(
							transporter.sendMail({
								from: getEnv('SMTP_USER') || getEnv('SMTP_FROM'),
								to: fallbackRecipient,
								replyTo: email,
								subject: `New submission: ${company}`,
								html,
							}),
							smtpSendTimeoutMs,
							'SMTP send retry',
						);
						emailSent = true;
						emailError = '';
					} catch (retryErr) {
						const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
						emailError = `Primary send failed: ${primaryMessage}. Retry failed: ${retryMessage}`;
						console.error('SMTP send retry failed:', retryErr);
					}
				} else {
					emailError = primaryMessage;
				}
			}
		} else {
			emailError = 'Email send skipped due to request time budget.';
		}

		const userMessage = notionConfigured && notionSynced ? 'Submitted successfully.' : emailSent ? 'Submitted successfully.' : 'Submitted successfully, but confirmation email could not be sent.';

		return new Response(
			JSON.stringify({
				ok: true,
				message: userMessage,
				preview,
				scan: {
					available: preview.available === true,
					source: scanSource,
					selectedModules: extendedScan.selected,
					modules: extendedScan.modules,
					pageSpeedApiKeyConfigured,
					error: liveScanError ? (isDev ? liveScanError : normalizeLiveScanErrorForUser(liveScanError)) : undefined,
				},
				email: {
					sent: emailSent,
					error: emailError ? (isDev ? emailError : 'Unable to send your request email right now. Please contact us directly at hello@tradesadmin.ca.') : undefined,
				},
				notion: {
					configured: notionConfigured,
					synced: notionConfigured ? notionSynced : false,
					error: notionError ? (isDev ? notionError : normalizeNotionErrorForUser(notionError)) : undefined,
				},
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
					vitals: {
						lcp: 'N/A',
						interactive: 'N/A',
						tbt: 'N/A',
						cls: 'N/A',
					},
					recommendedFixes: ['Live scan data is currently unavailable. Please try again shortly.'],
					reviewError: 'Live scan data is currently unavailable.',
				},
				scan: {
					available: false,
					source: 'fallback',
					selectedModules: [],
					modules: {},
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
