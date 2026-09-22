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

// 已知密钥格式的值前缀/模式 —— 即使字段名不含 key/token 等关键词,
// 值匹配这些模式也几乎可以确定是明文密钥(参考社区凭据筛查的通用工程实践,
// 不含任何第三方源码)。用于补充 isSecretLine 的值侧判断。
export const SECRET_VALUE_PATTERNS = [
  /^ghp_[A-Za-z0-9]{20,}$/,           // GitHub PAT
  /^github_pat_[A-Za-z0-9_]{20,}$/,   // GitHub fine-grained PAT
  /^sk-[A-Za-z0-9]{16,}$/,            // OpenAI / DeepSeek / Anthropic 等
  /^AKIA[0-9A-Z]{16}$/,               // AWS access key
  /^AIza[0-9A-Za-z_-]{30,}$/,         // Google API key
  /^xox[baprs]-[A-Za-z0-9-]+$/,      // Slack token
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key
  /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./, // JWT
]

// 绝对路径模式 —— 用于扫描 settings.yaml / cordis.patch.yml 中的机器绑定路径,
// 导出时记录到 manifest,apply 时在目标机上检测并提示重映射。
export const WINDOWS_PATH_RE = /[A-Za-z]:[\\/](?:[^\s"'`,;|<>{}[\]()]+[\\/])+[^\s"'`,;|<>{}[\]()]+/g
export const POSIX_PATH_RE = /(?:\/(?:home|Users|tmp|opt|var|usr|mnt|media|root)\/[^\s"'`,;|<>{}[\]()]+)/g
