import astro from 'eslint-plugin-astro';

/** @type {import('eslint').Linter.Config} */
export default {
	env: {
		browser: true,
		es2021: true,
		node: true,
	},
	extends: ['eslint:recommended', 'plugin:astro/recommended'],
	plugins: ['astro'],
	overrides: [
		{
			files: ['*.astro'],
			parser: 'astro-eslint-parser',
			parserOptions: {
				parser: '@typescript-eslint/parser',
				extraFileExtensions: ['.astro'],
			},
			rules: {
				// Place Astro-specific rules here
			},
		},
		{
			files: ['*.js', '*.ts'],
			parser: '@typescript-eslint/parser',
			extends: ['plugin:@typescript-eslint/recommended'],
			plugins: ['@typescript-eslint'],
			rules: {
				// Place JS/TS rules here
			},
		},
	],
};
