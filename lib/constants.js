// lib/constants.js — dsh-sync 常量集中管理。
export const FORMAT = 'dsh-sync-bundle'
// v2:多 profile + 完整性校验 + 加密搬运。v1 的 bundle 结构已废弃。
export const FORMAT_VERSION = 2

// 凭据引用必须是 POSIX 标识符(凭据 seam 的 REF_PATTERN);带连字符等即非法 ref,
// 说明用户把"明文密钥"错填进了本该写"环境变量名"的字段。
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

// 复制源码目录时忽略的产物/缓存。
export const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'coverage', '.turbo', '.next'])
export const EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])
export const EXCLUDE_SUFFIX = new Set(['.log', '.tmp'])

// 每个 profile 下可移植的声明文件。
export const PORTABLE_PROFILE_FILES = ['cordis.patch.yml', '.npmrc', 'pnpm-workspace.yaml']
// 不随 bundle 带走的机器绑定产物。
export const HOME_SKIP = new Set([
  'profiles', 'plugins', 'sessions', 'storages', 'background', '.anonymous-user-id',
])

// 扫描 settings 时视为"疑似密钥"的字段名后缀。
export const SECRET_KEY_HINT = /(api[_-]?key|token|secret|password|credential)/i
