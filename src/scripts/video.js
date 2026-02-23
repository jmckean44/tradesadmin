const mainVideo = document.querySelector('.timeline');
const desktopVideo = '/timeline-desktop.mp4';
const mobileVideo = '/timeline-mobile.mp4';
const desktopPoster = '/timeline-poster-desktop.webp';
const mobilePoster = '/timeline-poster-mobile.webp';
const winWidth = window.innerWidth;

if (mainVideo) {
	if (winWidth < 850) {
		mainVideo.setAttribute('poster', mobilePoster);
	} else {
		mainVideo.setAttribute('poster', desktopPoster);
	}
}

window.addEventListener('resize', function () {
	const winWidth = window.innerWidth;

	if (mainVideo) {
		if (winWidth < 850) {
			mainVideo.setAttribute('poster', mobilePoster);
			mainVideo.setAttribute('src', mobileVideo);
		} else {
			mainVideo.setAttribute('poster', desktopPoster);
			mainVideo.setAttribute('src', desktopVideo);
		}
	}
});
