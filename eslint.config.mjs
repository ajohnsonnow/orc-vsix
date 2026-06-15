import globals from "globals";
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import pluginJs from "@eslint/js";

// CUSTOMIZE: uncomment for Vue projects
// import pluginVue from "eslint-plugin-vue";

// CUSTOMIZE: uncomment for React projects
// import pluginReact from "eslint-plugin-react";
// import pluginReactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      ".vitepress/cache",
      "**/*.d.ts",
      // Build tooling lives outside the build tsconfig; don't type-lint it.
      "**/*.config.{js,mjs,cjs,ts,mts,cts}",
      "scripts/",
    ],
  },
  {
    files: ["**/*.{ts,mts,tsx,js,mjs,cjs}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
      },
    },
  },
  pluginJs.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  sonarjs.configs.recommended,
  // CUSTOMIZE: uncomment for Vue projects
  // ...pluginVue.configs["flat/recommended"],
  // CUSTOMIZE: uncomment for React projects
  // pluginReact.configs.flat.recommended,
  // pluginReactHooks.configs["recommended-latest"],
  {
    files: ["**/*.{ts,mts,tsx,js,mjs,cjs}"],
    rules: {
      complexity: ["error", 25],
      "sonarjs/cognitive-complexity": ["error", 25],
      "no-console": ["warn", { allow: ["error", "warn"] }],
      // Raw line count is noise here — the codebase favors cohesive streaming/pipeline
      // functions; the complexity rules above are the meaningful gate for "too much".
      "max-lines-per-function": "off",
      // Numbers/booleans interpolate cleanly into template strings — allow them.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      // Underscore-prefixed args/vars are intentionally unused.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      // Seeds/jitter use Math.random; no cryptographic randomness in this extension.
      "sonarjs/pseudo-random": "off",
      // Too aggressive for defensive guards on loosely-typed external/streaming data.
      "@typescript-eslint/no-unnecessary-condition": "off",
      // Fire-and-forget `void promise()` and void-returning arrows are intentional here.
      "@typescript-eslint/no-confusing-void-expression": "off",
    },
  },
  {
    // Test files live outside the build tsconfig; lint them without type-aware
    // rules so the project service doesn't fail to resolve them.
    files: ["src/test/**", "test/**"],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      complexity: "off",
      "sonarjs/cognitive-complexity": "off",
      "max-lines-per-function": "off",
      "sonarjs/no-duplicate-string": "off",
      // Non-null assertions and underscore throwaways are normal in test fixtures.
      "@typescript-eslint/no-non-null-assertion": "off",
      "sonarjs/no-unused-vars": "off",
    },
  },
];
