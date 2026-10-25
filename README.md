# GitHub代理服务

## 项目概述

这是一个基于Cloudflare Workers的GitHub代理服务，允许通过替代域名访问GitHub资源，解决某些网络环境下GitHub访问受限的问题。代理服务通过域名映射和资源转发，提供无缝的GitHub浏览体验。

## 特性

- **子域名匹配系统**：使用 `gh.` 前缀作为GitHub主站的代理入口，支持任何域名后缀
- **完整的资源映射**：支持GitHub相关的所有主要域名，包括API、静态资源、用户内容等
- **内容替换**：自动替换响应中的所有域名引用，确保链接正常工作
- **路径修复**：解决嵌套URL路径问题，特别针对仓库提交信息等特殊路径
- **安全重定向**：对敏感路径（如登录页面）进行安全重定向
- **HTTPS强制**：自动将HTTP请求升级为HTTPS
- **下载链接独立代理**：release 资产、源码包、raw 文件自动改写为 `g.您的域名/https://github.com/...`，直连流式下载，省去 302 签名跳转
- **流式 HTML**：边接收、边改写、边返回，减少等待整个页面下载完成的白屏时间
- **有限缓存**：仅对源站允许缓存的匿名公开响应复用结果，可变内容最多额外延迟一分钟更新

## 本地提速版本

默认入口仍为 `src/index.js`（Service Worker），备用入口为可单文件粘贴的 `src/snippet.js`（Module）。两个入口的性能逻辑一致；备用入口原有的统计脚本保留，默认入口不会注入统计脚本。修改默认入口后运行 `npm run sync:snippet` 同步备用文件，测试会检查两者是否一致。

### 缓存规则

- 使用 Worker 内部 Cache API，在地域跳转和域名校验之后查询，不需要 KV、R2 或其他云端资源。
- 可变资源前 30 秒直接使用已有结果，第 30～60 秒先返回结果并后台更新；达到 60 秒必须重新获取。若源站剩余有效期更短，以更短时间为准；上游 Age/Date 也计入有效期。
- 浏览器每次重新验证页面，避免浏览器与边缘缓存时间叠加。只有带内容版本、且源站明确标记 `immutable` 的静态资源保留更长有效期。
- 携带 Cookie、Authorization、Range、Access 凭据、强制刷新指令或敏感签名参数的请求不会进入共享缓存。只保存 200 GET；不缓存设置 Cookie、`private`、`no-store`、`no-cache`、`Vary: *`、重定向或错误响应。
- 缓存键隔离完整域名、路径、查询和请求表示变体；默认入口与备用入口也相互隔离。不缓存按连接位置变化的 Vary 响应。
- 缓存副本限制为 8 MiB；超出限制仍向客户端提供原响应，只跳过缓存。后台刷新失败不会延长旧结果的截止时间。缓存异常时直接回源。
- `X-Proxy-Cache` 响应头为 `MISS`、`HIT`、`STALE` 或 `BYPASS`，便于检查缓存是否生效。GitHub 禁止缓存的页面会显示 `BYPASS`，这是预期行为。
- Cache API 是节点本地缓存，不保证所有节点同时命中。Cloudflare Access 等不支持 Cache API 的环境会回退到直接取内容。

### 本地验证

