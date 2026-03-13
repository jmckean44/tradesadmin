document.addEventListener('astro:page-load', () => {
	const sections = ['services', 'services-intro', 'pricing', 'contact'];
	const navLinks = sections.map((id) => document.querySelector(`#nav-desktop a[href='#${id}']`));

	function onScroll() {
		let servicesActive = false;
		let current = '';
		for (const id of sections) {
			const section = document.getElementById(id);
			if (!section) continue;
			const rect = section.getBoundingClientRect();
			if (rect.top <= 150 && rect.bottom > 150) {
				current = id;
				if (id === 'services' || id === 'services-intro') {
					servicesActive = true;
				}
				break;
			}
		}
		navLinks.forEach((link, i) => {
			if (!link) return;
			if (sections[i] === 'services' || sections[i] === 'services-intro') {
				link.classList.toggle('active', servicesActive);
			} else {
				link.classList.toggle('active', sections[i] === current);
			}
		});
	}

	window.addEventListener('scroll', onScroll, { passive: true });
	onScroll(); // Initial highlight
});
