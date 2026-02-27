document.addEventListener('astro:page-load', () => {
	// PHONE NUMBER VALIDATION
	const phoneInput = document.getElementById('phone');
	const urlInput = document.getElementById('url');
	const form = document.getElementById('form');

	// URL validation handled in Footer.astro for consistency

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
function initMobileNav() {
	const hamburger = document.getElementById('hamburger');
	const overlay = document.getElementById('mobile-overlay');
	const navMobile = document.getElementById('nav-mobile');

	if (!hamburger || !overlay || !navMobile) return;

	if (hamburger.dataset.navBound === 'true') return;
	hamburger.dataset.navBound = 'true';

	const closeMenu = () => {
		overlay.classList.remove('active');
		hamburger.classList.remove('active');
		hamburger.setAttribute('aria-expanded', 'false');
		overlay.setAttribute('aria-hidden', 'true');
	};

	const openMenu = () => {
		overlay.classList.add('active');
		hamburger.classList.add('active');
		hamburger.setAttribute('aria-expanded', 'true');
		overlay.setAttribute('aria-hidden', 'false');
		navMobile.focus();
	};

	hamburger.addEventListener('click', () => {
		const isOpen = overlay.classList.contains('active');
		if (isOpen) closeMenu();
		else openMenu();
	});

	overlay.addEventListener('click', (e) => {
		if (e.target === overlay) closeMenu();
	});

	navMobile.addEventListener('click', (e) => {
		const target = e.target;
		if (target instanceof HTMLAnchorElement) closeMenu();
	});

	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && overlay.classList.contains('active')) closeMenu();
	});

	window.addEventListener('resize', () => {
		if (window.innerWidth >= 800) closeMenu();
	});

	closeMenu();
}

document.addEventListener('astro:page-load', initMobileNav);

// Fade in header at 500px scroll, fixed, no layout shift
document.addEventListener('DOMContentLoaded', function () {
	const header = document.getElementById('header');
	if (!header) return;
	let lastPinned = false;
	function onScroll() {
		const shouldPin = window.scrollY > 500;
		if (shouldPin !== lastPinned) {
			header.classList.toggle('pinned', shouldPin);
			header.classList.toggle('fade-in', shouldPin);
			lastPinned = shouldPin;
		}
	}
	window.addEventListener('scroll', onScroll, { passive: true });
	// Initial state
	onScroll();
});
