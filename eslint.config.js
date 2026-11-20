import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts", "**/coverage/**", "**/.wrangler/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The isomorphism gate. @cloudfarm/core must run unchanged on Workers, so
    // nothing in it may reach for a Node built-in. The matching guarantee is
    // `pnpm test:workers`, which runs core's suite under workerd; this rule
    // just fails faster and with a better message.
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*"],
              message:
                "@cloudfarm/core is isomorphic: no node: imports. Put platform code in a leaf package.",
            },
          ],
        },
      ],
      // The DOM lib is on for fetch/streams/URL, which drags in browser-only
      // globals that do not exist on Workers or Node. Ban them explicitly.
      "no-restricted-globals": [
        "error",
        { name: "process", message: "@cloudfarm/core is isomorphic: take env through options." },
        { name: "Buffer", message: "@cloudfarm/core is isomorphic: use Uint8Array." },
        { name: "window", message: "Not available on Workers or Node." },
        { name: "document", message: "Not available on Workers or Node." },
        { name: "localStorage", message: "Not available on Workers or Node." },
        { name: "sessionStorage", message: "Not available on Workers or Node." },
        { name: "XMLHttpRequest", message: "Use fetch." },
      ],
    },
  },
  prettier,
);
