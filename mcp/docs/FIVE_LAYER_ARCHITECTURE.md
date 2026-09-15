# Second Brain 1.3 五层实现架构

本文描述 `mcp` 包中的 1.3 编译式第二大脑。它与兼容保留的 1.2 请求内索引服务并存；新闭环使用独立离线编译器、runtime catalog、只读在线查询面和人工批准的受控写入面。

## 系统边界

```text
原始 Markdown 来源（权威、可离线）
        │ 仅离线编译或已批准写入时访问
        ▼
OfflineKnowledgeCompiler
        │ checksummed immutable generation
        ▼
Catalog + Lexical + Vector + Derived + Temporal + Hierarchy
        │ READY / atomic CURRENT
        ▼
SecondBrainRuntime（artifact-only query view）
        ├── MCP：查询 + 私有审核 + 受控写入 / 撤销
        └── HTTP：认证后的只读 status / query
```

原始文件始终是事实源。编译产物可删除重建，但包含正文、相对路径、向量和元数据，应按敏感本地数据保护。在线查询路径不会访问 `sourceRoot`；只读来源的原始介质离线时，只要 runtime catalog 和它引用的 generation 可读，服务仍可启动并查询。可写来源只在准备 / 提交写入及随后重新摄取时需要原始目录。

## 第一层：离线编译面

入口是 `src/offlineCompile.ts`，核心为 `OfflineKnowledgeCompiler`。

### 严格先后阶段

1. 规范化可信来源配置，生成稳定 `sourceId`；`projectId` 只来自服务器配置。
2. 有界扫描 `.md` 文件，不跟随 symlink，保护控制目录并拒绝不完整发现。
3. 在同一稳定字节快照上计算 SHA-256、解析严格 frontmatter、标题树、链接、标签和别名。
4. 按标题切块；长区段使用保守 token 上界和有界 overlap，生成 source / document / version / span / chunk 分层 ID。
5. 在同一授权域内按规范化完整正文去重；受限副本不能通过普通副本重新泄漏。
6. 每完成一个文件就原子写 checkpoint，并追加有界 journal；重启后只复用与本轮 plan / policy / content Hash 完全匹配的单元。
7. 构建 Catalog、compact lexical base / delta、Derived、Temporal、Hierarchy 和可选 Vector 层。
8. 发布前重新扫描完整来源并比较 plan Hash，防止编译期间的修改进入旧快照。
9. 验证各层 canonical JSON 和 SHA-256，经 staging 写入完整 generation，写 `READY` 后再原子切换 `CURRENT`。
10. 仅当所有配置来源均完成后，原子发布权限为 `0600` 的 runtime catalog；catalog 为每个来源固定 `generationId + manifestSha256`，在线进程不会因某一个来源先推进 `CURRENT` 而看到混合的新旧来源集合。

来源按顺序编译，避免多个本地 embedding 模型任务同时争抢内存。`--watch` 只是周期触发相同的安全构建；没有变化的文件按内容和策略复用，不把“首次可能很慢”转嫁到查询路径。

### 失败语义

- 文件、策略、UTF-8、安全边界、最终复扫或任何层校验失败：本轮不切换 `CURRENT`。
- 进程中断：旧 `CURRENT` 仍然有效，下一轮可从匹配 checkpoint 恢复。
- 删除：Catalog 保留 tombstone；活跃 Derived / Vector / postings 不再包含该文档。
- embedding 配置变化：policy / recipe 不匹配，必须重编；在线拒绝把不同模型或维度的向量混用。

## 第二层：本地持久化层

每个来源拥有独立 generation 根。一个 bundle 包含：

| 层 | 主要内容 | 在线用途 |
| --- | --- | --- |
| Catalog | path、document / ordinal、content Hash、first / last seen、tombstone、corpus / scope、project | 身份、状态与跨层校验 |
| Lexical | dictionary、LEB128 / base64 postings、document length、base 和 deltas | 可重放的紧凑词法索引及完整性校验 |
| Vector | record / version / values、adapter、model、kind、dimension、输入 recipe | Dense 召回；禁止查询时整库重嵌入 |
| Derived | 标题、别名、标签、链接、heading chunks、term frequencies、正文证据 | 生成在线 record、BM25 / metadata 与 Evidence Pack |
| Temporal | ordinal 对应的 mtime、first / last seen | 时间过滤与最近性召回 |
| Hierarchy | path segments 和完整标题树 | 路径 / 标题层级召回 |

