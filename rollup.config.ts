// Bundles src/index.ts and every dependency into a single ESM file that the runner executes directly.
// Sucrase only strips types; type checking is done separately by `npm run typecheck`.
// See: https://rollupjs.org/introduction/
import commonjs from '@rollup/plugin-commonjs'
import nodeResolve from '@rollup/plugin-node-resolve'
import sucrase from '@rollup/plugin-sucrase'

const config = {
  input: 'src/index.ts',
  output: {
    esModule: true,
    file: 'dist/index.js',
    format: 'es',
    sourcemap: true,
  },
  plugins: [
    nodeResolve({ preferBuiltins: true, extensions: ['.ts', '.js', '.json'] }),
    sucrase({ transforms: ['typescript'], include: ['src/**/*.ts'] }),
    commonjs(),
  ],
}

export default config
