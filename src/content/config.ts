import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
	type: 'content',
	schema: ({ image }) =>
		z.object({
			title: z.string().max(100),
			excerpt: z.string(),
			date: z.date(),
			author: z.string().optional(),
			updatedDate: z.date().optional(),
			heroImage: image().optional(),
			isDraft: z.boolean().default(false),
			//slug: z.string(),
			tags: z.array(z.string()).default(['General']),
		}),
});

export const collections = { blog };
