document.addEventListener('astro:page-load', () => {
	// Enhanced lazy loading for videos
	const lazyVideos = document.querySelectorAll('video');

	if ('IntersectionObserver' in window) {
		const videoObserver = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting) {
						const video = entry.target;
						const sources = video.querySelectorAll('source[data-src]');
						let hasDataSrc = false;

						// Handle source elements with data-src
						sources.forEach((source) => {
							source.src = source.dataset.src;
							source.removeAttribute('data-src');
							hasDataSrc = true;
						});

						// Handle video element with data-src
						if (video.dataset.src) {
							video.src = video.dataset.src;
							video.removeAttribute('data-src');
							hasDataSrc = true;
						}

						// Only load and unobserve if we found data-src attributes
						if (hasDataSrc) {
							video.load();
							videoObserver.unobserve(video);

							// Mark as loaded
							video.setAttribute('data-loaded', 'true');

							//console.log('Video loaded:', video);
						}
					}
				});
			},
			{ rootMargin: '100px' }
		);

		lazyVideos.forEach((video) => {
			// Only observe videos that have data-src or contain sources with data-src
			const hasDataSrc = video.dataset.src || video.querySelector('source[data-src]');
			if (hasDataSrc) {
				videoObserver.observe(video);
			}
		});
	} else {
		// Fallback for browsers without IntersectionObserver
		lazyVideos.forEach((video) => {
			const sources = video.querySelectorAll('source[data-src]');
			sources.forEach((source) => {
				source.src = source.dataset.src;
				source.removeAttribute('data-src');
			});
			if (video.dataset.src) {
				video.src = video.dataset.src;
				video.removeAttribute('data-src');
			}
			video.load();
		});
	}
});
