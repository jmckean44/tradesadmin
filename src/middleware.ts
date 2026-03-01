import { defineMiddleware } from 'astro/middleware';

const SECURITY_CSP = [
	"default-src 'self'",
	"base-uri 'self'",
	"object-src 'none'",
	"frame-ancestors 'none'",
	"script-src 'self' https://challenges.cloudflare.com https://www.googletagmanager.com https://www.google-analytics.com https://unpkg.com",
	"connect-src 'self' https://challenges.cloudflare.com https://www.google-analytics.com https://region1.google-analytics.com",
	"img-src 'self' data: https:",
	"style-src 'self' 'unsafe-inline'",
	"font-src 'self' data:",
	'frame-src https://challenges.cloudflare.com',
	"form-action 'self'",
	"trusted-types default 'allow-duplicates' goog#html lit-html",
	"require-trusted-types-for 'script'",
	'upgrade-insecure-requests',
].join('; ');

export const onRequest = defineMiddleware(async (_context, next) => {
	const response = await next();

	response.headers.set('Content-Security-Policy', SECURITY_CSP);
	response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
	response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

	return response;
});
