import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

/**
 * Declares where Starlight finds pages. Without it the sidebar's slugs
 * resolve to nothing and the build fails naming the first one.
 *
 * No `i18n` collection: this site is English only. Starlight notes its
 * absence on each build, which is quieter than declaring one that is empty —
 * that warns twice.
 */
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
