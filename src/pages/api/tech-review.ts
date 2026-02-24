import type { APIRoute } from 'astro';
import lighthouse from 'lighthouse';
import { launch } from 'chrome-launcher';
import nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';

type RecaptchaVerifyResponse = {
	success: boolean;
	challenge_ts?: string;
	hostname?: string;
	'error-codes'?: string[];
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

async function verifyRecaptchaToken(token: string, remoteIp?: string): Promise<boolean> {
	const secret = process.env.RECAPTCHA_SECRET_KEY;
	if (!secret || !token) return false;

	const params = new URLSearchParams();
	params.append('secret', secret);
	params.append('response', token);
	if (remoteIp) params.append('remoteip', remoteIp);

	const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: params.toString(),
	});

	if (!resp.ok) return false;
	const data = (await resp.json()) as RecaptchaVerifyResponse;
	return data.success === true;
}

async function runReview(url: string): Promise<Review> {
	let chrome: Awaited<ReturnType<typeof launch>> | undefined;

	try {
		chrome = await launch({ chromeFlags: ['--headless', '--no-sandbox'] });
		const runnerResult = await lighthouse(url, {
			port: chrome.port,
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

function buildReviewPdfBuffer(input: { company: string; email: string; url: string; phone: string; message: string; review: Review | null }): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const doc = new PDFDocument({ margin: 40 });
		const chunks: Uint8Array[] = [];

		doc.on('data', (chunk: Uint8Array) => chunks.push(chunk));
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
		const body = await request.json().catch(() => ({} as Record<string, unknown>));

		const recaptchaToken = (typeof body.recaptchaToken === 'string' && body.recaptchaToken.trim()) || (typeof body['g-recaptcha-response'] === 'string' && body['g-recaptcha-response'].trim()) || '';

		const forwardedFor = request.headers.get('x-forwarded-for') || '';
		const remoteIp = forwardedFor.split(',')[0]?.trim() || undefined;

		const isHuman = await verifyRecaptchaToken(recaptchaToken, remoteIp);
		if (!isHuman) {
			return new Response(JSON.stringify({ error: 'Invalid reCAPTCHA.' }), { status: 400 });
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

		let review: Review | null = null;
		try {
			review = await runReview(url);
		} catch (err) {
			console.error('Review failed:', err);
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
			: `<h3 style="margin:16px 0 8px;">Technical Review</h3><p>Technical review unavailable.</p>`;

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
		});

		const transporter = nodemailer.createTransport({
			host: process.env.SMTP_HOST,
			port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587,
			secure: process.env.SMTP_SECURE === 'true',
			auth: {
				user: process.env.SMTP_USER,
				pass: process.env.SMTP_PASS,
			},
		});

		await transporter.sendMail({
			from: process.env.SMTP_FROM || process.env.SMTP_USER,
			to: process.env.CONTACT_TO || process.env.SMTP_USER,
			replyTo: email,
			subject: `New submission: ${company}`,
			html,
			attachments: [
				{
					filename: `technical-review-${new URL(url).hostname}.pdf`,
					content: pdfBuffer,
					contentType: 'application/pdf',
				},
			],
		});

		return new Response(JSON.stringify({ ok: true, message: 'Submitted successfully.' }), { status: 200 });
	} catch (err) {
		console.error('tech-review route error:', err);
		return new Response(JSON.stringify({ error: 'Failed to submit.' }), { status: 500 });
	}
};
