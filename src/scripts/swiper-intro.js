import Swiper from 'swiper';
import { Autoplay, Pagination, EffectFade } from 'swiper/modules';
import 'swiper/scss';
//import 'swiper/css/effect-cards';
//import 'swiper/css/effect-coverflow';
import 'swiper/scss/autoplay';
import 'swiper/scss/pagination';

document.addEventListener('astro:page-load', () => {
	const container = document.querySelector('.swiper-intro');
	if (!container) return;

	if (container.swiper && typeof container.swiper.destroy === 'function') {
		container.swiper.destroy(true, true);
	}

	const paginationEl = container.querySelector('.swiper-pagination');
	if (!paginationEl) return;

	const swiper = new Swiper(container, {
		modules: [Autoplay, EffectFade, Pagination], // EffectCards, EffectCoverflow, EffectCreative,
		grabCursor: true,
		effect: 'fade', // 'cards', 'coverflow', 'creative',
		// creativeEffect: {
		// 	prev: {
		// 		shadow: true,
		// 		translate: [0, 0, -800],
		// 		rotate: [180, 0, 0],
		// 	},
		// 	next: {
		// 		shadow: true,
		// 		translate: [0, 0, -800],
		// 		rotate: [-180, 0, 0],
		// 	},
		// },
		pagination: {
			el: paginationEl,
			clickable: true,
		},
		spaceBetween: 0,
		speed: 1000,
		autoplay: {
			delay: 8000,
			//disableOnInteraction: true,
		},
		loop: true,
		autoHeight: false,
	});

	container.swiper = swiper;
});
