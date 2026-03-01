document.addEventListener('astro:page-load', () => {
	// If user navigated back from results page, clear the form
	if (window.performance && window.performance.getEntriesByType) {
		const navEntries = window.performance.getEntriesByType('navigation');
		if (navEntries.length && navEntries[0].type === 'back_forward') {
			const form = document.getElementById('form');
			if (form) form.reset();
		}
	}
	const form = document.getElementById('form');
	const result = document.getElementById('result');
	const reviewPreview = document.getElementById('review-preview');
	const urlInput = document.getElementById('url');
	const emailInput = document.getElementById('email_address');
	const turnstileContainer = document.getElementById('turnstile-container');

	if (!form || !result || !urlInput || !reviewPreview || !emailInput) return;
	if (form.dataset.scanFormBound === 'true') return;
	form.dataset.scanFormBound = 'true';

	let submitted = false;
	let turnstileScriptPromise = null;

	function loadTurnstileScriptOnce() {
		if (window.turnstile && typeof window.turnstile.render === 'function') {
			return Promise.resolve(true);
		}

		if (turnstileScriptPromise) return turnstileScriptPromise;

		turnstileScriptPromise = new Promise((resolve) => {
			const existing = document.querySelector('script[data-turnstile-loader="true"]');
			if (existing) {
				existing.addEventListener('load', () => resolve(true), { once: true });
				existing.addEventListener('error', () => resolve(false), { once: true });
				return;
			}

			const script = document.createElement('script');
			script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
			script.async = true;
			script.defer = true;
			script.setAttribute('data-turnstile-loader', 'true');
			script.addEventListener('load', () => resolve(true), { once: true });
			script.addEventListener('error', () => resolve(false), { once: true });
			document.head.appendChild(script);
		});

		return turnstileScriptPromise;
	}

	function ensureTurnstileRendered() {
		if (!turnstileContainer) return false;
		const siteKey = turnstileContainer.getAttribute('data-sitekey')?.trim();
		if (!siteKey) return false;
		if (!window.turnstile || typeof window.turnstile.render !== 'function') {
			void loadTurnstileScriptOnce();
			return false;
		}

		const existingWidgetId = turnstileContainer.dataset.widgetId;
		if (existingWidgetId) return true;

		turnstileContainer.innerHTML = '';
		const widgetId = window.turnstile.render(turnstileContainer, {
			sitekey: siteKey,
		});
		turnstileContainer.dataset.widgetId = String(widgetId);
		return true;
	}

	if (!ensureTurnstileRendered()) {
		void loadTurnstileScriptOnce();
		let attempts = 0;
		const interval = setInterval(() => {
			attempts += 1;
			if (ensureTurnstileRendered() || attempts >= 20) {
				clearInterval(interval);
			}
		}, 250);
	}

	// Normalizes URLs to match backend (normalizeUrlForNotion)
	function normalizeUrl(value) {
		const raw = String(value || '').trim();
		if (!raw) return '';

		let cleaned = raw.replace(/\s+/g, '');
		cleaned = cleaned.replace(/^https?:\/(?!\/)/i, (match) => `${match.slice(0, -1)}//`);
		cleaned = cleaned.replace(/^(https?:\/\/)+/i, (match) => (/^http:\/\//i.test(match) ? 'http://' : 'https://'));
		if (!/^https?:\/\//i.test(cleaned)) cleaned = `https://${cleaned}`;

		try {
			const parsed = new URL(cleaned);
			// Remove trailing slash from pathname unless root
			if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
				parsed.pathname = parsed.pathname.replace(/\/+$/, '');
			}
			if (parsed.pathname === '/') parsed.pathname = '';
			const normalizedHostname = parsed.hostname
				.toLowerCase()
				.replace(/,+/g, '.')
				.replace(/\.+/g, '.')
				.replace(/^\.+|\.+$/g, '');
			if (normalizedHostname) parsed.hostname = normalizedHostname;
			return parsed.toString();
		} catch {
			return cleaned;
		}
	}

	function getUrlValidationMessage(value) {
		const normalized = normalizeUrl(value);
		if (!normalized) return 'Please provide a valid URL';

		try {
			const u = new URL(normalized);
			const host = String(u.hostname || '').trim();
			if (!host || !host.includes('.')) return 'Please enter a full domain like example.com';

			const tld = host.split('.').pop() || '';
			if (tld.length < 2) return 'Please enter a full domain like example.com';

			return '';
		} catch {
			return 'Please provide a valid URL';
		}
	}

	function normalizeUrlForInputDisplay(value) {
		const normalized = normalizeUrl(value);
		if (!normalized) return '';

		try {
			const parsed = new URL(normalized);
			const path = parsed.pathname === '/' ? '' : parsed.pathname;
			return `${parsed.protocol}//${parsed.host}${path}${parsed.search}${parsed.hash}`;
		} catch {
			return normalized;
		}
	}

	function applyUrlAutocorrect() {
		const raw = String(urlInput.value || '').trim();
		if (!raw) return;

		const corrected = normalizeUrlForInputDisplay(raw);
		if (corrected && corrected !== raw) {
			urlInput.value = corrected;
		}
	}

	function updateUrlValidity() {
		const raw = urlInput.value.trim();
		if (!raw) {
			urlInput.setCustomValidity('');
			return;
		}
		urlInput.setCustomValidity(getUrlValidationMessage(raw));
	}

	function isValidEmail(value) {
		const email = String(value || '')
			.trim()
			.replace(/\s+/g, '');
		if (!email) return false;
		return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
	}

	function applyEmailAutocorrect() {
		const raw = String(emailInput.value || '');
		const corrected = raw.trim().replace(/\s+/g, '');
		if (corrected !== raw) emailInput.value = corrected;
	}

	function updateEmailValidity() {
		const raw = emailInput.value.trim();
		if (!raw) {
			emailInput.setCustomValidity('');
			return;
		}
		emailInput.setCustomValidity(isValidEmail(raw) ? '' : 'Please provide a valid email address');
	}

	function getTurnstileToken() {
		const fieldToken =
			form.querySelector('input[name="cf-turnstile-response"]')?.value?.trim() ||
			form.querySelector('textarea[name="cf-turnstile-response"]')?.value?.trim() ||
			document.querySelector('input[name="cf-turnstile-response"]')?.value?.trim() ||
			document.querySelector('textarea[name="cf-turnstile-response"]')?.value?.trim() ||
			'';

		if (fieldToken) return fieldToken;

		if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
			try {
				const widgetId = turnstileContainer?.dataset?.widgetId;
				if (widgetId) {
					const widgetToken = String(window.turnstile.getResponse(widgetId) || '').trim();
					if (widgetToken) return widgetToken;
				}
				return '';
			} catch {
				return '';
			}
		}

		return '';
	}

	function resetTurnstileIfAvailable() {
		if (!window.turnstile || typeof window.turnstile.reset !== 'function') return;
		const widgetId = turnstileContainer?.dataset?.widgetId;
		if (!widgetId) return;
		try {
			window.turnstile.reset(widgetId);
		} catch {
			// no-op
		}
	}

	function isFormField(el) {
		return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
	}

	function updateFieldState(field, force = false) {
		if (!isFormField(field)) return;

		if (field.id === 'url') updateUrlValidity();
		if (field.id === 'email_address') updateEmailValidity();

		const touched = field.dataset.touched === 'true';
		if (!force && !touched) {
			field.classList.remove('is-valid', 'is-invalid');
			return;
		}

		field.classList.toggle('is-invalid', !field.checkValidity());
		field.classList.toggle('is-valid', field.checkValidity());
	}

	function validateAllFields() {
		form.classList.add('was-validated');
		updateUrlValidity();
		updateEmailValidity();

		const fields = form.querySelectorAll('input, textarea, select');
		fields.forEach((f) => updateFieldState(f, true));

		return form.checkValidity();
	}

	function escapeHtml(value) {
		return String(value ?? '')
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&#39;');
	}

	function toBase64Url(value) {
		try {
			const utf8 = encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, (_match, p1) => String.fromCharCode(parseInt(p1, 16)));
			return btoa(utf8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
		} catch {
			return '';
		}
	}

	function scoreRow(label, value) {
		const safeValue = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
		const shown = Number.isFinite(value) ? `${safeValue}` : 'N/A';
		return `
				<div class="review-score-row">
					<div class="review-score-head"><strong>${label}</strong><span>${shown}</span></div>
					<progress max="100" value="${safeValue}" aria-label="${label} score"></progress>
				</div>
			`;
	}

	function renderReviewPreview(preview) {
		if (!preview || typeof preview !== 'object') {
			reviewPreview.style.display = 'none';
			reviewPreview.innerHTML = '';
			return;
		}

		const scores = preview.scores || {};
		const vitals = preview.vitals || {};
		const fixes = Array.isArray(preview.recommendedFixes) ? preview.recommendedFixes : [];

		const scoreHtml = [
			scoreRow('Performance', Number(scores.performance)),
			scoreRow('SEO', Number(scores.seo)),
			scoreRow('Accessibility', Number(scores.accessibility)),
			scoreRow('Best Practices', Number(scores.bestPractices)),
		].join('');

		const fixesHtml = fixes.length ? `<ul>${fixes.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p>No recommended fixes returned.</p>';

		reviewPreview.innerHTML = `
				<div class="review-preview-card">
					<h3>Quick Technical Snapshot</h3>
					<p class="review-subtitle">Initial automated scan of your submitted site.</p>
					<div class="review-score-grid">${scoreHtml}</div>
					<div class="review-vitals">
						<p><strong>LCP:</strong> ${escapeHtml(vitals.lcp || 'N/A')}</p>
						<p><strong>Interactive:</strong> ${escapeHtml(vitals.interactive || 'N/A')}</p>
						<p><strong>TBT:</strong> ${escapeHtml(vitals.tbt || 'N/A')}</p>
						<p><strong>CLS:</strong> ${escapeHtml(vitals.cls || 'N/A')}</p>
					</div>
					<div class="review-fixes">
						<h4>Recommended Fixes</h4>
						${fixesHtml}
					</div>
				</div>
			`;

		reviewPreview.style.display = 'block';
	}

	async function submitForm(turnstileToken) {
		const formData = new FormData(form);
		const endpoint = form.dataset.apiPath || '/api/tech-review/';
		const resultPage = form.dataset.resultsPath || '/results/';

		const payload = {
			company: String(formData.get('company') || '').trim(),
			email: String(formData.get('email') || '')
				.trim()
				.replace(/\s+/g, ''),
			url: normalizeUrl(String(formData.get('url') || '').trim()),
			phone: String(formData.get('phone') || '').trim(),
			message: String(formData.get('details') || formData.get('message') || '').trim(),
			turnstileToken: String(turnstileToken || getTurnstileToken() || '').trim(),
		};

		result.style.display = 'block';
		result.textContent = 'Scanning... please wait about 30 seconds.';
		reviewPreview.style.display = 'none';
		reviewPreview.innerHTML = '';

		try {
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});

			const text = await response.text();
			console.log('API status/body:', response.status, text);
			let data = {};
			if (text) {
				try {
					data = JSON.parse(text);
				} catch {
					data = {};
				}
			}

			if (!response.ok) {
				// If the error is the domain not found/typo error, show in #result, else show in #review-preview
				const domainNotFoundError = 'The website address you entered could not be found. Please check for typos and try again.';
				const invalidVerificationError = 'Invalid verification.';
				if (data?.error && String(data.error).trim() === domainNotFoundError) {
					result.style.display = 'block';
					result.textContent = data.error;
					reviewPreview.style.display = 'none';
					reviewPreview.innerHTML = '';
				} else if (data?.error && String(data.error).trim() === invalidVerificationError) {
					result.style.display = 'block';
					result.textContent = 'Verification expired. Please complete the verification checkbox again and resubmit.';
					reviewPreview.style.display = 'none';
					reviewPreview.innerHTML = '';
				} else {
					reviewPreview.style.display = 'block';
					reviewPreview.innerHTML = `<div class="review-preview-card"><p>${data?.error ? escapeHtml(data.error) : 'Request failed. Please try again.'}</p></div>`;
					result.textContent = '';
				}
				resetTurnstileIfAvailable();
				return;
			}

			result.textContent = data?.message || 'Thanks. Your request was submitted.';

			// Always include the submitted URL for results page display
			const payloadForStorage = {
				preview: data?.preview || null,
				scan: data?.scan || null,
				email: data?.email || null,
				notion: data?.notion || null,
				url: payload.url || '',
				timestamp: Date.now(),
			};

			let persistedForResults = false;
			try {
				sessionStorage.setItem('scanResultPayload', JSON.stringify(payloadForStorage));
				persistedForResults = true;
			} catch {
				persistedForResults = false;
			}

			try {
				localStorage.setItem('scanResultPayload', JSON.stringify(payloadForStorage));
				persistedForResults = true;
			} catch {
				// no-op: some browsers block localStorage in privacy modes
			}

			if (persistedForResults) {
				window.location.assign(resultPage);
				return;
			}

			const encodedPayload = toBase64Url(JSON.stringify(payloadForStorage));
			if (encodedPayload) {
				const separator = resultPage.includes('?') ? '&' : '?';
				window.location.assign(`${resultPage}${separator}payload=${encodeURIComponent(encodedPayload)}`);
				return;
			}

			renderReviewPreview(data?.preview);

			form.reset();
			form.classList.remove('was-validated');
			form.querySelectorAll('.is-valid, .is-invalid').forEach((el) => {
				el.classList.remove('is-valid', 'is-invalid');
			});
			form.querySelectorAll('[data-touched]').forEach((el) => {
				el.removeAttribute('data-touched');
			});
			urlInput.setCustomValidity('');
			submitted = false;

			if (window.turnstile && typeof window.turnstile.reset === 'function') {
				const widgetId = turnstileContainer?.dataset?.widgetId;
				if (widgetId) {
					window.turnstile.reset(widgetId);
				}
			}
		} catch (err) {
			reviewPreview.style.display = 'none';
			reviewPreview.innerHTML = '';
			result.textContent = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
			resetTurnstileIfAvailable();
		}
	}

	form.addEventListener(
		'blur',
		(e) => {
			const field = e.target;
			if (!isFormField(field)) return;
			if (field.id === 'url') applyUrlAutocorrect();
			if (field.id === 'email_address') applyEmailAutocorrect();
			field.dataset.touched = 'true';
			updateFieldState(field, submitted);
		},
		true,
	);

	form.addEventListener('input', (e) => {
		const field = e.target;
		if (!isFormField(field)) return;
		updateFieldState(field, submitted);
	});

	form.addEventListener('submit', (e) => {
		e.preventDefault();
		submitted = true;
		applyUrlAutocorrect();
		applyEmailAutocorrect();
		void loadTurnstileScriptOnce();

		if (!validateAllFields()) {
			form.querySelector(':invalid')?.focus();
			return;
		}

		const turnstileToken = getTurnstileToken();
		if (!turnstileToken) {
			result.style.display = 'block';
			const hasSiteKey = Boolean(turnstileContainer?.getAttribute('data-sitekey')?.trim());
			result.textContent = hasSiteKey ? 'Please complete the verification checkbox, then submit again.' : 'Verification is currently unavailable. Please refresh and try again.';
			return;
		}

		submitForm(turnstileToken);
	});

	form.addEventListener(
		'focusin',
		() => {
			void loadTurnstileScriptOnce();
		},
		{ once: true },
	);
});
