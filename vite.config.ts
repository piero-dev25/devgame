import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as NodeURL from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "~": NodeURL.fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: [
      "**/.repos/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-electron/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
  staged: {
    // Formatter only for now — no lint or typecheck on commit.
    //
    // The pattern lists the extensions `vp fmt` can actually format, rather
    // than `"*"`. With `"*"`, a changeset whose staged files are ALL
    // unformattable (a Unity `.meta`-only commit, a `.sh`-only commit, an
    // image-only commit) handed `vp fmt` a file list it filtered down to
    // nothing and the hook died on
    //   "Expected at least one target file. All matched files may have been
    //    excluded by ignore rules."
    // — a commit blocked for a reason that has nothing to do with the change
    // (task #64). That failure is what teaches people to reach for
    // `--no-verify`, which in this repo also skips the formatter, so the
    // habit it breeds is worse than the bug.
    //
    // The extension set is measured, not assumed: each was run through
    // `vp fmt --check` on a scratch file. Formattable = exit 0 (clean) or 1
    // (needs reformatting); NOT formattable = exit 2, the empty-target error
    // above. `.sh`, `.meta`, `.gd`, `.txt`, `.svg` and images are exit 2.
    // Adding an unformattable extension here reintroduces #64 for that type.
    "*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json,jsonc,md,css,scss,html,yml,yaml}": "vp fmt",
  },
  fmt: {
    ignorePatterns: [
      ".reference",
      ".repos/**",
      ".plans",
      ".alchemy",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/web/public/mockServiceWorker.js",
      "apps/web/src/lib/vendor/qrcodegen.ts",
      "apps/mobile/uniwind-types.d.ts",
      "*.icon/**",
      // GDScript/Godot project files (.gd, .gd.uid, .tscn, .godot's
      // config-format .tres, project.godot) — not JS/TS, same reasoning as
      // the mobile native trees above: `vp fmt`'s formatter has no business
      // touching them.
      //
      // CORRECTION (task #64): this entry was added when a Godot-only
      // changeset (task #48) failed the commit hook with "Expected at least
      // one target file", and was believed to have fixed it. IT DID NOT.
      // Measured in an isolated repo reproducing this exact config: a
      // godot-only commit failed identically WITH `godot/**` present,
      // because an `fmt` ignore rule filters files AFTER `vp fmt` has been
      // invoked — it cannot stop the invocation happening with a list that
      // then empties. Only the `staged` pattern above decides whether
      // `vp fmt` runs at all, which is why the real fix lives there.
      // Keeping this entry anyway: it is still correct as a statement that
      // the formatter must not rewrite Godot files if one is ever passed
      // explicitly.
      "godot/**",
    ],
    sortPackageJson: {},
    overrides: [
      {
        files: [".devcontainer/devcontainer.json"],
        options: {
          trailingComma: "none",
        },
      },
    ],
  },
  lint: {
    ignorePatterns: [
      ".repos",
      ".repos/**",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/uniwind-types.d.ts",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-t3code/index.ts"],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@t3tools/client-runtime",
              message:
                "Import from an explicit @t3tools/client-runtime/* subpath. The package has no root export.",
            },
          ],
        },
      ],
      "t3code/no-global-process-runtime": "error",
      "t3code/no-inline-schema-compile": "warn",
      "t3code/no-manual-effect-runtime-in-tests": "error",
      "t3code/namespace-node-imports": "error",
    },
    options: {
      // Revisit once Oxlint's tsgolint path can integrate with @effect/tsgo diagnostics.
      typeAware: false,
      typeCheck: false,
    },
  },
});
