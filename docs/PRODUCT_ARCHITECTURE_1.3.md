# Obsidian 第二大脑 1.3：五层闭环产品架构

## 结论

1.3 把“第二大脑”从一次查询时临时扫描目录，推进为可复用的五层本地系统：资料先在离线编译面被安全扫描、分块、去重和索引，再以不可变 generation 保存在本地；在线查询只读取 runtime catalog 精确固定且已经跨层验证的 generation，并在服务器权限范围内并发编排召回、融合、压缩成可追溯的 Evidence Pack；对原文的任何写入或撤销都必须经过独立的本地人工确认。

这套结构首先解决“大目录不应整包发送给模型”，其次允许不同位置的长期资料保持原位、统一检索，最后把本地编译产物作为不同模型之间共享的记忆层。它没有模拟人类的遗忘限制：原始资料仍由用户完整保留，“忘记”只表现为权限、状态、时间与排序上的选择性注意，而不是自动删除。

## 五层目标与 1.3 实现

```text
Obsidian 第二大脑 1.3
├── 1. 离线编译面
│   ├── 安全扫描、稳定文件快照与内容 / 策略 Hash
│   ├── 严格 frontmatter、Markdown 标题解析、分块与授权域内去重
│   ├── 文档级 Lexical 账本、chunkIndex、Vector、Temporal、Hierarchy 与 Derived
│   ├── 逐文件 checkpoint、journal、断点续编与 tombstone
│   └── 最终源快照复验 → staging → READY → 每来源 CURRENT
│
├── 2. 本地持久化层
│   ├── Catalog：来源、文档、版本、ordinal、范围与 tombstone
│   ├── Lexical：文档级 base / delta / compaction + 在线 BM25 必需 chunkIndex
│   ├── Vector：adapter / model / recipe / dimension 绑定的预计算向量
│   ├── Derived / Temporal / Hierarchy：正文证据、时间与层级结构
│   ├── READY Generations：校验和保护的不可变完整版本
│   ├── CURRENT：每来源 generation store 的原子物理指针
│   └── Runtime Catalog：精确 pins 深跨层校验后原子发布的在线快照
│
├── 3. 在线查询面
│   ├── 服务器创建的 Source / Project / Mode / Path 权限边界
│   ├── BM25 / Dense / Metadata / Temporal / Hierarchy 并发编排召回
│   ├── RRF 融合 → 可选本地 Reranker
│   ├── 可见性复验 → 近重复抑制 → 多样性选择 → 抽取式压缩
│   └── 5,000 ms 协作式预算；Evidence Pack 或超时 / 无证据 / 来源失败
│
├── 4. 受控写入面
│   ├── create / replace / delete 建议与来源版本绑定
│   ├── 结构化 Diff、风险等级与确定性审核文本
│   ├── 私有只读 UI 中的一次性精确人工确认
│   ├── 隔离 Writer + CAS 前置条件 + 同目录原子替换
│   ├── Hash-chain 审计、回执、恢复材料与再次人工确认的撤销
│   └── commit / rollback → 重摄取 / 校验 → catalog pin CAS → 本进程热加载
│
└── 5. 可复用接口
    ├── 普通 Markdown 目录与 Obsidian Vault 来源
    ├── Safe Directory Writer 与可注入 Obsidian Writer 契约
    ├── MCP：查询、私有审核、受控写入与撤销
    ├── 只读本地 HTTP：/v2/status 与 /v2/query
    ├── deterministic / 固定回环 Embedding，以及可选固定回环 Reranker
    └── provider-neutral Evidence Pack 与写入能力协议，供不同模型客户端复用
```

## 先后关系与平行关系

### 首次或资料变化后的严格先后链

