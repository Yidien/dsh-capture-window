// tsdown 构建配置:产出 dsh 浏览器端 factory 形式的 client bundle。
// host 侧由 tsc 编译到 lib/index.js(main 入口),client 侧预构建成单个 CJS bundle,
// 必须包成 window.__ModuleLoader__.load({ id, factory }) 形式,
// 由 dsh-client-modules 经 /plugins 提供给浏览器。
import { defineConfig } from 'tsdown';

const PLUGIN_ID = 'dsh-capture-window';

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  format: ['cjs'],
  outDir: 'dist',
  clean: true,
  // React 与 @deepseek-ai/* 由 web shell 的模块表提供,不打进 bundle
  external: [
    /^@deepseek-ai\//,
    'react',
    'react/jsx-runtime',
    'zustand',
  ],
  sourcemap: true,
  outputOptions: {
    banner: `window.__ModuleLoader__.load({\n\tid: "${PLUGIN_ID}",\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
    footer: `\t\treturn module.exports;\n\t}\n});`,
  },
});
