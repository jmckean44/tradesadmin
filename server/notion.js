// server/notion.js
// Minimal Notion integration for logging submissions
const fetch = require('node-fetch');

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

function getNotionHeaders() {
	return {
		Authorization: `Bearer ${NOTION_API_KEY}`,
		'Notion-Version': '2022-06-28',
		'Content-Type': 'application/json',
	};
}

function buildTextValue(value) {
	return [{ type: 'text', text: { content: String(value).slice(0, 1900) } }];
}

async function logSubmissionToNotion(fields) {
	if (!NOTION_API_KEY || !NOTION_DATABASE_ID) throw new Error('Notion API key or database ID missing');
	// Map your Notion property names here:
	const properties = {
		Company: { title: buildTextValue(fields.company) },
		Email: { email: fields.email },
		URL: { url: fields.url },
		Phone: { phone_number: fields.phone },
		Message: { rich_text: buildTextValue(fields.message) },
		Performance: { number: fields.performance || null },
		SEO: { number: fields.seo || null },
		Accessibility: { number: fields.accessibility || null },
		'Best Practices': { number: fields.best_practices || null },
		'SSL Valid': { rich_text: buildTextValue(fields.ssl_valid ? 'Yes' : 'No') },
		//'SSL Valid To': { rich_text: buildTextValue(fields.ssl_valid_to || '') },
		//'SSL Issuer': { rich_text: buildTextValue(fields.ssl_issuer || '') },
		'HTTP Status': { rich_text: buildTextValue(fields.http_status || '') },
		'DNS Found': { rich_text: buildTextValue(fields.dns_found ? 'Yes' : 'No') },
		'Sitemap Exists': { rich_text: buildTextValue(fields.sitemap_exists ? 'Yes' : 'No') },
		'CSP Present': { rich_text: buildTextValue(fields.csp_present ? 'Yes' : 'No') },
		//'CSP Value': { rich_text: buildTextValue(fields.csp_value || '') },
		Error: { rich_text: buildTextValue(fields.error || '') },
		'Submitted At': { date: { start: fields.submitted_at || new Date().toISOString() } },
	};
	const body = {
		parent: { database_id: NOTION_DATABASE_ID },
		properties,
	};
	const resp = await fetch('https://api.notion.com/v1/pages', {
		method: 'POST',
		headers: getNotionHeaders(),
		body: JSON.stringify(body),
	});
	if (!resp.ok) {
		const text = await resp.text().catch(() => '');
		throw new Error(`Notion API error: ${resp.status} ${text}`);
	}
	return await resp.json();
}

module.exports = { logSubmissionToNotion };
