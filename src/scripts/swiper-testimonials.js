import Swiper from 'swiper';
import { Autoplay, EffectFade, Pagination } from 'swiper/modules';
import 'swiper/scss';
import 'swiper/scss/effect-fade';
import 'swiper/scss/autoplay';
import 'swiper/scss/pagination';

document.addEventListener('astro:page-load', () => {
	const container = document.querySelector('.swiper-testimonials');
	if (!container) return; // Prevent errors if not found

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
			el: '.swiper-pagination',
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
