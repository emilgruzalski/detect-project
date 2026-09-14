// Bundles src/index.ts and every dependency into a single ESM file that the runner executes directly.
// See: https://rollupjs.org/introduction/
import commonjs from '@rollup/plugin-commonjs'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

const config = {
  input: 'src/index.ts',
  output: {
    esModule: true,
    file: 'dist/index.js',
    format: 'es',
    sourcemap: true,
  },
  plugins: [typescript({ tsconfig: './tsconfig.json', include: ['src/**/*.ts'] }), nodeResolve({ preferBuiltins: true }), commonjs()],
}

export default config