`READY` 表示某一 generation 的 bundle、manifest 和 Hash 链完整；`CURRENT` 是单个来源编译完成时的原子指针。多来源在线可见性再由一次原子发布的 runtime catalog 决定：它固定每个来源的 generation 与 manifest Hash，因此某个来源单独推进 `CURRENT` 不会改变旧 catalog 的一致快照。runtime loader 会交叉验证 schema、source / project、ordinal、活动文档、chunk / record / version、Lexical materialization 和 Vector 覆盖。任何单层虽然 Hash 正确但语义不一致，也不会被加载。

runtime catalog 是本机私有引导文件，不是用户知识数据库。它保存逻辑 label、来源种类、generation 根、固定 generation / manifest Hash 和 embedding 契约；仅可写目录还保存 Writer / compiler 的私有定位。API 不返回这些绝对定位，仓库也不得包含实际 catalog、generation 或任何运行状态。

## 第三层：在线查询面

入口是 `SecondBrainRuntime.query()`；创建 runtime 时会一次性加载并校验所有配置来源，然后原子发布一个内存查询视图。

### 授权先于召回

Principal 由服务器环境创建，包括允许的 source、project、mode 和 path prefixes。请求的 `source_ids`、`project_ids` 等仅与 Principal 求交集。带 `projectId` 的记录必须命中允许项目，即使调用方请求了更宽 mode 也不能绕过。每个 retriever 获得同一可见 record 集，融合后再次过滤。

### 并行召回与串行收敛

BM25、Dense、Metadata、Temporal 和 Hierarchy retriever 并行执行；每路结果只保留结构化 channel / rank 诊断，适配器自报的任意文本不会进入 Evidence Pack。随后按以下顺序收敛：

```text
five rankings
→ weighted Reciprocal Rank Fusion
→ optional loopback reranker
→ visibility recheck
→ near-duplicate suppression
→ MMR-style diversity selection
→ sentence-aware extractive compression
→ bounded Evidence Pack
```

Dense 向量使用同一个 `hybrid-record-search-text-v1` 输入 recipe，覆盖 title、heading、正文及受控元数据。默认 deterministic adapter 是本地、可复现的词法 Hash 向量，主要提供零依赖闭环；真实语义检索可配置固定 `127.0.0.1` 的 embedding 服务。Reranker 同样只允许固定 loopback host 和固定 `/v1/rerank` 路径，不能通过环境变量重定向到远端 URL。

### 五秒契约与拒答

runtime 把调用方 deadline 限制在最多 5,000 ms，并为收尾留出小幅 guard。内置循环周期检查 `AbortSignal` / `deadlineAt`；任一阶段耗尽预算时返回 `timeout` 且不发布迟到证据。无可见证据返回 `no_evidence`，来源 / retriever 失败返回显式 `source_failure` 或受控 partial 状态。Evidence Pack 始终携带 source、document、version、record、相对 path、行号和分数组件，可追溯而非只给模型一段无来源摘要。

五秒是内置异步 / 协作式实现的硬截止，不是对任意同步第三方代码的强制抢占。阻塞 Node.js 事件循环的第三方 retriever 或 reranker 必须迁到 worker / 子进程后才能纳入相同保证。

## 第四层：受控写入面

线上 HTTP 故意没有写路由。写入只经 runtime / MCP 的专用流程进入，而且只对本地配置中显式 `writable: true` 的普通目录开放。

### 写入状态机

```text
prepare
  → inspect current version
  → proposal + structured diff + risk
  → prepared review (TTL + capacity bound + bindingHash)
  → private MCP App review
  → exact approve / cancel
  → internal one-time signed token
  → consume replay marker durably
  → Writer CAS + atomic rename
  → audit event(s) + recovery-aware receipt
  → compile + CURRENT + runtime reload
```

生产 MCP 写工具默认不注册；只有宿主显式设置 `OBSIDIAN_SECOND_BRAIN_WRITE_APPROVAL=trusted-mcp-app` 后才启用。模型只拿到 `prepared_id` / `review_id` 和有限状态；私有审核内容与 UI token 通过 app-only 工具传递。审批 authority 不暴露为 MCP 工具，Writer 只接收最小 `ApprovalVerifier` 接口，不能自己签发批准。审核文档被编辑即视为拒绝，过期、重复提交、不同 binding Hash 或风险等级超权均失败关闭。

这里的 `trusted-mcp-app` 是部署信任声明，不是密码学上的“用户在场证明”：宿主必须保证 app-only 工具、资源 `_meta` 和私有结果不会交给模型或普通 MCP 客户端。无法提供该隔离保证的客户端必须保持默认只读，或在 Runtime API 层注入独立、受信的 `HumanApprovalBroker`。

