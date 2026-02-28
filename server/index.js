// server/index.js
// Express API for form logging and dashboard data
const express = require('express');
const cors = require('cors');

require('dotenv').config();

const app = express();
const siteChecks = require('./site-checks');
app.use(cors());
app.use(express.json());

// Set these in your .env file

const { logSubmissionToNotion } = require('./notion');

// Log a form submission
app.post('/api/submit', async (req, res) => {
	const { company, email, url, phone, message, results, error } = req.body;
app.post('/api/submit', async (req, res) => {
	const { company, email, url, phone, message, results, error, performance, seo, accessibility, best_practices } = req.body;
	// Run site checks in parallel
	let domain = '';
	try {
		domain = new URL(url).hostname;
	} catch {
		domain = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
	}
	const [ssl, httpStatus, dns, sitemap, csp] = await Promise.all([
		siteChecks.checkSSLStatus(domain),
		siteChecks.checkHTTPStatus(url),
		siteChecks.checkDNSStatus(domain),
		siteChecks.checkSitemapStatus(domain),
		siteChecks.checkCSPStatus(url),
	]);

	try {
		await logSubmissionToNotion({
			company,
			email,
			url,
			phone,
			message,
			results,
			error,
			performance,
			seo,
			accessibility,
			best_practices,
			ssl_valid: ssl.valid,
			ssl_valid_to: ssl.valid_to || '',
			ssl_issuer: ssl.issuer || '',
			http_status: String(httpStatus.status),
			dns_found: dns.found,
			sitemap_exists: sitemap.exists,
			csp_present: csp.hasCSP,
			csp_value: csp.csp || '',
			submitted_at: new Date().toISOString(),
		});
		res.json({ ok: true });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});
app.get('/api/submissions', async (req, res) => {
	const { data, error } = await supabase.from('submissions').select('*').order('submitted_at', { ascending: false });
	if (error) return res.status(500).json({ error: error.message });
	res.json(data);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
