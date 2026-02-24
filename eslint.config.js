import astro from 'eslint-plugin-astro';
import astroParser from 'astro-eslint-parser';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
	{
		files: ['**/*.astro'],
		languageOptions: {
			parser: astroParser,
			parserOptions: {
				parser: tsParser,
				extraFileExtensions: ['.astro'],
			},
			globals: {
				window: true,
				document: true,
			},
		},
		plugins: {
			astro,
		},
		rules: {
			...astro.configs.recommended.rules,
			// Place Astro-specific rules here
		},
	},
	{
		files: ['**/*.js', '**/*.ts'],
		languageOptions: {
			parser: tsParser,
			globals: {
				window: true,
				document: true,
				process: true,
			},
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
		},
		rules: {
			...tsPlugin.configs.recommended.rules,
			// Place JS/TS rules here
		},
	},
];
