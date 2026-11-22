// Minimal flat config (S-70). Goal: catch real bugs (unused vars, unreachable code, floating mistakes) without style noise.
// Style/type rules that the existing code base violates widely are downgraded to "off" and listed so they can be tightened later.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "playwright-report/**", "test-results/**", "data/**", "public/**", "**/*.cjs", "scripts/_probe*.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,mjs}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/exhaustive-deps": "warn",
      "no-irregular-whitespace": "off", // Telugu / zero-width characters are deliberate in copy and moderation word lists
      "no-misleading-character-class": "off", // same: Indic combining marks in character classes
      "preserve-caught-error": "off",
      "no-self-assign": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      // Allow-listed noise (the code base uses these deliberately; revisit per story):
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",
      "no-control-regex": "off",
      "no-async-promise-executor": "off",
      "no-prototype-builtins": "off",
      "prefer-const": "warn",
    },
  },
);
