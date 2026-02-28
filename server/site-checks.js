// server/site-checks.js
// Node.js functions to check SSL, HTTP, DNS, sitemap, and CSP status
const dns = require('dns').promises;
const https = require('https');
const http = require('http');
const { URL } = require('url');
const fetch = require('node-fetch');

// 1. SSL Certificate Status
async function checkSSLStatus(domain) {
	return new Promise((resolve) => {
		const options = { host: domain, port: 443, method: 'GET', rejectUnauthorized: false };
		const req = https.request(options, (res) => {
			const cert = res.socket.getPeerCertificate();
			if (cert && cert.valid_to) {
				resolve({ valid: true, valid_to: cert.valid_to, issuer: cert.issuer && cert.issuer.O });
			} else {
				resolve({ valid: false });
			}
		});
		req.on('error', () => resolve({ valid: false }));
		req.end();
	});
}

// 2. HTTP Status
async function checkHTTPStatus(url) {
	try {
		const res = await fetch(url, { redirect: 'manual' });
		return { status: res.status };
	} catch (e) {
		return { status: null, error: e.message };
	}
}

// 3. DNS Status
async function checkDNSStatus(domain) {
	try {
		const records = await dns.resolveAny(domain);
		return { found: true, records };
	} catch (e) {
		return { found: false, error: e.message };
	}
}

// 4. Sitemap Status
async function checkSitemapStatus(domain) {
	try {
		const url = `https://${domain}/sitemap.xml`;
		const res = await fetch(url, { method: 'HEAD' });
		return { exists: res.status === 200 };
	} catch {
		return { exists: false };
	}
}

// 5. Content-Security-Policy Header
async function checkCSPStatus(url) {
	try {
		const res = await fetch(url);
		const csp = res.headers.get('content-security-policy');
		return { hasCSP: !!csp, csp };
	} catch {
		return { hasCSP: false };
	}
}

// Example usage:
// (async () => {
//   const domain = 'example.com';
//   const url = 'https://example.com';
//   console.log('SSL:', await checkSSLStatus(domain));
//   console.log('HTTP:', await checkHTTPStatus(url));
//   console.log('DNS:', await checkDNSStatus(domain));
//   console.log('Sitemap:', await checkSitemapStatus(domain));
//   console.log('CSP:', await checkCSPStatus(url));
// })();

module.exports = {
	checkSSLStatus,
	checkHTTPStatus,
	checkDNSStatus,
	checkSitemapStatus,
	checkCSPStatus,
};
