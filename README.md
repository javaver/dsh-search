# dsh-search

DeepSeek Harness 插件：一次调用，把 bing.com / baidu.com / sogou.com / so.com 四个引擎的**第一页**结果抓回来，去重合并成最多 ~100 条。

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/javaver/dsh-search)

- 一个工具：`serp_search`
- 只打第一页，不翻页
- 每引擎独立 Cookie 会话 + 独立限速 + 被封后的冷却期
- 站点（URL）去重 + 标题去重 + 站点×标题去重

## 安装

```bash
# 推荐：从 GitHub 源码安装（自动读取仓库里的 dsh.bundle.patch 并加进 profile）
dsh plugin --profile web add github:javaver/dsh-search

# 或本地打包后装 tarball
pnpm pack && dsh plugin --profile web add ./dsh-search-0.1.0.tgz
```

桌面端也可以点「插件」页 → 安装 → 粘贴 `github:javaver/dsh-search`。装完**重启 dsh**，工具列表里出现 `serp_search` 即成功。

插件本身**零运行时依赖**，只用 Node 内置模块（`node:https` / `node:zlib` / `fetch`）；`ctx.tools` 由 DeepSeek Harness 提供。

## 先说结论：第一页能拿多少

参数是实测出来的（本机住宅 IP，2026-10）：

| 引擎 | 单页上限 | 实测每页 | 第一页最多 | 能不能凑到 100 |
|---|---|---|---|---|
| Bing（cn.bing.com） | `count=50` 无效 | 9–12 条 | **~70**（7 个变体查询） | 只有它接近 |
| 百度 | `rn=50` 有效 | 5–42 条（波动大） | **~50–80**（1–2 个变体） | 会验证码，通常 0 |
| 搜狗 | `num=50` 无效 | 9–12 条 | **~20**（2 个变体） | 不能 |
| 360 | `pn=2` 返回空 | 7–15 条 | **~15**（7 个变体） | 不能 |

**"一次搜索 100 条、只搜第 1 页"在技术上做不到。** 第一页的定义就是排行榜的前 N 名，四个引擎第一页加起来物理上限大约是 40–60 条独特结果；Bing 会复读它的前 10 名，所以靠"同意图的多变体查询"能把**抓取量**堆到 ~100，但**去重后**通常落在 20–45。

本插件采取的策略：`harvested`（原始抓取行数）对得上 ~100，`results`（去重后）是真实可用的结果，两个数字都写在诊断里，不糊弄。

想要真·100 条不同结果，只有一条路：抓第 2、3 页（`first=11/21`、`pn=2/3`、`page=2/3`）。这违反你给的约束，所以默认没做；`cdp=true` 模式（见下）也不翻页。

## 本地开发（不装包）

profile 的 patch 可以直接指向本地模块——`insert` 行的 `name` 支持绝对路径和 file URL：

```yaml
# $DSH_HOME/profiles/desktop/cordis.patch.yml
- insert:
    - id: dsh-search
      name: 'file:///D:/doc/2026/dsh-search/dsh-search/lib/index.js'
      inject: [tools]
      config:
        enabled: true
        defaultSites: [bing, baidu, sogou, so360]
        maxResults: 100
```

改完 patch：开着 HMR 的 profile 会自动重组；桌面端最省事直接**重启 dsh**。

## 工具参数

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | string | 必填 | 查询词，中英文都行 |
| `sites` | string[] | `config.defaultSites` | 只查哪几个：`bing` / `baidu` / `sogou` / `so360`（也认 `bing.com` 这类域名） |
| `maxResults` | int | 100 | 去重后的返回条数上限 |
| `dedupe` | bool | true | 关掉就是原始抓取（能看到每引擎的复读） |

返回结构：

```json
{
  "query": "...",
  "results": [{ "rank": 1, "title": "...", "url": "https://...", "snippet": "...", "site": "...", "engine": "bing", "favicon": "data:image/..." }],
  "truncated": false,
  "diagnostics": ["Bing: 70 rows (7 requests, 4420 ms)", "百度: 0 rows (1 request, 400 ms) — captcha / anti-bot page", "..."]
}
```

`diagnostics` 是故意给模型和你看的：哪个引擎给了多少、发了几次请求、是不是被抓了验证码、冷却还剩多少秒。

## 配置

```yaml
config:
  enabled: true                      # false = 完全不注册工具（web_search 不受影响）
  defaultSites: [bing, baidu, sogou, so360]
  maxResults: 100
  timeoutMs: 25000                   # 单请求超时；工具总超时 = 4×
  retries: 1                         # 单请求重试次数
  dedupe: true
  fetchFavicons: true                # 抓 favicon.ico 以内联 data URL（卡片的图标）
  httpProxy: ''                      # 留空 = 跟随进程的 HTTPS_PROXY/NO_PROXY
  engines:
    bing:  { enabled: true, count: 50, concurrency: 1, minGapMs: 700,  cooldownMs: 60000 }
    baidu: { enabled: true, rn: 50,    concurrency: 1, minGapMs: 1200, cooldownMs: 180000 }
    sogou: { enabled: true, num: 50,   concurrency: 1, minGapMs: 1000, cooldownMs: 90000 }
    so360: { enabled: true, rn: 50,    concurrency: 1, minGapMs: 1200, cooldownMs: 90000 }
```

