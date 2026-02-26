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

type BasicSiteChecks = {
	recommendedFixes: string[];
};

type CachedReview = {
	review: Review;
	expiresAt: number;
};

type NotionPropertyType = 'title' | 'rich_text' | 'email' | 'url' | 'phone_number' | 'number' | 'checkbox' | 'date';

type NotionDatabaseProperty = {
	id: string;
	name: string;
	type: string;
};

type NotionDatabaseSchemaResponse = {
	properties?: Record<string, NotionDatabaseProperty>;
};

type NotionSubmissionInput = {
	company: string;
	email: string;
	url: string;
	phone: string;
	message: string;
	reportFilename: string;
	preview: ReviewPreview;
	review: Review | null;
	reviewError: string;
};

const REVIEW_CACHE_TTL_MS_DEFAULT = 6 * 60 * 60 * 1000;
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

async function getNotionDatabaseProperties(token: string, databaseId: string): Promise<Record<string, NotionDatabaseProperty>> {
	const response = await withTimeout(fetch(`https://api.notion.com/v1/databases/${databaseId}`, { headers: getNotionHeaders(token) }), 12000, 'Notion database lookup');

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(`Notion database lookup failed (${response.status}) ${body}`.trim());
	}

	const data = (await response.json()) as NotionDatabaseSchemaResponse;
	return data.properties ?? {};
}

async function logSubmissionToNotion(input: NotionSubmissionInput): Promise<void> {
	const notionToken = getEnv('NOTION_API_KEY') || getEnv('NOTION_TOKEN');
	const notionDatabaseId = getEnv('NOTION_DATABASE_ID');
	if (!notionToken || !notionDatabaseId) return;

	const propertiesSchema = await getNotionDatabaseProperties(notionToken, notionDatabaseId);
	const properties: Record<string, unknown> = {};

	const titleKey = findPropertyKeyByType(propertiesSchema, 'title');
	if (!titleKey) throw new Error('Notion database has no title property.');

	const urlHost = input.url
		? (() => {
				try {
					return new URL(input.url).hostname;
				} catch {
					return input.url;
				}
		  })()
		: 'No URL';
	const titleValue = `${input.company} — ${urlHost}`;
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
			properties[key] = { url: stripUrlProtocol(value) };
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

	setTextLikeProperty('email', ['email', 'e-mail'], input.email);
	setTextLikeProperty('rich_text', ['url', 'website', 'site', 'domain'], stripUrlProtocol(input.url));
	setTextLikeProperty('phone_number', ['phone', 'telephone'], input.phone);
	setTextLikeProperty('rich_text', ['message', 'details', 'comments', 'notes'], input.message);

	const statusKey = findPropertyKeyByType(propertiesSchema, 'checkbox', ['scan available', 'available', 'has live data']);
	if (statusKey) properties[statusKey] = { checkbox: input.preview.available === true };

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
	setTextLikeProperty('rich_text', ['review error', 'scan error', 'error'], input.reviewError || input.preview.reviewError || '');
	setTextLikeProperty('rich_text', ['recommended fixes', 'fixes', 'recommendations'], (input.preview.recommendedFixes || []).join('\n'));
	setTextLikeProperty('rich_text', ['report', 'report filename', 'pdf'], input.reportFilename);

	const response = await withTimeout(
		fetch('https://api.notion.com/v1/pages', {
			method: 'POST',
			headers: getNotionHeaders(notionToken),
			body: JSON.stringify({
				parent: { database_id: notionDatabaseId },
				properties,
			}),
		}),
		12000,
		'Notion page create',
	);

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(`Notion page create failed (${response.status}) ${body}`.trim());
	}
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

	const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: form.toString(),
	});

	if (!resp.ok) {
		return {
			success: false,
			errorCodes: ['siteverify-http-error'],
		};
	}

	const data = (await resp.json()) as TurnstileVerifyResponse;

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

async function runReview(url: string): Promise<Review> {
	async function runReviewWithPageSpeedInsights(targetUrl: string): Promise<Review> {
		async function requestPageSpeed(strategy: 'mobile' | 'desktop'): Promise<Review> {
			const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
			endpoint.searchParams.set('url', targetUrl);
			endpoint.searchParams.set('category', 'performance');
			endpoint.searchParams.append('category', 'seo');
			endpoint.searchParams.append('category', 'accessibility');
			endpoint.searchParams.append('category', 'best-practices');
			endpoint.searchParams.set('strategy', strategy);

			const pageSpeedApiKey = getEnv('PAGESPEED_API_KEY') || getEnv('GOOGLE_PAGESPEED_API_KEY');
			if (pageSpeedApiKey) endpoint.searchParams.set('key', pageSpeedApiKey);

			const response = await withTimeout(fetch(endpoint.toString()), 30000, 'PageSpeed API request');
			if (!response.ok) throw new Error(`PageSpeed API failed (${response.status})`);

			const payload = (await response.json()) as {
				lighthouseResult?: {
					categories?: Record<string, { score?: number | null }>;
					audits?: Record<string, { displayValue?: string }>;
				};
			};

			if (!payload.lighthouseResult) throw new Error('PageSpeed response missing lighthouseResult');
			return reviewFromLhrLike(payload.lighthouseResult);
		}

		const mobileReview = await requestPageSpeed('mobile');
		if (hasAnyLiveScore(mobileReview)) return mobileReview;

		const desktopReview = await requestPageSpeed('desktop');
		if (hasAnyLiveScore(desktopReview)) return desktopReview;

		return desktopReview;
	}

	let chrome: { port: number; kill: () => void | Promise<void> } | undefined;

	try {
		const [{ default: lighthouse }, { launch }] = await Promise.all([import('lighthouse'), import('chrome-launcher')]);

		chrome = await launch({ chromeFlags: ['--headless', '--no-sandbox'] });
		const chromePort = chrome.port;

		const runnerResult = await lighthouse(url, {
			port: chromePort,
			output: 'json',
			logLevel: 'error',
			onlyCategories: ['performance', 'seo', 'accessibility', 'best-practices'],
		});

		if (!runnerResult?.lhr) throw new Error('Lighthouse returned no report');

		return reviewFromLhrLike(runnerResult.lhr);
	} catch (err) {
		const lighthouseMessage = err instanceof Error ? err.message : String(err);

		try {
			return await runReviewWithPageSpeedInsights(url);
		} catch (fallbackErr) {
			const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
			throw new Error(`Lighthouse failed: ${lighthouseMessage}. PageSpeed fallback failed: ${fallbackMessage}`);
		}
	} finally {
		if (chrome) await chrome.kill();
	}
}

