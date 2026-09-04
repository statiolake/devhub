import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Build output. The VS Code submodule is not linted at all: DevHub
    // consumes it.
    ignores: ["dist", "out"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // A leading underscore is how this codebase says "part of the shape,
      // deliberately unused".
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The ambient declarations VS Code's own sources are compiled against are
    // reached the only way ambient globals can be: by reference.
    files: ["**/*.d.ts"],
    rules: { "@typescript-eslint/triple-slash-reference": "off" },
  },
  {
    // `.cjs` is CommonJS by extension, so `module` and `require` are globals
    // rather than undefined names.
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },
  {
    // Near-verbatim copies of VS Code's entry points. They are kept diffable
    // against upstream, so upstream's unused bindings stay where they are.
    files: ["src/main/main.ts", "src/main/codeMain.ts"],
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
);
