document.documentElement.classList.add('trig-js');

if (window.trustedTypes && !window.trustedTypes.defaultPolicy) {
	window.trustedTypes.createPolicy('default', {
		createHTML: (value) => value,
		createScript: (value) => value,
		createScriptURL: (value) => value,
	});
}

window.dataLayer = window.dataLayer || [];
window.gtag =
	window.gtag ||
	function gtag() {
		window.dataLayer.push(arguments);
	};

(function initAnalytics() {
	let loaded = false;
	const measurementId = 'G-ES0ZCH7R7T';

	const loadAnalytics = () => {
		if (loaded) return;
		loaded = true;

		const script = document.createElement('script');
		script.async = true;
		script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
		document.head.appendChild(script);

		window.gtag('js', new Date());
		window.gtag('config', measurementId);
	};

	const onFirstInteraction = () => {
		loadAnalytics();
		window.removeEventListener('pointerdown', onFirstInteraction);
		window.removeEventListener('keydown', onFirstInteraction);
		window.removeEventListener('touchstart', onFirstInteraction);
	};

	window.addEventListener('pointerdown', onFirstInteraction, { once: true, passive: true });
	window.addEventListener('keydown', onFirstInteraction, { once: true });
	window.addEventListener('touchstart', onFirstInteraction, { once: true, passive: true });

	if ('requestIdleCallback' in window) {
		window.requestIdleCallback(() => loadAnalytics(), { timeout: 6000 });
	} else {
		window.setTimeout(loadAnalytics, 6000);
	}
})();
