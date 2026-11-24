import { defineCollection, z } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

/**
 * Declares where Starlight finds pages. Without it the sidebar's slugs
 * resolve to nothing and the build fails naming the first one.
 *
 * No `i18n` collection: this site is English only. Starlight notes its
 * absence on each build, which is quieter than declaring one that is empty —
 * that warns twice.
 *
 * The `app` block is what makes the catalogue build itself. An app page
 * carries what the card needs, so adding an app is adding one file rather
 * than a file and a row in a list that will drift from it.
 */
export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        app: z
          .object({
            /** The npm package, shown on the card. */
            package: z.string(),
            /** What a developer passes to construct it. */
            credential: z.enum(["none", "api-key", "api-token"]),
            /** Two initials or a short mark, in place of a logo we cannot ship. */
            mark: z.string().max(2),
            /** Ordering within the catalogue; lowest first. */
            order: z.number().default(50),
          })
          .optional(),
      }),
    }),
  }),
};
