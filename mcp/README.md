# Obsidian Second Brain MCP

1.3.0 是面向 Obsidian Vault 和普通 Markdown 目录的本地优先编译式知识层。它把耗时的资料处理和有响应要求的检索分开，让证据独立于任一模型的对话记忆。MCP 写工具默认不注册；可信宿主显式启用后，每一次原文写入或撤销仍必须经过私有人工确认。

原始 Markdown 始终是权威来源，不进入本仓库。生成的 Catalog、Lexical、Vector、Derived、Temporal 和 Hierarchy 产物是敏感本地缓存：必须放在来源目录、Git、共享文件夹和未加密备份之外。

## 1.3 的变化

新的 second-brain 路径实现五层闭环：

```text
离线编译
  → 本地不可变 generations
  → 权限过滤的混合查询
  → 可选但始终人工确认的受控写入
  → MCP / 只读 HTTP / Adapter 可复用接口
```

- 离线编译执行有界安全扫描、严格策略解析、标题分块、授权域内去重、逐文件 checkpoint、tombstone 和最终来源稳定性复扫。
- 每个 generation 包含带校验和的 Catalog、compact Lexical、Vector、Derived、Temporal 和 Hierarchy 层，并经 `staging → READY → CURRENT` 发布。
- 在线检索只读取编译产物。BM25、Dense、Metadata、Temporal 和 Hierarchy 并行运行，再经 RRF、可选本地 Reranker、去重、多样性选择和抽取式压缩生成 Evidence Pack。
- runtime 强制最多五秒查询截止；返回可追溯证据，或明确的 `no_evidence`、`timeout`、`source_failure` 安全拒答。
- 写入使用来源 / 版本绑定 proposal、结构化 Diff、风险判断、私有精确审核、一次性批准、CAS、原子替换、Hash-chain 审计、撤销和重新摄取。
- Obsidian Vault 与目录来源、模型无关 runtime、local embedding / reranker、MCP 和认证只读 HTTP 可供不同模型客户端复用。

详细设计见[五层实现架构](docs/FIVE_LAYER_ARCHITECTURE.md)。之前的请求内 1.2 只读服务仍为兼容保留；它是另一条执行路径，见[其架构文档](docs/ARCHITECTURE.md)。

## 用户日常流程

1. 配置一个或多个本地来源和 artifact 位置。
2. 运行一次离线编译。首次语义构建可能较慢，不受查询 SLO 约束。
3. 启动 MCP 或只读 HTTP 并直接提问。来源未变化时，runtime 使用 runtime catalog 固定的已验证 generation，并在五秒硬截止内完成。
4. 仅当宿主能保证私有工具隔离且用户主动启用写入时，客户端提出更正、新增或删除后才显示私有审核面板；核对来源、相对路径、风险和完整 Diff，明确确认或取消。撤销需要再确认一次。

只读来源在完成编译后可以暂时离线；只要本地 catalog 和 generation 仍可用，在线查询仍能工作。准备写入和写后重新摄取则要求来源在线。

## 构建与测试

需要 Node.js 20 或更高版本和 pnpm。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
```

测试只使用合成临时 Markdown。不要为了测试把真实 Vault 放入仓库。

## 来源配置

兼容保留单来源变量：

```bash
export OBSIDIAN_VAULT_PATH='<absolute-source-directory>'
export OBSIDIAN_ARTIFACT_PATH='<absolute-private-artifact-directory>'
```

多个根目录使用包含 1–16 个来源的严格 JSON 数组：

```bash
export OBSIDIAN_SOURCES_JSON='[
  {"id":"primary-notes","name":"Primary notes","path":"<absolute-primary-directory>","kind":"obsidian-vault","writable":false},
  {"id":"research","name":"Research","path":"<absolute-research-directory>","kind":"directory","project_id":"research","writable":true}
]'
export OBSIDIAN_ARTIFACT_PATH='<absolute-private-artifact-directory>'
```

对象只接受 `id`、`name`、`path`、`kind`、`project_id` 和 `writable`。逻辑 ID 必须稳定且唯一。根必须是绝对、真实、非 symlink 目录；来源之间以及来源与 artifact 不得重叠。`writable` 默认为 `false`，生产 runtime 只允许 `kind: "directory"` 启用它。

项目归属来自可信来源配置，而不是笔记 frontmatter。Frontmatter 可以缩小检索范围，但不能授予更宽的 project、mode 或写入权限。

## 离线编译器

构建 TypeScript 后运行：

```bash
# 完整构建一次
node dist/src/offlineCompile.js --once

# 周期对账；默认间隔 30 秒
node dist/src/offlineCompile.js --watch

