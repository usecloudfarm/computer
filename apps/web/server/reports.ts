import { z } from "zod";
import { createAction, createApp } from "@cloudfarm/computer";

/**
 * A stand-in app, so the playground has something to *do* besides read files
 * and needs no third-party credentials to show a write-shaped action.
 *
 * It is a real app plugin — Zod schemas, use cases that feed search, a
 * handler — not a mock. Swap it for `slack({ apiKey })` and the UI is
 * unchanged.
 */
const published: { title: string; body: string; at: number }[] = [];

export const reports = createApp({
  id: "reports",
  name: "Reports",
  description: "Publishes finished reports so the team can read them.",
  actions: {
    publish: createAction({
      summary: "Publish a report so the team can read it.",
      useCases: ["publish a report", "share results", "send the summary to the team"],
      sideEffects: "write",
      input: z.object({
        title: z.string().describe("Short title for the report."),
        body: z.string().describe("Markdown body."),
      }),
      output: z.object({ url: z.string(), publishedAt: z.number() }),
      example: '{ title: "Q4", body: "# Q4\\n…" }',
      handler: (input) => {
        const at = Date.now();
        published.push({ ...input, at });
        return {
          url: `https://reports.internal/${encodeURIComponent(input.title)}`,
          publishedAt: at,
        };
      },
    }),

    list: createAction({
      summary: "List reports published so far.",
      useCases: ["list reports", "what has been published"],
      sideEffects: "read",
      input: z.object({}),
      output: z.object({ titles: z.array(z.string()) }),
      example: "{}",
      handler: () => ({ titles: published.map((report) => report.title) }),
    }),
  },
});
