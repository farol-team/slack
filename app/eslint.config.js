import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    'dist',
    // shadcn components are vendored, not written here: `npx shadcn add`
    // copies them in and the next copy overwrites whatever we changed. They
    // trip `react-refresh/only-export-components` because they export their
    // variants beside the component, which is how upstream ships them — so
    // linting them is a rule this project cannot act on, and a rule nobody
    // can act on is the one that teaches people to ignore the whole report.
    //
    // Anything we write lives outside this directory and is linted.
    'src/components/ui/**',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
])
