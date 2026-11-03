// lib/patch-guard.js — cordis.patch.yml 的宿主兼容性守卫。
//
// 为什么要有这个文件：实测教训 P7 —— 旧机导出的 cordis.patch.yml 里带着
// `models: []`，宿主 0.2.1 对该字段的裁决是「no longer configurable」，
// 结果 llm-deepseek-account 整个条目拒绝激活。全链路（导出 → bundle → apply
// → 宿主）没有任何一环报错，用户只看到「插件没了」。
//
// 为什么是硬编码清单而不是 schema：宿主不接受任何字段级 schema 查询，配置项
// 的生死只在宿主源码里。硬编码的代价是清单会过期 —— 所以每条都必须带出处
// （哪个宿主版本、什么报错），宿主升级后若条目又能配了，删掉那行即可；
// 新发现一个拒绝字段，加一行。误报的代价只是一条 WARN，漏报的代价是插件
// 静默消失，宁可多嘴。
//
// 只扫这一份清单不解析整份 YAML：patch 文件的合法结构随宿主版本变化，
// 自制解析器比字段名匹配更容易引入新问题。字段名按行首缩进 + 冒号匹配，
// 注释行（# 开头）不算。

/** 已知会被宿主拒绝的配置字段。每条都要有实测出处。 */
const REJECTED_FIELDS = [
  {
    field: 'models',
    reason: '宿主 0.2.1 起不再允许通过 cordis.patch.yml 配置 models'
      + '（实测报错：models is no longer configurable；Remove models from this entry），'
      + '携带该字段的条目会被整条拒绝激活',
  },
]

/**
 * 扫描一份 cordis.patch.yml 文本，找出会被宿主拒绝的字段。
 * @param {string} text - 文件内容。
 * @returns {Array<{field:string, line:number, reason:string}>} 命中清单（可能为空）。
 */
export function scanHostRejectedFields(text) {
  const hits = []
  if (typeof text !== 'string' || text === '') return hits
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    for (const { field, reason } of REJECTED_FIELDS) {
      // 顶层或嵌套的 `models:` / `models :`；不匹配 models-xxx、xmodels 等其它键。
      const re = new RegExp('^' + field + '\\s*:')
      if (re.test(line)) {
        hits.push({ field, line: i + 1, reason })
        break
      }
    }
  }
  return hits
}

/**
 * 把命中清单转成 dsh-sync 风格的 warning 对象。
 * @param {string} text - 文件内容。
 * @param {string} where - 告警定位（如 'cordis.patch.yml' 或 'profile desktop:cordis.patch.yml'）。
 * @returns {Array<{where:string, preview:string, reason:string}>}
 */
export function patchGuardWarnings(text, where) {
  return scanHostRejectedFields(text).map((h) => ({
    where,
    preview: `第 ${h.line} 行：${h.field}:`,
    reason: `[P7] ${h.reason}。落地前请从 patch 文件删除该字段（宿主会自己生成默认值），否则该条目不会激活`,
  }))
}