- `minGapMs` 是这个引擎两次请求之间的最小间隔（同引擎内串行，不同引擎并行）。
- `cooldownMs` 是撞到验证码后多久不再碰这个引擎——一个 call 撞上，后面几个 call 直接跳过它，不浪费也加深封锁。

## 为什么这么做（踩过的坑）

1. **不能用 `fetch()`。** 四个引擎靠 Cookie 路由，不靠查询词：
   - 百度**必须先 GET `https://www.baidu.com/`** 拿 `BAIDUID`。冷启动直连 `/s` 一律 302 到 `wappass.baidu.com` 图形验证码；先握手再查，实测同一条查询从 0 条变成 42 条。
   - 搜狗 / 360 冷启动直接给 `verify.css` / `qcaptcha.so.com` 反爬页。
   所以插件用 `node:https` + 每引擎一个 keep-alive Agent + 一个 Cookie 罐。

2. **`fetch` 的 UA 会被引擎判死。** 现在四个引擎都认 UA：`undici` 默认 UA 直接吃验证码。插件写死 Chrome/131 Windows 的完整指纹（`sec-ch-ua`、`sec-fetch-*` 等）。

3. **代理走 Node 自带的。** Node 24 的 `https.Agent({ proxyEnv })` 原生支持 `HTTPS_PROXY`（含 CONNECT 隧道，已实测），与 dsh 自己的 `@deepseek-ai/dsh-http-proxy` 策略一致，不用额外依赖。

4. **解析用"块切分"而不是 DOM。** 每个引擎用一个固定容器开口标记切块，取每块第一个标题锚点。500 KB 的反爬页面转 DOM 又慢又脆。

5. **引擎自己的站内链接要扔掉。** Bing 会把"Bing / 搜索 - Microsoft 必应"这类品牌模块渲染成 `b_algo`，标题锚点指回 `bing.com`。不过滤的话结果第一条永远是引擎自己。

6. **不去重 = 假 100 条。** `python 异步` 这条查询，Bing 七个变体抓了 70 行，其中 `docs.python.org` 出现 13 次、`www.python.org` 12 次——全是同一批 TOP10 复读。三重去重后剩 23 条真结果。

## 关于验证码 / 本机 IP 限流

本机实测：连续几十次请求后，百度、360 对住宅 IP 进入分钟级封锁（百度 `wappass` 图形验证码、360 `qcaptcha`），搜狗大约 3 次页面就拦。这是引擎侧策略，不是插件 bug。缓解手段：

- 按引擎配 `minGapMs` / `cooldownMs`（已内置）
- 换出口 IP：`httpProxy` 指一个 HTTP 代理（本插件只支持 http(s) 代理）
- 真要稳定绕过，得上 `cdp=true` 的浏览器模式（见下）

## 可选：`cdp` 浏览器模式（默认关闭）

纯 HTTP 会被 IP 限流，浏览器模式能显著延长存活。方案：

1. 用本机 Chrome 开调试端口：`chrome.exe --remote-debugging-port=9222`
2. `config.cdp = true`，可选 `cdpEndpoint: 'http://127.0.0.1:9222'`
3. 插件会：找到/新建一个 tab → `Page.navigate` 到 SERP → 等 DOM 稳定 → `Runtime.evaluate` 取 `document.documentElement.outerHTML` → 交给同一套 parser

只加载一次页面，还是只打第一页。`lib/cdp.js` 已实现并接进 `lib/tool.js` 的取页分支，默认关闭。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | cordis 插件入口（`name` / `inject` / `apply`） |
| `lib/tool.js` | `serp_search` 工具定义、会话池、引擎调度、卡片呈现 |
| `lib/engines.js` | 四个引擎的 URL / 变体 / 解析 / 封禁判定 |
| `lib/http.js` | node:https 客户端、Cookie 罐、Keep-Alive Agent、限速闸门、GB18030 解码 |
| `lib/html.js` | 实体解码、标签剥离、块切分、绝对化 URL |
| `lib/merge.js` | 三轮去重 + 按名次轮转合并 + 文本渲染 |
| `lib/favicon.js` | favicon 内联成 data URL（带缓存与大小上限） |
| `lib/cdp.js` | Chrome DevTools Protocol 浏览器模式（可选） |
| `lib/config.js` | 配置归一化 |
| `cordis.patch.yml` | bundle 层：一行 insert，带全部默认值 |

## 已知限制

- 第一页去重后通常 20–45 条，凑不满 100（见上表）
- 百度/360 对同一 IP 有分钟级封锁，`cooldownMs` 只能缓解，换 IP 才根治
- 搜狗 `/link?url=` 是加密跳转，部分行只能保留跳转地址
- 只支持 http(s) 代理，不支持 SOCKS

## 许可

MIT
