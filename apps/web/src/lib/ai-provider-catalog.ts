// 单一来源:@bourse/shared-types(同时由 GET /api/settings/providers/catalog 提供)。
// 构建期内联打包——无需额外 fetch,后端未就绪时也能展示内置模板。
export { BUILTIN_PROVIDER_CATALOG } from '@bourse/shared-types';
export type { BuiltinProviderTemplate } from '@bourse/shared-types';