开发依赖仅用于测试，不是 Worker 的运行依赖：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run verify:all
```

检查包括原有 81 项逻辑验证、模拟时钟的缓存边界/隔离检查，以及 Miniflare/workerd 中的真实 HTMLRewriter、压缩、缓存和下载验证。所有测试上游均为本地模拟，不访问 GitHub 或已部署代理。

`npm run verify:live` 是单独的线上脚本，不包含在上述命令中，本次实现未运行。`node verify/runtime-test.mjs --report` 可以记录受控慢源站下的首段返回、完整返回时间及回源次数；结果仅代表本地合成测试，不是线上提速承诺。

## 支持的域名映射

服务支持以下GitHub相关域名的代理访问：

- github.com → gh.[您的域名]
- avatars.githubusercontent.com → avatars-githubusercontent-com-gh.[您的域名]
- github.githubassets.com → github-githubassets-com-gh.[您的域名]
- api.github.com → api-github-com-gh.[您的域名]
- raw.githubusercontent.com → raw-githubusercontent-com-gh.[您的域名]
- 以及更多GitHub相关服务域名

## 部署指南

### 前提条件

- Cloudflare账户
- 已配置的域名（托管在Cloudflare上）
- 基本的DNS配置知识

### 部署步骤

1. **登录Cloudflare控制台**
   - 进入Workers部分

2. **创建新的Worker**
   - 点击"创建Worker"
   - 将提供的代码粘贴到代码编辑器中
   - 给Worker命名并保存

3. **配置对应其他资源的域名映射**
   - 更改域名映射配置，将所有相关域名指向您的Worker路由
   - 将 `github.com` 指向您的Worker路由域名 `gh.您的域名`
   - 将 `avatars.githubusercontent.com` 等其他资源指向您的Worker路由域名 `avatars-githubusercontent-com-gh.您的域名`

4. **配置DNS记录**
   - 为您的泛域名添加任何命中CDN的记录
   - 例如 `*.您的域名` A记录指向任何IP并开启代理

5. **配置Worker路由**
   - 添加路由 `*-gh.您的域名/*` 和 `gh.您的域名/*` 指向您的Worker

### 配置自定义域名

如果您想使用不同的域名前缀（仅github.com主站），请修改代码中的`domain_mappings`对象，将默认的`gh.`等前缀替换为您喜欢的前缀。

## 使用方法

部署成功后，只需将原始GitHub URL中的域名部分替换为对应的代理域名：

```
# 原始URL
https://github.com/用户名/仓库名

# 代理URL
https://gh.您的域名/用户名/仓库名
```

其他GitHub资源的访问方式类似，系统会自动处理域名映射和内容替换。

### 下载类链接

页面中的**文件下载类**链接（release 资产、源码压缩包、raw 文件）会自动改写为独立下载代理形式：

```
# 页面里生成的下载链接
https://g.您的域名/https://github.com/用户名/仓库名/releases/download/v1.0.0/app.exe
```

- 该形式依赖**同一后缀**下 `g.您的域名` 上部署的 [gh-proxy](https://github.com/hunshcn/gh-proxy)；本项目的 `gh.` Worker 只负责页面浏览与页面内链接改写
- 与 `gh.` 形式不同，这类链接由下载代理直接跟随上游 302 并流式返回，不暴露带签名的 `release-assets-*-gh.` 中转地址，对下载器更友好
- 仓库页、Issue、Release 标签页等页面链接仍走 `gh.您的域名`
- `/blob/` 文件查看页刻意不改写（下载代理会把 `/blob/` 当成 `/raw/` 返回纯文本，破坏文件浏览界面）
- 若未部署 `g.` 下载代理：把 `src/index.js` / `src/snippet.js` 里的 `download_proxy_prefix` 改为 `null`，下载链接会回退为 `gh.` 形式（依然可下载，只是会经过一次 302 跳转）

## 技术说明

### 工作原理

1. 接收对代理域名的请求
2. 识别目标GitHub域名
3. 转发请求到GitHub服务器
4. 接收GitHub的响应
5. 替换响应内容中的域名引用
6. 返回修改后的响应给用户

### 特殊路径处理

代码包含专门的逻辑来处理特殊路径，特别是用于仓库提交信息的路径，解决了嵌套URL问题：

```
/用户名/仓库名/latest-commit/分支名/https://gh.域名/...
```

这类路径会被正确截断并转发到GitHub。

## 安全考虑

- 建议只匿名浏览公开内容，不在代理站登录或传递 Token
- 现有访问逻辑仍会转发请求头和请求体，敏感路径未统一阻断；本版只确保这些请求不进入新增共享缓存
- 原有 CSP 删除及备用入口统计脚本不属于本轮完整安全整改，仍需单独评估
- 所有流量都通过HTTPS加密

## 限制

- 不支持GitHub的登录和注册功能
- 某些高级GitHub功能可能不完全兼容
- 不能代替GitHub CLI或Git等工具的直接连接

## 故障排除

如果遇到问题：

1. 确认DNS记录配置正确
2. 检查Worker是否正常运行
3. 尝试清除浏览器缓存
4. 检查请求和响应日志以获取详细错误信息

## 贡献指南

欢迎提交Pull Request或Issue来改进此项目。特别欢迎以下方面的贡献：

- 增加对更多GitHub相关域名的支持
- 改进内容替换逻辑
- 增强错误处理机制
- 添加性能优化

## 免责声明

此代理服务仅用于教育和研究目的。使用者应确保遵守GitHub的服务条款和当地法律法规。
