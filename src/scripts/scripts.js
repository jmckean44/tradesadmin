document.addEventListener('astro:page-load', () => {
	// PHONE NUMBER VALIDATION
	const phoneInput = document.getElementById('phone');
	const urlInput = document.getElementById('url');
	const form = document.getElementById('form');

	// URL VALIDATION FOR .ca or .com
	if (urlInput && form) {
		form.addEventListener('submit', (e) => {
			const urlValue = urlInput.value.trim();
			// Accepts .ca or .com at the end, case-insensitive
			if (!/(\.ca|\.com)$/i.test(urlValue)) {
				urlInput.classList.add('is-invalid');
				e.preventDefault();
			} else {
				urlInput.classList.remove('is-invalid');
			}
		});
	}

	// PHONE NUMBER VALIDATION (optional, only digits, max 12 digits)
	if (phoneInput) {
		phoneInput.addEventListener('input', (e) => {
			// Allow digits and spaces only
			let value = e.target.value.replace(/[^\d\s]/g, '');
			// Count digits only (ignore spaces)
			const digits = value.replace(/\s/g, '');
			if (digits.length > 12) {
				// Truncate to 12 digits, preserving spaces
				let digitCount = 0;
				let newValue = '';
				for (let char of value) {
					if (char === ' ') {
						newValue += char;
					} else if (/\d/.test(char)) {
						if (digitCount < 12) {
							newValue += char;
							digitCount++;
						}
					}
				}
				value = newValue;
			}
			e.target.value = value;
		});

		if (form) {
			form.addEventListener('submit', (e) => {
				const phoneValue = phoneInput.value;
				const digits = phoneValue.replace(/\s/g, '');
				// Only validate if not empty
				if (phoneValue && !/^\d{1,12}$/.test(digits)) {
					phoneInput.classList.add('is-invalid');
					e.preventDefault();
				} else {
					phoneInput.classList.remove('is-invalid');
				}
			});
		}
	}
	// SMOOTH SCROLLING
	let anchorlinks = document.querySelectorAll('a[href^="#"]');

	for (let item of anchorlinks) {
		item.addEventListener('click', (e) => {
			let hashval = item.getAttribute('href');
			let target = document.querySelector(hashval);
			target.scrollIntoView({
				behavior: 'smooth',
			});
			history.pushState(null, null, hashval);
			e.preventDefault();
		});
	}

	// ADD ID TO BODY// ADD ID TO BODY
	const body = document.querySelector('body');
	const pathname = window.location.pathname.replace(/^\/|\/$/g, '');

	let id = pathname.split('/')[0] || 'home'; // Get first segment or 'home' for root

	const projectPaths = ['mrc', 'cleanrooms', 'shiupong', 'dale'];

	body.setAttribute('id', id);

	if (projectPaths.includes(id)) {
		body.classList.add('project');
	}
});

//  lazyload images fade-in
document.addEventListener('astro:page-load', () => {
	const lazyImages = document.querySelectorAll('img[loading="lazy"]');

	lazyImages.forEach((img) => {
		if (img.complete && img.naturalHeight !== 0) {
			img.classList.add('loaded');
		} else {
			img.addEventListener('load', () => {
				img.classList.add('loaded');
			});
		}
	});
});

//	HEADER SCROLL
document.addEventListener('astro:page-load', () => {
	let lastScrollY = window.scrollY;
	const header = document.getElementById('header');
	let ticking = false;
	const SCROLL_DELTA = 16; // Minimum scroll difference to trigger pin/unpin

	if (header && !header.classList.contains('unpinned')) {
		header.classList.add('unpinned');
	}

	function onScroll() {
		const currentScrollY = window.scrollY;
		if (!ticking) {
			window.requestAnimationFrame(() => {
				if (currentScrollY < 100) {
					// At page top: remove both classes
					header.classList.remove('pinned');
					header.classList.remove('unpinned');
				} else if (currentScrollY > lastScrollY + SCROLL_DELTA) {
					// Scrolling down: add .unpinned, remove .pinned
					header.classList.add('unpinned');
					header.classList.remove('pinned');
				} else if (currentScrollY < lastScrollY - SCROLL_DELTA) {
					header.classList.add('pinned');
					header.classList.remove('unpinned');
				} else {
					if (!header.classList.contains('pinned') && !header.classList.contains('unpinned')) {
						header.classList.add('unpinned');
					}
				}
				lastScrollY = currentScrollY;
				ticking = false;
			});
			ticking = true;
		}
	}

	window.addEventListener('scroll', onScroll);
	onScroll();
});

// MOBILE NAV
// document.addEventListener('asto: page-load', () => {
// 	const hamburger = document.getElementById('hamburger');
// 	const overlay = document.getElementById('mobile-overlay');

// 	hamburger.addEventListener('click', () => {
// 		overlay.classList.toggle('active');
// 		hamburger.setAttribute('aria-expanded', overlay.classList.contains('active'));
// 	});

// 	// Optional: close menu when clicking outside nav or on a link
// 	overlay.addEventListener('click', (e) => {
// 		if (e.target === overlay || e.target.tagName === 'A') {
// 			overlay.classList.remove('active');
// 			hamburger.setAttribute('aria-expanded', 'false');
// 		}
// 	});
// });
