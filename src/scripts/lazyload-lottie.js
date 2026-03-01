(function () {
	function onReady(fn) {
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', fn, { once: true });
			return;
		}
		fn();
	}

	onReady(function initLottieLazyLoad() {
		const containers = Array.from(document.querySelectorAll('[data-lottie-lazy]'));
		if (!containers.length) return;
		if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

		let scriptRequested = false;
		let userReady = false;
		let inViewReady = false;

		const showPlayer = () => {
			containers.forEach((container) => {
				const fallback = container.querySelector('.lottie-fallback');
				const player = container.querySelector('.lottie-player');
				if (!(player instanceof HTMLElement)) return;
				player.style.display = 'block';
				player.setAttribute('autoplay', '');
				if (fallback instanceof HTMLElement) fallback.style.display = 'none';
			});
		};

		const maybeLoad = () => {
			if (scriptRequested || !userReady || !inViewReady) return;
			scriptRequested = true;
			const script = document.createElement('script');
			script.src = 'https://unpkg.com/@lottiefiles/lottie-player@latest/dist/lottie-player.js';
			script.async = true;
			script.onload = showPlayer;
			document.head.appendChild(script);
		};

		const setUserReady = () => {
			if (userReady) return;
			userReady = true;
			maybeLoad();
		};

		window.addEventListener('pointerdown', setUserReady, { once: true, passive: true });
		window.addEventListener('keydown', setUserReady, { once: true });
		window.addEventListener('touchstart', setUserReady, { once: true, passive: true });

		if ('requestIdleCallback' in window) {
			window.requestIdleCallback(setUserReady, { timeout: 5000 });
		} else {
			window.setTimeout(setUserReady, 5000);
		}

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					inViewReady = true;
					maybeLoad();
					observer.disconnect();
				}
			},
			{ root: null, rootMargin: '0px 0px 120px 0px', threshold: 0.1 },
		);

		containers.forEach((container) => observer.observe(container));
	});
})();
