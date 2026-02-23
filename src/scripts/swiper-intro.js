import Swiper from 'swiper';
import { Autoplay, Pagination, EffectFade } from 'swiper/modules';
import 'swiper/scss';
//import 'swiper/css/effect-cards';
//import 'swiper/css/effect-coverflow';
import 'swiper/scss/autoplay';
import 'swiper/scss/pagination';

document.addEventListener('astro:page-load', () => {
	const swiper = new Swiper('.swiper-intro', {
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
			el: '.swiper-pagination',
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
});
