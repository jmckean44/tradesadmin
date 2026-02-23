document.addEventListener('astro:page-load', () => {
	const sections = ['services', 'pricing', 'process', 'testimonials', 'contact'];
	const navLinks = sections.map((id) => document.querySelector(`#nav-desktop a[href='#${id}']`));

	function onScroll() {
		let current = '';
		for (const id of sections) {
			const section = document.getElementById(id);
			if (!section) continue;
			const rect = section.getBoundingClientRect();
			if (rect.top <= 120 && rect.bottom > 120) {
				current = id;
				break;
			}
		}
		navLinks.forEach((link, i) => {
			if (link) link.classList.toggle('active', sections[i] === current);
		});
	}

	window.addEventListener('scroll', onScroll, { passive: true });
	onScroll(); // Initial highlight
});