# 首轮强制重建并 compact lexical base
node dist/src/offlineCompile.js --force-compaction --once
```

`OBSIDIAN_COMPILE_WATCH_MS` 可设置 1,000–3,600,000 ms 的间隔。Watch 是周期对账，不承诺 OS 文件系统事件级实时性。

编译器只输出逻辑 ID、计数和 generation 信息组成的脱敏 JSON，不打印笔记正文或绝对路径。所有已配置来源都拥有有效 current generation 后，它才原子发布 runtime catalog，并在其中固定每个来源的 `generationId + manifestSha256`。此后某一个来源单独推进 `CURRENT` 不会改变旧 catalog 的一致快照。

可以用 `OBSIDIAN_SECOND_BRAIN_CATALOG_PATH` 指定绝对 catalog 文件，或者让它位于配置的 artifact 根下。Catalog 是本机私有、带校验和且 POSIX 请求权限为 `0600` 的文件；它可能包含 runtime 需要的本地定位，绝不能提交。

## Embedding 与 Reranker Adapter

编译器和在线 runtime 使用的 embedding identity、model、kind 与 dimension 必须与 Vector artifact 完全一致。

| 设置 | 默认 | 含义 |
| --- | --- | --- |
| `OBSIDIAN_EMBEDDING_PROVIDER` | `deterministic` | `deterministic` 或 `loopback` |
| `OBSIDIAN_EMBEDDING_DIMENSION` | `384` | 向量维度 |
| `OBSIDIAN_EMBEDDING_PORT` | — | 固定 `127.0.0.1` embedding 服务端口 |
| `OBSIDIAN_EMBEDDING_MODEL` | — | loopback 必填模型 ID |
| `OBSIDIAN_RERANKER_PROVIDER` | `none` | `none` 或 `loopback` |
| `OBSIDIAN_RERANKER_PORT` | — | 固定 `127.0.0.1:/v1/rerank` 的端口 |
| `OBSIDIAN_RERANKER_MODEL` | — | loopback 必填 reranker 模型 ID |

任意 URL 变量会被拒绝，这些 Adapter 不能通过配置重定向到远端主机。Deterministic Adapter 是可复现的 lexical-hash vector 基线，不代表语义质量。将语义 Adapter 或 Reranker 设为默认值前，应在仓库外的私有标注集上评测。

## 服务器权限

Runtime 从本机环境创建 Principal，而不是相信查询输入：

| 设置 | 含义 |
| --- | --- |
| `OBSIDIAN_PRINCIPAL_ID` | 用于审计的逻辑调用方身份 |
| `OBSIDIAN_PRINCIPAL_ALLOWED_SOURCE_IDS` | 允许的已编译 source ID 子集，逗号分隔 |
| `OBSIDIAN_PRINCIPAL_ALLOWED_PROJECT_IDS` | 允许的 project ID，逗号分隔 |
| `OBSIDIAN_PRINCIPAL_ALLOWED_MODES` | `default,project,reference,history` 的子集 |
| `OBSIDIAN_PRINCIPAL_INCLUDED_PATH_PREFIXES` | 可选的允许相对路径前缀 |
| `OBSIDIAN_PRINCIPAL_EXCLUDED_PATH_PREFIXES` | 可选的拒绝相对路径前缀 |

未指定子集时使用已配置来源 / 项目和全部四种 mode。请求字段只能进一步收窄。Project-scoped 记录没有显式 project 允许时失败关闭。

自行集成 Runtime API 时，应由宿主创建 Principal 后调用 `runtime.bindRead(principal)`，只把返回的 `query(request)` / `status()` 门面交给模型客户端。接受 Principal 参数的原始方法和 `reload()` 属于受信宿主内部接口，不能直接映射为模型工具。

## MCP STDIO

启动编译式 second-brain MCP：

```bash
node dist/src/secondBrainMcp.js
```

默认模型可见工具包括：

- `get_second_brain_status`：权限过滤后的计数和 generation 状态，不含来源正文或主机路径；
- `query_second_brain`：有界混合检索，返回 Evidence Pack 或安全拒答；
- `receive_reviewed_second_brain_query`：仅在查询传输必须审核时注册。

写入工具默认完全不注册。只有受信 MCP App 宿主显式设置
`OBSIDIAN_SECOND_BRAIN_WRITE_APPROVAL=trusted-mcp-app` 后，才额外注册
`prepare_second_brain_write`、`commit_reviewed_second_brain_write`、
`prepare_second_brain_rollback` 和 `commit_reviewed_second_brain_rollback`。

审核草稿和决定工具只对 MCP App 私有组件可见。模型不能签发批准凭据。Prepare 不修改文件；只有精确、未编辑、未过期、一次性的 UI 批准后，commit 才能成功。编辑审核草稿等同拒绝，必须重新生成 proposal。

`trusted-mcp-app` 是部署方对宿主隔离能力的声明，不是密码学用户在场证明。宿主必须保证 app-only 工具、资源 `_meta` 和私有结果不会暴露给模型或普通 MCP 客户端；做不到这一点时必须保持默认只读，或直接在 Runtime API 注入独立可信的 `HumanApprovalBroker`。

### 查询传输策略

`OBSIDIAN_TRANSMISSION_REVIEW` 在启动时固定：

| 值 | STDIO 查询 | 含义 |
| --- | --- | --- |
| `required` | 私有可编辑审核后一次性发送 | 失败安全默认值 |
| `trusted-local` | 直接返回有界 Evidence Pack | 可信本机 STDIO 调用方 |
| `disabled` | 直接返回有界 Evidence Pack | 显式移除查询传输审核 |

这个设置只影响读取结果的传输，既不会启用写工具，也不会关闭已启用写入或撤销的人工确认。

## 只读 HTTP

启动本地网关：

```bash
export OBSIDIAN_SECOND_BRAIN_HTTP_API_KEY='<secret-of-at-least-32-utf8-bytes>'
node dist/src/secondBrainHttp.js
```

端点只有：

- `GET /v2/status`
- `POST /v2/query`

服务器只绑定 `127.0.0.1` 或 `::1`，要求 constant-time Bearer 认证，拒绝 query string 和不支持的 body 字段，并执行 body、origin 与每分钟速率限制。它没有 create、replace、delete、approve 或 rollback 路由。

| 设置 | 默认 | 含义 |
| --- | ---: | --- |
| `OBSIDIAN_SECOND_BRAIN_HTTP_HOST` | `127.0.0.1` | 精确 loopback 绑定主机 |
| `OBSIDIAN_SECOND_BRAIN_HTTP_PORT` | `27124` | 监听端口 |
| `OBSIDIAN_SECOND_BRAIN_HTTP_ALLOWED_ORIGINS` | 无 | 精确允许的浏览器 origins |
| `OBSIDIAN_SECOND_BRAIN_HTTP_MAX_BODY_BYTES` | `1048576` | 请求 body 上限 |
| `OBSIDIAN_SECOND_BRAIN_HTTP_RATE_LIMIT` | `120` | 每个 loopback peer 每分钟请求数 |

Loopback 不能证明流量没有经过隧道。API key 必须保密，任何隧道都应另外设置认证和传输保护。

## 受控写入与撤销

可写来源还需要位于所有来源根和 Git 工作树之外的私有状态。可用 `OBSIDIAN_SECOND_BRAIN_WRITE_STATE_PATH` 显式设置。直接启动 runtime 时可用 `OBSIDIAN_SECOND_BRAIN_APPROVAL_SECRET` 提供至少 32 UTF-8 bytes 的进程私有审批签名 secret；未设置时生成进程内随机 secret。MCP 写入默认关闭；只有受信宿主设置 `OBSIDIAN_SECOND_BRAIN_WRITE_APPROVAL=trusted-mcp-app` 才启用。`OBSIDIAN_ALLOW_CRITICAL_WRITES` 默认为 `false`。

每次写入依次经过：

```text
proposal → source/version-bound diff → risk → private exact review
→ one-time approval → CAS/atomic writer → audit receipt
→ offline reingest → new CURRENT → runtime reload
```

撤销重新经过同一人工边界。文件已提交、但审计或重新摄取失败时，回执为 `committed_but_degraded` 并保留恢复信息；客户端不得把它当作“没有修改”而重试。

Directory Writer 拒绝不安全相对路径和 symlink，使用 base-version 前置条件，并把 rollback 材料保存在来源之外，避免被索引为知识。Injectable Obsidian Writer 定义相同的插件宿主 bridge 契约，但 1.3 默认 runtime 只为普通目录启用生产写入。Obsidian 桌面 UI 行为仍需宿主集成验收。

## 五秒查询契约

没有新文件导入时，查询只使用已加载的 immutable view，deadline 不会超过五秒。内置 retriever 周期检查取消信号；runtime 失败关闭，不返回超过截止后才完成的证据。

这是协作式 deadline。第三方 Adapter 如果在 Node.js event loop 上执行长时间同步工作，无法在同一进程内被强制抢占，不属于该保证。应把不可信或不协作的扩展放进有外部超时的独立 worker / process。

这里不宣称任何 latency percentile 或检索准确率数字。合成测试验证协议和失败行为；相关性与实际硬件性能必须用真实私有语料验收。

## 安全边界

- 来源内容是 untrusted reference data，不能修改授权。
- 在线查询只读 runtime catalog 以 generation ID 和 manifest Hash 固定的 artifact；启动时不扫描来源或重新嵌入完整语料。
- Runtime catalog、generations、writer state、rollback 材料和 audit log 是敏感数据，不能成为 release artifact。
- POSIX 私有目录 / 文件要求 owner-only 权限。Windows 依赖容器目录 ACL，且目录 `fsync` 是 best effort：提供原子可见性和重启校验，但不承诺掉电持久性。
- 实现会拒绝 symlink，并在关键操作周围复验 realpath、device / inode 和文件版本。Node.js 没有覆盖每一步的可移植目录句柄相对 `openat` API，因此无法承诺抵御同用户恶意进程在系统调用之间替换祖先目录。
- Checksums 用于检测损坏，不是加密，也不能防御同用户 hostile process。

完整边界见 [SECURITY.md](SECURITY.md)。

## 仍需在仓库外完成的验收

五层工程路径已实现，并使用合成来源测试。在把它视为个人知识库的生产验收版本前，还需完成：

1. 用私有语料验证 recall、安全拒答、scope / project 隔离、时间 / 层级行为，以及目标硬件上的五秒要求。
2. 用真实 Obsidian 桌面宿主验收来源设置、私有审核、确认 / 取消、重新摄取、撤销和错误恢复。

个人笔记和评测答案都不应进入本仓库。