```text
配置本地来源与服务器权限
→ 离线安全扫描
→ 解析 / 分块 / 去重
→ 为每个文件持久化 checkpoint
→ 构建五类索引和派生产物
→ 再次扫描并验证源没有在编译途中变化
→ 生成各层 Hash，写 READY 并原子切换每来源 CURRENT
→ 对本轮精确 generation + manifest Hash pins 做深跨层校验
→ 最后原子发布私有 runtime catalog
→ 重启或重建在线 bootstrap，读取完整新视图
```

一个来源构建或深跨层校验失败时，完整来源集合的 runtime catalog 不会提前发布；某个来源单独推进物理 `CURRENT` 也不会改变旧 catalog 固定的完整来源集合。一个 generation 只有在所有层可交叉验证且被 catalog 精确 pin 后才会成为在线视图。首次编译允许较慢，尤其是本地语义 embedding；它不占用查询预算。外部 offline CLI 发布 catalog 后，已运行进程必须重启或重建 bootstrap：`runtime.reload()` 本身不会重读 catalog。

无变化复用不是只比文件 Hash：旧 generation 还必须再次通过在线 loader 的跨层语义校验，否则从原始 Markdown 干净重建。Watch 会自动重试编译期间的正常编辑、纯 pin 发布竞争和进入受保护操作之前的短暂锁占用；首次成功发布会把 catalog 路径绑定到该来源 / embedding / Writer 配置，另一配置即使跨轮读到新 checksum 也不能覆盖。受控换配置要先停止该 catalog 的全部 publisher，再使用新 catalog 路径，或离线移走可重建的旧 catalog 后重新编译。操作结束后锁先写 token-bound release marker，随后才经 transition gate 摘除；释放异常明确不可自动重试，避免重复 publish 或 rollback。锁协议升级必须先停掉共用状态根的旧进程，不能混跑版本。

### 一次在线查询的平行与汇合

```text
Query + 服务器 Principal
→ Source / Project / Mode / Path 可见性过滤
→ ┬─ BM25
  ├─ Dense
  ├─ Metadata
  ├─ Temporal
  └─ Hierarchy
→ RRF 汇合
→ 可选 Reranker
→ 再次可见性过滤、去重、多样性与抽取式压缩
→ Evidence Pack / 安全拒答
```

五路召回是并发编排关系，共享同一可见记录集合和截止时间；内置同步 CPU 循环并非多核并行。RRF、Reranker、去重和压缩是后续先后关系。任何查询参数都只能收窄服务器创建的 Principal，不能为自己增加来源、项目、模式或路径权限。在线进程不扫描原始目录、不在启动时重新嵌入完整语料；它只加载 runtime catalog 指向的已验证产物。因此，对只读来源而言，即使原始硬盘暂时离线，只要本地产物仍在，查询仍可用。受控写入和写后重新摄取当然仍要求目标来源在线。

### 一次写入或撤销的严格先后链

```text
模型或可替换 Adapter 提出建议
→ 读取目标当前版本
→ 生成 proposal、Diff、风险与绑定 Hash
→ 私有本地只读 UI 展示完整审核文档
→ 用户明确确认原文未被编辑
→ 内部签发短期一次性审批凭据
→ Writer 复验来源、路径、版本与权限
→ CAS + 原子写入
→ Hash-chain 审计与回执
→ 重新摄取并校验精确 generation
→ CAS 更新 catalog pin，本进程更新 descriptor 并 reload
```

撤销不是隐藏的“反向按钮”，而是一项新的受控操作：它检查原写入回执和当前版本，再要求用户重新确认。写入和撤销审核页不可编辑；想改变建议必须取消并重新生成。即使非标准私有组件提交了不同文本，服务端也会拒绝。过期、取消、重复使用或绑定 Hash 不一致同样失败关闭。查询传输可以按部署策略选择可编辑审核或可信本机直返；MCP 写工具默认不注册，只有宿主显式声明 `trusted-mcp-app` 隔离、且当前 Principal 的 source / project ACL 至少允许一个可写来源后才出现。这只是 source-level eligibility，不代表任意路径已获批；每个目标 path 会在 prepare 时按 included / excluded prefixes 、来源、项目和当前版本重新鉴权。启用后的写入和撤销没有跳过逐次人工确认的模式。该声明是部署信任边界，并非密码学用户在场证明；普通客户端应保持只读。

