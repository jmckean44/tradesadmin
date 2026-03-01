module.exports = {
	ci: {
		collect: {
			numberOfRuns: 2,
			url: ['http://127.0.0.1:4321/', 'http://127.0.0.1:4321/results/'],
			settings: {
				onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
				formFactor: 'mobile',
				screenEmulation: {
					mobile: true,
					width: 412,
					height: 823,
					deviceScaleFactor: 1.75,
					disabled: false,
				},
				throttlingMethod: 'simulate',
			},
		},
		assert: {
			assertions: {
				'categories:performance': ['error', { minScore: 0.45 }],
				'categories:accessibility': ['error', { minScore: 0.92 }],
				'categories:best-practices': ['error', { minScore: 0.75 }],
				'categories:seo': ['error', { minScore: 0.9 }],
				'first-contentful-paint': ['error', { maxNumericValue: 4500 }],
				'largest-contentful-paint': ['error', { maxNumericValue: 4500 }],
				'total-blocking-time': ['error', { maxNumericValue: 300 }],
				'cumulative-layout-shift': ['error', { maxNumericValue: 0.15 }],
				'unused-javascript': ['warn', { maxNumericValue: 140000 }],
				'color-contrast': 'warn',
			},
		},
		upload: {
			target: 'filesystem',
			outputDir: '.lighthouseci',
		},
	},
};
