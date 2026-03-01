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
				'categories:performance': ['error', { minScore: 0.75 }],
				'categories:accessibility': ['error', { minScore: 0.95 }],
				'categories:best-practices': ['error', { minScore: 0.85 }],
				'categories:seo': ['error', { minScore: 0.95 }],
				'first-contentful-paint': ['error', { maxNumericValue: 2800 }],
				'largest-contentful-paint': ['error', { maxNumericValue: 4500 }],
				'total-blocking-time': ['error', { maxNumericValue: 250 }],
				'cumulative-layout-shift': ['error', { maxNumericValue: 0.1 }],
				'unused-javascript': ['warn', { maxNumericValue: 140000 }],
				'color-contrast': 'error',
			},
		},
		upload: {
			target: 'filesystem',
			outputDir: '.lighthouseci',
		},
	},
};