export const GET: APIRoute = async () => {
	return new Response(JSON.stringify({ ok: true, route: '/api/tech-review/' }), { status: 200 });
};

export const POST: APIRoute = async ({ request }) => {
	try {
		const isDev = import.meta.env.DEV;
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

		if (!company || !email) {
			return new Response(JSON.stringify({ error: 'Company and email are required.' }), { status: 400 });
		}

		if (!isValidEmail(email)) {
			return new Response(JSON.stringify({ error: 'Invalid email address.' }), { status: 400 });
		}

		const url = rawUrl ? normalizeUrl(rawUrl) : '';
		const displayUrl = rawUrl || url || 'N/A';
		const notionUrl = rawUrl || url;
		if (url) {
			try {
				new URL(url);
			} catch {
				return new Response(JSON.stringify({ error: 'Invalid URL.' }), { status: 400 });
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

		try {
			await withTimeout(transporter.verify(), 10000, 'SMTP verify');
		} catch (err) {
			const smtpErr = err as { code?: string; responseCode?: number; message?: string };
			return new Response(
				JSON.stringify(
					isDev
						? {
								error: 'SMTP authentication/config failed.',
								smtp: {
									code: smtpErr?.code,
									responseCode: smtpErr?.responseCode,
									message: smtpErr?.message,
								},
						  }
						: { error: 'Unable to send your request email right now. Please contact us directly at hello@tradesadmin.ca.' },
				),
				{ status: 500 },
			);
		}

		let review: Review | null = null;
		let reviewError = '';
		let fallbackFixes: string[] = [];
		let forceUnavailablePreview = false;
		if (!url) {
			reviewError = 'No URL provided.';
		} else {
			try {
				const cachedReview = getCachedReview(url);
				if (cachedReview) {
					review = cachedReview;
				} else {
					review = await withTimeout(runReview(url), 60000, 'Lighthouse review');
					setCachedReview(url, review);
				}
			} catch (err) {
				console.error('Review failed:', err);
				const message = err instanceof Error ? err.message : String(err);
				reviewError = normalizeReviewErrorForUser(message);
				try {
					const basicChecks = await runBasicSiteChecks(url);
					fallbackFixes = basicChecks.recommendedFixes;
				} catch (basicErr) {
					console.error('Basic site checks failed:', basicErr);
				}
			}

			if (review && !hasAnyLiveScore(review)) {
				forceUnavailablePreview = true;
				reviewError = reviewError || 'Live scan data is currently unavailable.';

				if (!fallbackFixes.length) {
					try {
						const basicChecks = await runBasicSiteChecks(url);
						fallbackFixes = basicChecks.recommendedFixes;
					} catch (basicErr) {
						console.error('Basic site checks failed:', basicErr);
					}
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

		const html = `
            <h2>New Contact Submission</h2>
            <ul>
                <li><strong>Company:</strong> ${escapeHtml(company)}</li>
                <li><strong>Email:</strong> ${escapeHtml(email)}</li>
				<li><strong>URL:</strong> ${escapeHtml(displayUrl)}</li>
                ${phone ? `<li><strong>Phone:</strong> ${escapeHtml(phone)}</li>` : ''}
                ${message ? `<li><strong>Message:</strong> ${escapeHtml(message)}</li>` : ''}
            </ul>
            <hr />
            ${reviewHtml}
        `;

		const reportFilename = url ? `technical-review-${new URL(url).hostname}.pdf` : 'technical-review-request.pdf';
		const preview = buildReviewPreview(review, reviewError, fallbackFixes, forceUnavailablePreview);
		const notionConfigured = Boolean(getEnv('NOTION_DATABASE_ID') && (getEnv('NOTION_API_KEY') || getEnv('NOTION_TOKEN')));
		let notionSynced = false;
		let notionError = '';

		try {
			await logSubmissionToNotion({
				company,
				email,
				url: notionUrl,
				phone,
				message,
				reportFilename,
				preview,
				review,
				reviewError,
			});
			notionSynced = true;
		} catch (notionErr) {
			console.error('Notion sync failed:', notionErr);
			notionError = notionErr instanceof Error ? notionErr.message : String(notionErr);
		}

		await withTimeout(
			transporter.sendMail({
				from: getEnv('SMTP_FROM') || getEnv('SMTP_USER'),
				to: getEnv('CONTACT_TO') || getEnv('SMTP_USER'),
				replyTo: email,
				subject: `New submission: ${company}`,
				html,
			}),
			25000,
			'SMTP send',
		);

		return new Response(
			JSON.stringify({
				ok: true,
				message: 'Submitted successfully.',
				preview,
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
		return new Response(JSON.stringify({ error: 'Unexpected server error while processing your request.' }), { status: 500 });
	}
};
