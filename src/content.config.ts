import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    date: z.coerce.date(),
    tags: z.array(z.string()).optional(),
    draft: z.boolean().default(false),
    // Header image, also used as the og:image link-preview image and (once
    // uploaded) Sequoia's native coverImage. Resolved and resized by the
    // sync script, same as body-embedded images.
    image: z.string().optional(),
    // Written back by `sequoia sync --update-frontmatter`
    atUri: z.string().optional(),
  }),
});

// Static nav pages (Start here, Now, Links), synced from the vault's _PAGES
// folder the same way posts are. Not published to the network - just content.
const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
  }),
});

export const collections = { posts, pages };
