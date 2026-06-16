import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import stylistic from "@stylistic/eslint-plugin";

const browserGlobals = {
  document: "readonly",
  HTMLInputElement: "readonly",
  navigator: "readonly",
  window: "readonly",
};

const nodeGlobals = {
  __dirname: "readonly",
  console: "readonly",
  process: "readonly",
};

export default [
  {
    ignores: [
      "build/**",
      "dist/**",
      "node_modules/**",
      "out/**",
      "src/main/gen/**",
      "src/native/gen/**",
      "src/renderer/gen/**",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.ts", "vite.config.ts", "vitest.config.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...browserGlobals,
        ...nodeGlobals,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "react-hooks": reactHooks,
      "@stylistic": stylistic,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@stylistic/semi": ["error", "always"],
      "@stylistic/quotes": ["error", "double", { avoidEscape: true, allowTemplateLiterals: "always" }],
      "@stylistic/object-curly-spacing": ["error", "always"],
      "@stylistic/comma-dangle": ["error", "always-multiline"],
      "@stylistic/quote-props": ["error", "as-needed"],
    },
  },
];
