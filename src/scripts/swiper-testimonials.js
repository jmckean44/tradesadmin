import Swiper from 'swiper';
import { Autoplay, EffectFade, Pagination } from 'swiper/modules';
import 'swiper/scss';
import 'swiper/scss/effect-fade';
import 'swiper/scss/autoplay';
import 'swiper/scss/pagination';

document.addEventListener('astro:page-load', () => {
	const container = document.querySelector('.swiper-testimonials');
	if (!container) return; // Prevent errors if not found

	if (container.swiper && typeof container.swiper.destroy === 'function') {
		container.swiper.destroy(true, true);
	}

	const paginationEl = container.querySelector('.swiper-pagination');
	if (!paginationEl) return;

	const swiper = new Swiper(container, {
		modules: [Autoplay, EffectFade, Pagination],
		spaceBetween: 30,
		slidesPerView: 3,
		speed: 1000,
		autoHeight: false,
		autoplay: {
			delay: 10000, // More typical delay
			disableOnInteraction: false,
		},
		loop: true,
		pagination: {
			el: paginationEl,
			clickable: true,
		},
		breakpoints: {
			0: {
				slidesPerView: 1,
			},
			700: {
				slidesPerView: 2,
			},
			1200: {
				slidesPerView: 3,
			},
		},
	});
	container.swiper = swiper;
});
