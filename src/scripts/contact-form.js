document.addEventListener('astro:page-load', () => {
	const form = document.getElementById('form');
	const formContainer = document.getElementById('form-container');
	const result = document.getElementById('result');
	const reviewPreview = document.getElementById('review-preview');
	const resultsRoot = document.getElementById('results-root');
	const resultsUrl = document.getElementById('results-url');
	const cellphoneImage = document.querySelector('.contact-desktop .cellphone');
	const urlInput = document.getElementById('url');
	const emailInput = document.getElementById('email_address');
	const turnstileContainer = document.getElementById('turnstile-container');
	const submitButton = document.getElementById('submit-btn');
	const backToFormButton = document.getElementById('back-to-form-btn');
	const submitLoader = submitButton?.querySelector('.loader');

	if (!form || !result || !urlInput || !reviewPreview || !emailInput) return;
	if (form.dataset.scanFormBound === 'true') return;
	form.dataset.scanFormBound = 'true';

	let submitted = false;
	let turnstileScriptPromise = null;
	let turnstileWarmupStarted = false;
	let hasCompletedScan = false;

	function setSubmitButtonLabel(label) {
		if (!(submitButton instanceof HTMLButtonElement)) return;
		const textNode = Array.from(submitButton.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
		if (textNode) {
			textNode.textContent = `${label} `;
			return;
		}
		submitButton.insertBefore(document.createTextNode(`${label} `), submitButton.firstChild);
	}

	function syncSubmitButtonLabel() {
		setSubmitButtonLabel(hasCompletedScan ? 'RUN NEW SCAN' : 'RUN FREE SCAN');
	}

	function setSubmittingState(isSubmitting) {
		if (submitButton instanceof HTMLButtonElement) {
			submitButton.disabled = isSubmitting;
			submitButton.setAttribute('aria-busy', isSubmitting ? 'true' : 'false');
		}
		if (submitLoader instanceof HTMLElement) {
			submitLoader.style.display = isSubmitting ? 'inline-block' : 'none';
		}
	}

	function setCellphoneHidden(isHidden) {
		if (!(cellphoneImage instanceof HTMLElement)) return;
		cellphoneImage.style.display = isHidden ? 'none' : '';
	}

	function setScanCompleteView(isComplete) {
		if (formContainer instanceof HTMLElement) {
			formContainer.style.display = isComplete ? 'none' : '';
		}
		reviewPreview.style.display = isComplete ? 'block' : 'none';
	}

	function isHistoryNavigationRestore() {
		if (!window.performance || typeof window.performance.getEntriesByType !== 'function') return false;
		const navEntries = window.performance.getEntriesByType('navigation');
		return Boolean(navEntries.length && navEntries[0]?.type === 'back_forward');
	}

	function waitForTurnstileRender(maxAttempts = 20, delayMs = 250) {
		return new Promise((resolve) => {
			let attempts = 0;
			const interval = setInterval(() => {
				attempts += 1;
				if (ensureTurnstileRendered() || attempts >= maxAttempts) {
					clearInterval(interval);
					resolve(true);
				}
			}, delayMs);
		});
	}

	function loadTurnstileScriptOnce() {
		if (window.turnstile && typeof window.turnstile.render === 'function') {
			ensureTurnstileRendered();
			return Promise.resolve(true);
		}

		if (turnstileScriptPromise) return turnstileScriptPromise;

		turnstileScriptPromise = new Promise((resolve) => {
			const existing = document.querySelector('script[data-turnstile-loader="true"]');
			if (existing) {
				existing.addEventListener(
					'load',
					() => {
						ensureTurnstileRendered();
						resolve(true);
					},
					{ once: true },
				);
				existing.addEventListener('error', () => resolve(false), { once: true });
				return;
			}

			const script = document.createElement('script');
			script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
			script.async = true;
			script.defer = true;
			script.setAttribute('data-turnstile-loader', 'true');
			script.addEventListener(
				'load',
				() => {
					ensureTurnstileRendered();
					resolve(true);
				},
				{ once: true },
			);
			script.addEventListener('error', () => resolve(false), { once: true });
			document.head.appendChild(script);
		});

		return turnstileScriptPromise;
	}

	function warmupTurnstileOnDemand() {
		if (turnstileWarmupStarted) return;
		turnstileWarmupStarted = true;

		if (ensureTurnstileRendered()) return;

		void loadTurnstileScriptOnce().then((loaded) => {
			if (!loaded) return;
			if (!ensureTurnstileRendered()) {
				void waitForTurnstileRender();
			}
		});
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
		if (!turnstileContainer) return;
		if (!window.turnstile || typeof window.turnstile.render !== 'function') return;
		const widgetId = turnstileContainer?.dataset?.widgetId;
		if (!widgetId) {
			ensureTurnstileRendered();
			return;
		}

		try {
			if (typeof window.turnstile.remove === 'function') {
				window.turnstile.remove(widgetId);
			}
		} catch {
			if (typeof window.turnstile.reset === 'function') {
				try {
					window.turnstile.reset(widgetId);
				} catch {
					// no-op
				}
			}
		}

		delete turnstileContainer.dataset.widgetId;
		turnstileContainer.innerHTML = '';
		ensureTurnstileRendered();
	}

	function resetFormUiState(options = {}) {
		const { preserveAllExceptUrl = false } = options;
		const preservedEntries = preserveAllExceptUrl ? Array.from(new FormData(form).entries()).filter(([key]) => key !== 'url') : [];

		form.reset();

		if (preserveAllExceptUrl) {
			for (const [key, value] of preservedEntries) {
				if (typeof value !== 'string') continue;
				const field = form.elements.namedItem(key);
				if (field instanceof RadioNodeList) {
					for (const element of Array.from(field)) {
						if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
							element.checked = element.value === value;
						}
					}
					continue;
				}

				if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) {
					field.value = value;
				}
			}
		}

		form.classList.remove('was-validated');
		form.querySelectorAll('.is-valid, .is-invalid').forEach((el) => {
			el.classList.remove('is-valid', 'is-invalid');
		});
		form.querySelectorAll('[data-touched]').forEach((el) => {
			el.removeAttribute('data-touched');
		});
		urlInput.setCustomValidity('');
		emailInput.setCustomValidity('');
		submitted = false;
		resetTurnstileIfAvailable();
	}

	function resetForHistoryNavigationRestore() {
		resetFormUiState();
		hasCompletedScan = false;
		syncSubmitButtonLabel();
		setScanCompleteView(false);
		result.style.display = 'none';
		result.textContent = '';
		setCellphoneHidden(false);
		if (resultsRoot) resultsRoot.innerHTML = '';
	}

	syncSubmitButtonLabel();
	setScanCompleteView(false);

	if (isHistoryNavigationRestore()) {
		resetForHistoryNavigationRestore();
	}

	window.addEventListener('pageshow', (event) => {
		if (event.persisted || isHistoryNavigationRestore()) {
			resetForHistoryNavigationRestore();
		}
	});

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

	function getScoreClass(value) {
		if (value == null || !Number.isFinite(value)) return 'is-na';
		if (value >= 90) return 'is-good';
		if (value >= 50) return 'is-average';
		return 'is-poor';
	}

	function scoreCard(label, value) {
		const numericValue = typeof value === 'number' && Number.isFinite(value) ? value : null;
		const hasScore = numericValue != null;
		const safeValue = hasScore ? Math.max(0, Math.min(100, Math.round(numericValue))) : 0;
		const shown = hasScore ? `${safeValue}` : 'N/A';
		const scoreClass = getScoreClass(hasScore ? safeValue : null);
		return `
				<div class="review-score-item ${scoreClass}">
					<div class="review-score-circle" style="--score:${safeValue}" role="img" aria-label="${escapeHtml(label)} score ${shown}">
						<span>${shown}</span>
					</div>
					<strong>${escapeHtml(label)}</strong>
				</div>
			`;
	}

	function renderReviewPreview(preview) {
		if (!preview || typeof preview !== 'object') {
			setScanCompleteView(false);
			setCellphoneHidden(false);
			if (resultsRoot) resultsRoot.innerHTML = '';
			return;
		}

		const scores = preview.scores || {};

		const scoreHtml = [
			scoreCard('Performance', scores.performance),
			scoreCard('SEO', scores.seo),
			scoreCard('Accessibility', scores.accessibility),
			scoreCard('Best Practices', scores.bestPractices),
		].join('');

		if (resultsRoot) {
			resultsRoot.innerHTML = `
				<div class="review-preview-card">
					<div class="review-score-grid">${scoreHtml}</div>
				</div>
			`;
		}

		hasCompletedScan = true;
		syncSubmitButtonLabel();
		setScanCompleteView(true);
		setCellphoneHidden(true);
	}

	function setResultsUrl(urlValue) {
		if (!resultsUrl) return;
		const anchor = resultsUrl.querySelector('a');
		if (!(anchor instanceof HTMLAnchorElement)) return;

		const normalized = normalizeUrl(urlValue || '');
		let display = '[url]';
		let href = '#';

		if (normalized) {
			try {
				const parsed = new URL(normalized);
				href = parsed.toString();
				display = parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
			} catch {
				display = urlValue || '[url]';
			}
		}

		anchor.textContent = display;
		anchor.href = href;
	}

	async function submitForm(turnstileToken) {
		setSubmittingState(true);
		const formData = new FormData(form);
		const endpoint = form.dataset.apiPath || '/api/tech-review/';

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
		setScanCompleteView(false);
		setCellphoneHidden(false);
		if (resultsRoot) resultsRoot.innerHTML = '';

		try {
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});

			const text = await response.text();
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
					setScanCompleteView(false);
					setCellphoneHidden(false);
					if (resultsRoot) resultsRoot.innerHTML = '';
					resetFormUiState({ preserveAllExceptUrl: true });
					urlInput.focus();
				} else if (data?.error && String(data.error).trim() === invalidVerificationError) {
					result.style.display = 'block';
					result.textContent = 'Verification expired. Please complete the verification checkbox again and resubmit.';
					setScanCompleteView(false);
					setCellphoneHidden(false);
					if (resultsRoot) resultsRoot.innerHTML = '';
					resetTurnstileIfAvailable();
				} else {
					setScanCompleteView(false);
					setCellphoneHidden(false);
					if (resultsRoot) {
						resultsRoot.innerHTML = `<div class="review-preview-card">${data?.error ? escapeHtml(data.error) : 'Request failed. Please try again.'}</div>`;
					}
					result.textContent = '';
					resetTurnstileIfAvailable();
				}
				return;
			}

			result.textContent = data?.message || 'Thanks. Your request was submitted.';
			setResultsUrl(payload.url);

			renderReviewPreview(data?.preview);
			reviewPreview.scrollIntoView({ behavior: 'smooth', block: 'start' });

			resetFormUiState();
		} catch (err) {
			setScanCompleteView(false);
			setCellphoneHidden(false);
			if (resultsRoot) resultsRoot.innerHTML = '';
			result.textContent = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
			resetTurnstileIfAvailable();
		} finally {
			setSubmittingState(false);
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
		(e) => {
			if (!isFormField(e.target)) return;
			warmupTurnstileOnDemand();
		},
		{ passive: true },
	);

	form.addEventListener(
		'mouseover',
		(e) => {
			if (!isFormField(e.target)) return;
			warmupTurnstileOnDemand();
		},
		{ passive: true },
	);

	if (backToFormButton instanceof HTMLButtonElement) {
		backToFormButton.addEventListener('click', () => {
			setScanCompleteView(false);
			setCellphoneHidden(false);
			if (formContainer instanceof HTMLElement) {
				formContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
			}
			const companyInput = document.getElementById('company');
			if (companyInput instanceof HTMLInputElement) {
				companyInput.focus();
			}
		});
	}
});
