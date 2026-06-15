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
      complexity: ["error", 15],
      "sonarjs/cognitive-complexity": ["error", 15],
      "no-console": ["warn", { allow: ["error", "warn"] }],
      "max-lines-per-function": ["warn", { max: 60, skipBlankLines: true, skipComments: true }],
    },
  },
];
