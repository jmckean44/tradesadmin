import type { APIRoute } from 'astro';
import nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';

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

function getEnv(name: string): string {
	const value = (import.meta.env[name] ?? process.env[name] ?? '') as string;
	return String(value).trim();
}

function normalizeUrl(input: string): string {
	const value = (input || '').trim();
	if (!value) return '';
	return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function pct(score: number | null | undefined): number | null {
	return score == null ? null : Math.round(score * 100);
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

function buildReviewPreview(review: Review | null, reviewError: string): ReviewPreview {
	if (!review) {
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
			recommendedFixes: ['Run a full technical review with us and we will send a prioritized fix list.'],
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
	const [{ default: lighthouse }, { launch }] = await Promise.all([import('lighthouse'), import('chrome-launcher')]);
	let chrome: { port: number; kill: () => void | Promise<void> } | undefined;

	try {
		chrome = await launch({ chromeFlags: ['--headless', '--no-sandbox'] });
		const chromePort = chrome.port;

		const runnerResult = await lighthouse(url, {
			port: chromePort,
			output: 'json',
			logLevel: 'error',
			onlyCategories: ['performance', 'seo', 'accessibility', 'best-practices'],
		});

		if (!runnerResult?.lhr) throw new Error('Lighthouse returned no report');

		const { categories, audits } = runnerResult.lhr;
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
	} finally {
		if (chrome) await chrome.kill();
	}
}

function buildReviewPdfBuffer(input: { company: string; email: string; url: string; phone: string; message: string; review: Review | null; reviewError?: string }): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const doc = new PDFDocument({ margin: 40 });
		const chunks: Uint8Array[] = [];

		doc.on('data', (chunk: Buffer) => {
			chunks.push(Uint8Array.from(chunk));
		});
		doc.on('end', () => resolve(Buffer.concat(chunks)));
		doc.on('error', reject);

		doc.fontSize(18).text('Technical Review', { underline: true });
		doc.moveDown();

		doc.fontSize(12).text(`Company: ${input.company}`);
		doc.text(`Email: ${input.email}`);
		doc.text(`URL: ${input.url}`);
		if (input.phone) doc.text(`Phone: ${input.phone}`);
		if (input.message) doc.text(`Message: ${input.message}`);

		doc.moveDown();
		doc.fontSize(14).text('Review Results', { underline: true });
		doc.moveDown(0.5);

		if (!input.review) {
			doc.fontSize(12).text('Technical review unavailable.');
			if (input.reviewError) {
				doc.moveDown(0.5);
				doc.fontSize(10).text(`Reason: ${input.reviewError}`);
			}
		} else {
			doc.fontSize(12).text(`Performance: ${input.review.performance ?? 'N/A'}`);
			doc.text(`SEO: ${input.review.seo ?? 'N/A'}`);
			doc.text(`Accessibility: ${input.review.accessibility ?? 'N/A'}`);
			doc.text(`Best Practices: ${input.review.bestPractices ?? 'N/A'}`);
			doc.text(`LCP: ${input.review.lcp}`);
			doc.text(`CLS: ${input.review.cls}`);
			doc.text(`Interactive: ${input.review.interactive}`);
			doc.text(`Total Blocking Time: ${input.review.tbt}`);
		}

		doc.end();
	});
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

		if (!company || !email || !rawUrl) {
			return new Response(JSON.stringify({ error: 'Company, email, and URL are required.' }), { status: 400 });
		}

		const url = normalizeUrl(rawUrl);
		try {
			new URL(url);
		} catch {
			return new Response(JSON.stringify({ error: 'Invalid URL.' }), { status: 400 });
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
						: { error: 'Failed to submit.' },
				),
				{ status: 500 },
			);
		}

		let review: Review | null = null;
		let reviewError = '';
		try {
			review = await withTimeout(runReview(url), 60000, 'Lighthouse review');
		} catch (err) {
			console.error('Review failed:', err);
			reviewError = err instanceof Error ? err.message : 'Unknown Lighthouse error';
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
                <li><strong>URL:</strong> ${escapeHtml(url)}</li>
                ${phone ? `<li><strong>Phone:</strong> ${escapeHtml(phone)}</li>` : ''}
                ${message ? `<li><strong>Message:</strong> ${escapeHtml(message)}</li>` : ''}
            </ul>
            <hr />
            ${reviewHtml}
        `;

		const pdfBuffer = await buildReviewPdfBuffer({
			company,
			email,
			url,
			phone,
			message,
			review,
			reviewError,
		});
		const reportFilename = `technical-review-${new URL(url).hostname}.pdf`;

		await withTimeout(
			transporter.sendMail({
				from: getEnv('SMTP_FROM') || getEnv('SMTP_USER'),
				to: getEnv('CONTACT_TO') || getEnv('SMTP_USER'),
				replyTo: email,
				subject: `New submission: ${company}`,
				html,
				attachments: [
					{
						filename: reportFilename,
						content: pdfBuffer,
						contentType: 'application/pdf',
					},
				],
			}),
			25000,
			'SMTP send',
		);

		return new Response(
			JSON.stringify({
				ok: true,
				message: 'Submitted successfully.',
				preview: buildReviewPreview(review, reviewError),
				report: {
					filename: reportFilename,
					mimeType: 'application/pdf',
					contentBase64: pdfBuffer.toString('base64'),
				},
			}),
			{ status: 200 },
		);
	} catch (err) {
		console.error('tech-review route error:', err);
		return new Response(JSON.stringify({ error: 'Failed to submit.' }), { status: 500 });
	}
};