同一来源的多个批准操作会把写后重摄取、精确 pin CAS 与热加载整段串行化；不同来源仍可并行。这样两个文件即使接近同时提交，也不会都拿同一个旧 catalog pin 去发布而让后一次修改长期不可检索。

## 用户操作模型

日常使用只保留三类动作：

1. 首次设置一个或多个来源，运行一次离线编译；之后可选择定时 watch。
2. 直接提问。系统自动选取有权访问的少量证据，在最多 5,000 ms 的协作式查询预算下返回或拒答；真实 wall-clock 五秒 SLO 需在目标知识库上验收。
3. 当系统提出修改时，在私有审核面板核对来源、相对路径、风险与 Diff，点击确认或取消；撤销时再确认一次。

系统不会要求用户为每条笔记手工打标签才能工作。标题、正文、路径、别名、标签、时间和标题层级由算法提取；项目身份、来源权限、可写开关和最终修改决定来自受信配置或人工确认。

| 决策 | 算法可自动完成 | 必须人工或受信配置决定 |
| --- | --- | --- |
| 扫描、Hash、分块、去重、checkpoint、索引、发布 | 是 | 来源根目录与排除策略 |
| 候选召回、RRF、重排、压缩、拒答 | 是 | Principal 的来源 / 项目 / 模式权限 |
| 发现重复、过时或可能冲突的内容 | 生成候选和解释 | 哪条是事实、是否合并或取代 |
| 生成校对或新增建议 | 当前 MCP 模型或宿主生成并提交候选 | 是否写入以及最终完整内容；核心服务只受控接收 `after_content`，不内置独立校对模型或 Suggestion Adapter |
| 覆盖、删除、批量修订 | 只准备计划 | 每一次提交均需确认 |
| 撤销已提交修改 | 只准备回滚计划 | 每一次撤销均需再次确认 |

## 对三个原始问题的提升

### 1. 大文件夹与 token 消耗

模型不再接收整个文件夹。目录规模主要影响离线编译；查询只返回去重、压缩、带来源和版本的少量证据片段。Watch 为了证明快照未变，每轮仍会读取并 Hash 全部 eligible Markdown；但当扫描、policy、compiler 和 Vector 契约均一致且不需强制 compaction 时，不会重新分块、embedding、创建 generation 或重写逻辑上相同的 runtime catalog。

### 2. 长期资料分散

最多 16 个本地来源可通过稳定逻辑 ID 组成同一个检索面，每个来源独立 generation、独立项目边界、统一 Evidence Pack。原文件无需迁移到中心数据库；Catalog 记录其可追溯身份和状态，本地 runtime catalog 连接各个产物根。

### 3. 模型记忆互通

记忆不放在某个模型的对话窗口内，而放在模型之外的本地 Markdown 与编译产物中。MCP、HTTP 或其他使用相同接口的模型客户端都消费同一种权限过滤 Evidence Pack；写入协议记录模型身份用于审计，但模型供应商不参与授权。因此切换模型不等于丢失已确认知识。

## 升级与容量边界

- 在线 BM25 现在要求持久化的 `lexical.chunkIndex`。旧 generation 缺少该层时会失败关闭，升级后需在来源介质在线时执行一次 `node dist/src/offlineCompile.js --once`。这只重建仓库外的本地派生产物，不修改原文。
- MCP `after_content` 最多 262,144 UTF-8 bytes；完整私有审核文档最多 1,000,000 bytes。完整审核还包含 Diff、理由和绑定元数据，因此实际可接受的操作可能更小；超限会在写入前拒绝。

## 性能契约

