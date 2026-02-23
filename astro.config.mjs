import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';
import icon from 'astro-icon';

export default defineConfig({
	site: 'https://tradesadmin.ca',
	trailingSlash: 'always',
	output: 'static',
	//outDir: 'dist',
	prefetch: true,
	integrations: [
		sitemap(),
		icon(),
		react({
			experimentalReactChildren: true,
		}),
	],
	build: {
		minify: true,
	},
	image: {
		responsiveStyles: true,
		layout: 'full-width',
	},
	adapter: node({
		mode: 'standalone',
	}),
});
