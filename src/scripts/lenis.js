// LENIS

import Lenis from 'lenis';

const lenis = new Lenis({
	duration: 0.9,
	easing: (t) => t,
	direction: 'vertical',
	gestureDirection: 'vertical',
	smooth: true,
	mouseMultiplier: 0.8,
	smoothTouch: false,
	touchMultiplier: 1,
	infinite: false,
});

// lenis.on('scroll', ({ scroll, limit, velocity, direction, progress }) => {
// 	console.log({ scroll, limit, velocity, direction, progress })
// });

function raf(time) {
	lenis.raf(time);
	requestAnimationFrame(raf);
}
requestAnimationFrame(raf);
// END LENIS
