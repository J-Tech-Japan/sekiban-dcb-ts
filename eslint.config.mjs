import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules", "**/dist/**", "dist", ".wrangler", "**/.wrangler/**", ".artifacts", "**/.artifacts/**", "coverage"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.worker,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs", "test/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["packages/dcb-domain/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["@sekiban/*", "node:*", "fs", "net", "http"], message: "The domain authoring layer must remain runtime-free." },
        ],
      }],
      "no-restricted-globals": ["error", "Date", "fetch", "process", "globalThis"],
      "no-restricted-properties": ["error",
        { object: "Date", property: "now", message: "Inject TimeProvider instead of reading the clock." },
        { object: "Math", property: "random", message: "Inject deterministic data instead of using Math.random." },
      ],
      "no-restricted-syntax": ["error", {
        selector: "NewExpression[callee.name='Date']",
        message: "Inject TimeProvider instead of constructing Date.",
      }],
    },
  },
  {
    // The sample domain is the authoring boundary.  A cast here can hide a
    // legacy payload/tag shape and therefore must be caught by the same lint
    // lane that checks the rest of the repository.
    files: ["samples/meeting-room/src/domain.ts", "**/.g29-domain-source-*/src/domain.ts"],
    rules: {
      "no-restricted-syntax": ["error",
        {
          selector: "TSAsExpression",
          message: "Domain authoring source must not use `as` casts; keep the parsed event/tag contract typed.",
        },
        {
          selector: "TSTypeAssertion",
          message: "Domain authoring source must not use type assertions; keep the parsed event/tag contract typed.",
        },
      ],
    },
  },
);