Writer 使用来源相对 Markdown path、静态 symlink 拒绝、版本 CAS、同目录临时文件和原子 rename。写前先保存带签名的本地 rollback capsule；审计使用 append-only Hash chain。提交已经发生但审计或重新摄取失败时，回执明确为 `committed_but_degraded` 并保留恢复 / 撤销信息，不会把它伪装成未写入。

撤销由原写入回执生成新的 rollback plan，校验当前仍是待撤销版本，并再次经过完整人工审核。撤销成功后清除旧正文恢复材料，再重新摄取；删除和恢复用显式 `present` / `absent` 观察状态，不以 `null` 猜测成功。

`InjectableObsidianWriterAdapter` 定义了 Obsidian 宿主 bridge 的 CAS / rollback 契约，但默认 runtime 还没有把它设为生产可写来源；Obsidian UI 接入仍需宿主实现与人工验收。读取方面，`obsidian-vault` 和普通目录都可编译。

## 第五层：可复用接口

| 接口 | 能力 | 安全边界 |
| --- | --- | --- |
| Offline CLI | 单次构建、强制 compact、周期 watch | 访问原始来源；只输出逻辑 ID、计数和 generation 信息 |
| Runtime API | operator runtime + `bindRead(principal)` 安全读取门面，以及受控写入 / 撤销 | 原始 runtime 仅供受信宿主；模型客户端使用已闭包绑定 Principal 的读取门面，调用参数只可收窄 |
| MCP STDIO | 默认提供 `get_second_brain_status`、`query_second_brain`；可信宿主可显式启用私有审核的写入 / 撤销 | 查询传输遵守 review policy；写工具默认不注册，启用后仍要求逐次审核 |
| Local HTTP | `GET /v2/status`、`POST /v2/query` | loopback + Bearer + origin / body / rate limit；完全只读 |
| Embedding Adapter | deterministic 或固定回环 semantic | 离线与在线的 adapter / model / kind / dimension 必须完全匹配 |
| Reranker Adapter | identity 或固定回环 reranker | 有界请求 / 响应、截止信号、输出结构验证 |
| Writer Adapter | 安全目录；可注入 Obsidian bridge 契约 | capability、版本、审批、审计与撤销均与模型供应商无关 |

Evidence Pack 和 `second-brain-write/v1` 不携带特定模型供应商的权限语义。因此多个模型可以共用一套编译产物和审计链；模型名称只作为 proposer / initiator 记录，不决定它能访问或写入什么。

## 启动与运维顺序

构建 TypeScript 后，生产启动遵循“先编译、后查询”：

```bash
# 默认单次；也可加 --watch 或通过 OBSIDIAN_COMPILE_WATCH_MS 设置周期
node dist/src/offlineCompile.js --once

# MCP STDIO
node dist/src/secondBrainMcp.js

# 或只读 HTTP
node dist/src/secondBrainHttp.js
```

离线编译读取 `OBSIDIAN_VAULT_PATH` 或严格的 `OBSIDIAN_SOURCES_JSON`，并要求持久 artifact 根或显式 `OBSIDIAN_SECOND_BRAIN_CATALOG_PATH`。在线进程只需要 catalog、artifact、embedding / reranker 契约和 Principal 配置；对于只读来源，不需要原始根仍在线。

一项安全的发布操作是：先让离线编译完成并发布 catalog，再调用 runtime `reload` 或重启在线进程。不要让在线服务猜测半完成目录，也不要直接编辑 `CURRENT`、`READY`、catalog 或 generation JSON。

## 明确不在保证内的事项

- 不承诺 Hash 提供加密；应配合最小文件权限、磁盘加密和私密备份。
- 不承诺抵御能以同一 OS 用户权限恶意替换来源或 artifact 祖先目录的进程间竞态。实现会做 symlink、realpath、device / inode 和前后状态复验，但 Node.js 缺少覆盖所有步骤的便携 `openat` 模型。
- Windows 不承诺掉电后最新 generation / catalog 一定持久；目录 `fsync` 不受支持时仍保留原子可见性和重启校验。
- 不承诺任意第三方同步插件都能在 5 秒内停止；只有遵守取消信号和截止时间的适配器在此 SLO 内。
- 不把合成测试等同于真实知识库相关性。真实私有语料、不同语言、长尾查询和 Obsidian 桌面 UI 仍需仓库外验收。