- 离线：首次构建和大规模变更允许耗时较长，按来源串行编译以控制本地 embedding 的内存压力；逐文件 checkpoint 支持安全重启续编。
- 在线：已加载 runtime catalog 视图未变时，查询不读原始文件；请求预算被限制为最多 5,000 ms，系统观察到过期后不会发布成功 Evidence Pack。
- 重新发布：写入完成后重新摄取可能超过 5 秒，它属于写入回执的后处理，不应伪装成在线查询延迟；失败会显式标记 degraded，而不会把已发生的提交误报为“没有写入”。
- 规模边界：当前可见性 / 时间过滤和 BM25 部分统计为 O(N)，Dense exact scan 为 O(ND)，且部分同步排序不能被事件循环强制抢占。因此 5,000 ms 是协作式预算和安全发布边界，不是对任意语料规模已证明的 wall-clock SLO。第三方适配器也必须检查 `AbortSignal` / `deadlineAt`；不可协作的代码应转移到 worker / 独立进程。

这里不提供未经真实语料验证的吞吐、p95 或准确率数字。性能与相关性必须在仓库外的用户私有标注集上验收，日志只保存匿名 case ID、计数和时延。

## 安全与隐私边界

- 原始 Markdown 是唯一事实源；Catalog、索引、向量、Diff、审计和 generation 都是本地敏感数据，不进入 Git，也不应放进 Vault、共享目录或未加密备份。
- 扫描不跟随符号链接，策略和 frontmatter 失败关闭；文档内容不能授予自身项目或写入权限。
- Catalog、各层 Hash、`READY` 和 `CURRENT` 会在使用前验证；跨层 ID、ordinal、向量 recipe、adapter、model 和 dimension 不一致时拒绝加载。
- 本地 HTTP 只绑定 loopback、要求 Bearer 密钥、限制 body、origin 和速率，而且没有写路由。loopback 仍可能位于隧道之后，不等于自动可信。
- POSIX 上私有状态要求当前用户所有且无 group / other 权限；Windows 依赖应用数据目录 ACL。Windows 的目录 `fsync` 是 best effort，因此只承诺原子可见性与重启校验，不承诺掉电后最新 generation 一定持久。
- FAT/exFAT 等不能可靠表达私有权限、原子持久化语义或会在受管目录生成额外 sidecar 的文件系统不支持承载 Catalog、generation、checkpoint、approval、audit 与 rollback 状态。macOS 部署应把这些状态放在本机私有 APFS 应用数据目录；外置盘可以保存项目源码，但不应作为运行时状态根。
- Node.js 没有为全部操作提供可移植的 `openat` / 目录句柄相对 API。实现会拒绝 symlink 并复验 realpath、device、inode 和版本，但不承诺抵御拥有同一用户权限、可在系统调用之间恶意替换祖先目录的进程。
- Hash 用于完整性和可追溯性，不是加密。运行状态、API 和错误会隐藏绝对主机路径，但本地产物本身仍包含敏感正文或私有定位信息，必须依赖文件权限和磁盘加密保护。

## 1.3 的完成定义与剩余验收

“完成五层”在 1.3 中表示：五层接口、状态转换、安全失败方式和基于合成语料的端到端闭环已经落到代码，而不是宣称所有现实语料和宿主 UI 已经生产验收。

仍需由用户环境完成两项验收：

1. 使用仓库外的真实私有语料测试召回、拒答、跨项目隔离、时间 / 层级查询和 5 秒目标，并决定 Dense / Reranker 是否优于词法基线。
2. 在真实 Obsidian 桌面宿主中验证来源选择、私有审核面板、确认 / 取消、写后刷新和撤销体验；可注入 Obsidian Writer 契约已经存在，但 1.3 的默认生产写路径仍只对显式 `writable: true` 的普通目录启用。

在这两项验收完成前，可以称为“五层工程闭环已实现”，不应称为“已证明适合所有私人知识库”或“Obsidian UI 已正式发布”。
