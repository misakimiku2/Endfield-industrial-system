// ESM loader hook: 让 Node 的 --experimental-strip-types 能解析无后缀的相对 import。
//
// 背景: Node 的 type-stripping 模式只剥离类型注解，不做模块解析魔法——
// `import { X } from './foo'` 会因找不到 './foo' 报 ERR_MODULE_NOT_FOUND
// （ESM 要求显式后缀，且 './foo.js' 也匹配不到 './foo.ts'）。
// 本 loader 把无后缀的相对/绝对路径 import 重写到 '.ts'（若该文件存在），
// 使 Vite 项目惯用的无后缀 import 在验证脚本里也能跑。
//
// 用法:
//   node --experimental-strip-types \
//        --import 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./scripts/ts-loader.mjs", pathToFileURL("./"));' \
//        scripts/verify-t1.5.ts
//
// 或简写（有弃用警告但可用）:
//   node --experimental-strip-types --experimental-loader ./scripts/ts-loader.mjs scripts/verify-t1.5.ts

export async function resolve(specifier, context, nextResolve) {
  const isRelative =
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/');
  const hasExt = /\.(ts|js|mjs|cjs|json|node|css|svg|png)(\?|$)/.test(specifier);
  if (isRelative && !hasExt) {
    try {
      return await nextResolve(specifier + '.ts', context);
    } catch {
      // '.ts' 不存在则落到默认解析
    }
  }
  return nextResolve(specifier, context);
}
