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

	function hasUrlValue() {
		return Boolean(String(urlInput.value || '').trim());
	}

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
		setSubmitButtonLabel(hasUrlValue() ? 'RUN FREE SCAN' : 'SUBMIT');
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
		if (!raw) {
			syncSubmitButtonLabel();
			return;
		}

		const corrected = normalizeUrlForInputDisplay(raw);
		if (corrected && corrected !== raw) {
			urlInput.value = corrected;
		}
		syncSubmitButtonLabel();
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
		const emptyFeedback = emailInput.parentElement.querySelector('.empty-feedback');
		const invalidFeedback = emailInput.parentElement.querySelectorAll('.invalid-feedback');
		// Hide all feedback by default
		invalidFeedback.forEach((el) => (el.style.display = 'none'));
		if (!raw) {
			emailInput.setCustomValidity('Please enter your email address');
			emailInput.classList.add('is-invalid');
			if (emptyFeedback) emptyFeedback.style.display = '';
			if (invalidFeedback[1]) invalidFeedback[1].style.display = 'none';
			return;
		}
		if (!isValidEmail(raw)) {
			emailInput.setCustomValidity('Please provide a valid email address');
			emailInput.classList.add('is-invalid');
			if (emptyFeedback) emptyFeedback.style.display = 'none';
			if (invalidFeedback[1]) invalidFeedback[1].style.display = '';
			return;
		}
		emailInput.setCustomValidity('');
		emailInput.classList.remove('is-invalid');
		if (emptyFeedback) emptyFeedback.style.display = 'none';
		if (invalidFeedback[1]) invalidFeedback[1].style.display = 'none';
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
		syncSubmitButtonLabel();
		resetTurnstileIfAvailable();
	}

	function resetForHistoryNavigationRestore() {
		resetFormUiState();
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
		if (!preview || typeof preview !== 'object' || preview.available === false) {
			setScanCompleteView(false);
			setCellphoneHidden(false);
			if (resultsRoot) {
				resultsRoot.innerHTML = `<div class="review-preview-card">Network request stalled. Please try again.</div>`;
			}
			// Show back to form button, hide submit button
			if (typeof submitButton !== 'undefined' && submitButton) submitButton.style.display = 'none';
			if (typeof backToFormButton !== 'undefined' && backToFormButton) backToFormButton.style.display = 'inline-block';
			return;
		}

		const scores = preview.scores || {};
		const allScoresMissing = [scores.performance, scores.seo, scores.accessibility, scores.bestPractices].every((v) => v == null || v === '');

		if (allScoresMissing) {
			setScanCompleteView(false);
			setCellphoneHidden(false);
			if (resultsRoot) {
				resultsRoot.innerHTML = `<div class="review-preview-card">Network request stalled. Please try again.</div>`;
			}
			if (typeof submitButton !== 'undefined' && submitButton) submitButton.style.display = 'none';
			if (typeof backToFormButton !== 'undefined' && backToFormButton) backToFormButton.style.display = 'inline-block';
			return;
		}

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

		setScanCompleteView(true);
		setCellphoneHidden(true);
		// Show back to form button, hide submit button after successful scan
		if (typeof submitButton !== 'undefined' && submitButton) submitButton.style.display = 'none';
		if (typeof backToFormButton !== 'undefined' && backToFormButton) backToFormButton.style.display = 'inline-block';
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
		const hasSubmittedUrl = Boolean(String(payload.url || '').trim());

		result.style.display = 'block';
		result.textContent = hasSubmittedUrl ? 'Scanning... results take about 20 seconds.' : 'Submitting...';
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

			// Fallback: if response is empty or missing preview, show a message
			if (!data || typeof data !== 'object' || !('preview' in data)) {
				setScanCompleteView(false);
				setCellphoneHidden(false);
				if (resultsRoot) {
					resultsRoot.innerHTML = `<div class="review-preview-card">Network request stalled, please try again.</div>`;
				}
				result.textContent = '';
				resetTurnstileIfAvailable();
				return;
			}

			// Always store the full API response (success or error) in localStorage
			localStorage.setItem(
				'techReviewSubmission',
				JSON.stringify({
					response: data,
					timestamp: Date.now(),
					success: data && typeof data.ok === 'boolean' ? data.ok : response.ok,
				}),
			);

			// Store Google Sheets response if present, and always store the full API response in gsSubmissionResponse
			if (data && typeof data.sheetsResponse !== 'undefined') {
				localStorage.setItem(
					'gsSubmissionResponse',
					JSON.stringify({
						response: data.sheetsResponse,
						error: data.sheetsResponseError || null,
						apiResponse: data, // Store the full API response
						timestamp: Date.now(),
					}),
				);
			} else {
				// Always store the full API response in gsSubmissionResponse for error cases too
				localStorage.setItem(
					'gsSubmissionResponse',
					JSON.stringify({
						response: null,
						error: data?.error || null,
						apiResponse: data,
						timestamp: Date.now(),
					}),
				);
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
					result.textContent = 'Captcha expired or invalid. Please try again.';
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

			// Check for missing preview or all scores missing
			const scores = data?.preview?.scores || {};
			const allScoresMissing = !data?.preview || [scores.performance, scores.seo, scores.accessibility, scores.bestPractices].every((v) => v == null || v === '');

			if (allScoresMissing) {
				setScanCompleteView(false);
				setCellphoneHidden(false);
				if (resultsRoot) {
					resultsRoot.innerHTML = `<div class="review-preview-card">Network stalled, please try again.</div>`;
				}
				// Always show a message in the result area as well
				result.style.display = 'block';
				result.textContent = 'Network stalled, please try again.';
				resetTurnstileIfAvailable();
				return;
			}

			result.textContent = data?.message || 'Thanks. Your request was submitted.';
			// Always show the review-preview section after submit, even if no CWV results
			setResultsUrl(payload.url);
			renderReviewPreview(data?.preview);
			// Scroll to #contact section on scan complete
			const contactSection = document.getElementById('contact');
			if (contactSection) {
				contactSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
			}
			resetFormUiState();
		} catch (err) {
			setScanCompleteView(false);
			setCellphoneHidden(false);
			if (resultsRoot) resultsRoot.innerHTML = '';
			result.textContent = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
			resetTurnstileIfAvailable();
			// Store fetch error in localStorage
			localStorage.setItem('techReviewSubmission', JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'Unknown error', timestamp: Date.now() }));
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
		if (field.id === 'url') syncSubmitButtonLabel();
		updateFieldState(field, submitted);
	});

	form.addEventListener('submit', (e) => {
		e.preventDefault();
		submitted = true;
		applyUrlAutocorrect();
		applyEmailAutocorrect();
		syncSubmitButtonLabel();
		void loadTurnstileScriptOnce();

		// Mark all fields as touched so validation feedback appears
		const fields = form.querySelectorAll('input, textarea, select');
		fields.forEach((f) => {
			if (f && typeof f === 'object') f.dataset.touched = 'true';
		});

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
			const field = e.target;
			if (!isFormField(field)) return;
			warmupTurnstileOnDemand();
			// Show feedback immediately on focus
			updateFieldState(field, submitted);
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
			resetFormUiState();
			setScanCompleteView(false);
			setCellphoneHidden(false);
			result.style.display = 'none';
			result.textContent = '';
			if (resultsRoot) resultsRoot.innerHTML = '';
			if (formContainer instanceof HTMLElement) {
				formContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
			}
			// Ensure submit button is always visible after returning to form
			if (typeof submitButton !== 'undefined' && submitButton) submitButton.style.display = 'inline-block';
			const companyInput = document.getElementById('company');
			if (companyInput instanceof HTMLInputElement) {
				companyInput.focus();
			}
		});
	}
});
