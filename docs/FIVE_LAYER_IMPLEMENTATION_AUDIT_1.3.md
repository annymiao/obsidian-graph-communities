# Obsidian 第二大脑 1.3：五层实现核对表

本文件把产品目标逐项映射到默认生产入口，而不是只核对是否存在同名类型或文件。核对范围包括离线 CLI、持久化 generation、`SecondBrainRuntime`、MCP、只读 HTTP 和受控写入闭环。测试只使用合成 Markdown；个人 Vault、笔记正文和本机绝对路径不属于仓库内容。

状态说明：

- **已接线**：默认路径实际消费该能力，并有失败关闭或回归测试。
- **基线可用**：接口和安全边界已接线，但默认算法是零依赖基线，真实语料上线前仍需评测或替换 Adapter。
- **宿主验收**：核心协议已存在，但必须在仓库外的 Obsidian / 模型客户端中完成集成和人工验收。

## 核对后的结构

```text
Obsidian 第二大脑 1.3
├── 1. 离线编译面
│   ├── 安全扫描、稳定快照、内容 / 策略 Hash                         已接线
│   ├── 严格解析、标题分块、授权域内精确去重                         已接线
│   ├── chunk 级 Lexical、预计算 Vector、Temporal、Hierarchy         已接线
│   ├── 逐文件 checkpoint、journal、断点恢复、tombstone              已接线
│   └── 最终复扫 → 每来源 READY / CURRENT → 精确 pin 跨层校验 → catalog  已接线
│
├── 2. 本地持久化层
│   ├── Catalog                                                       已接线
│   ├── Lexical：文档级 base / delta / compact + chunkIndex              已接线
│   ├── Vector：版本绑定的预计算向量                                  基线可用
│   ├── Derived + Temporal + Hierarchy                                已接线
│   ├── checksummed immutable READY generations                       已接线
│   └── 每来源 CURRENT 物理指针 + catalog 在线一致快照           已接线
│
├── 3. 在线查询面
│   ├── server-owned Source / Project / Mode / Path 权限过滤          已接线
│   ├── BM25 / Dense / Metadata / Temporal / Hierarchy 并发编排       已接线
│   ├── weighted RRF + 可选 loopback Reranker                          已接线
│   ├── 可见性与时间硬过滤、去重、多样性、抽取式压缩                   已接线
│   └── 5,000 ms 协作式预算 + Evidence Pack / 安全拒答             基线可用
│
├── 4. 受控写入面
│   ├── 外部模型 / 宿主提交校对或新增候选，服务端形成版本绑定 proposal  已接线
│   ├── 来源、完整内容、结构化 Diff、风险和 binding Hash               已接线
│   ├── 私有只读审核页中的逐次人工确认                                 已接线
│   ├── Safe Directory Writer；Obsidian Writer bridge                  基线可用
│   ├── CAS、原子替换、Hash-chain 审计、恢复材料和再次确认的撤销        已接线
│   └── 写后重编译 / 精确校验 / catalog pin CAS / 本进程热加载   已接线
│
└── 5. 可复用接口
    ├── Obsidian Vault / 普通 Markdown 目录的统一文件系统摄取           已接线
    ├── MCP + 认证只读 Local HTTP + Runtime API                         已接线
    ├── Embedding / Reranker Adapter                                   已接线
    ├── provider-neutral Evidence Pack / write capability manifest     已接线
    └── Obsidian 桌面写入 bridge 与多个真实模型客户端                  宿主验收
```

## 与目标逐项对比

| 目标 | 默认实现与证据 | 结论 |
| --- | --- | --- |
| 安全扫描与版本 Hash | 来源扫描拒绝 symlink、限制文件数 / 大小、稳定读取并生成内容、策略和稳定身份 Hash | 已接线；这不是恶意软件扫描，也不承诺抵御同一 OS 用户的主动竞态攻击 |
| 解析、分块和去重 | 严格 frontmatter、Markdown 标题树、保守 token 上界、授权域内规范化全文去重 | 已接线；相似内容使用在线近重复抑制，不会在离线阶段擅自合并事实 |
| BM25、向量、时间和层级索引 | generation 保存 chunk 级词法 postings、版本绑定向量、时间和标题层级；在线直接消费 | 已接线；默认 Vector 是 lexical-hash exact-scan 基线，不等于已证明的语义 ANN |
| 检查点与断点恢复 | 每文件 checkpoint、带 Hash chain 的 journal、build lock、严格 plan / policy / content 匹配 | 已接线 |
| 校验后原子发布 | 每个来源末次复扫后先物理发布 `READY` / `CURRENT`；再对本轮精确 generation pins 做深跨层校验，最后原子发布完整 catalog | 已接线；单来源 `CURRENT` 只是物理指针，runtime catalog 才是在线一致快照 |
| Catalog / Lexical / Vector / Derived | 所有层均在本地不可变 generation 中保存并在加载时交叉验证 | 已接线；这些都是含敏感信息的本地缓存，不得进入 Git 或共享目录 |
| READY / CURRENT | `READY` 最后写入，generation rename 后再原子切换每来源 `CURRENT`；旧在线 catalog 不观察半套新来源 | 已接线；跨层校验失败时某个物理 `CURRENT` 可能已前进，但 catalog 不切换 |
| Scope 与 Project 权限 | Principal 由服务器创建；请求只能收窄 source、project、mode、path | 已接线，召回前与融合后都会复验 |
| 并行召回 | 五个 retriever 在同一截止时间下并发编排后汇入 RRF | 已接线；内置同步循环不是多核 CPU 并行，大规模第三方检索器应放入 worker / 独立进程 |
| RRF 与 Reranker | weighted RRF 默认启用；identity 或固定回环 reranker | 已接线；默认不启用学习型 reranker |
| 去重与抽取式压缩 | 近重复抑制、MMR 风格多样性和句子边界抽取 | 已接线，不生成无法追溯的新事实 |
| 五秒预算与拒答 | runtime 和 HTTP 请求入口把请求预算上限设为 5,000 ms；系统观察到过期后不发布成功 Evidence Pack | 协作式边界已接线；当前可见性扫描、BM25 统计和 Dense exact scan 含 O(N) / O(ND) 阶段，wall-clock 五秒 SLO 待真实库验收 |
| 自动校对或添加建议 | 当前 MCP 模型或宿主提交完整 `after_content`；服务端读取当前版本并生成确定 proposal / Diff / risk | 受控接收与审核闭环已接线；仓库不内置建议生成器或 `SuggestionAdapter`，自动发现/生成建议属于模型客户端与宿主验收，不能宣称核心服务已自行校对 |
| 人工确认、隔离 Writer、审计与撤销 | 写工具默认不注册；可信 MCP App 显式启用后仍需私有只读审核、一次性批准、CAS、审计和再次确认的撤销 | 已接线 |
| 写后重新摄取 | 本进程 commit / rollback 后重新编译精确来源、校验 generation、CAS 更新 catalog pin 并 reload | 已接线；受控写本进程可热加载；外部 offline CLI 发布 catalog 后已运行服务需重启 |
| Obsidian / 目录 Adapter | Obsidian Vault 和目录均由同一文件系统 compiler 读取；目录有默认安全 Writer；Obsidian 写入提供可注入 bridge | 两类来源摄取已接线，但尚无独立可替换的 Vault Reader Adapter；真正的 Obsidian 桌面写入仍是宿主验收项 |
| MCP / Local API / 多模型 | MCP、只读 HTTP、Runtime API 和 capability manifest 不把模型供应商作为授权依据 | 已接线；真实客户端兼容矩阵需在仓库外验收 |

## 本轮审计纠正的关键问题

1. **Lexical 不再只是存档。** 文档级 base / delta / compaction 保留为增量账本；chunk 级 record / version / length / postings 被保存、加载并直接供 BM25 使用；缺失、额外或旧版本映射失败关闭。
2. **时间范围成为全局硬边界。** `after` / `before` 在所有召回器之前过滤候选，不能再由 BM25 或 Dense 把范围外记录带回；`preferRecent` 仍只是排序偏好。
3. **写入能力按来源候选声明。** 只有部署显式信任私有 MCP App，catalog 中有可写目录且 Principal 的 source / project ACL 允许该来源时才公开写工具。Capability 只表示 source-level eligibility，每个目标 path 仍在 prepare 时按 included / excluded prefixes 重新鉴权。
4. **写入审核不可编辑。** 查询传输审核仍允许删改将发送内容；写入和撤销审核显示为只读，改变建议必须取消并重新生成。
5. **同来源写后发布完整串行。** 多个已批准文件修改仍可依次提交，但捕获旧 pin、重摄取、校验、CAS 与热加载作为一个 per-source 队列执行；跨进程冲突显式降级并等待 watch 对账。
6. **默认能力与质量上限分开表达。** deterministic Dense、identity reranker、Obsidian bridge 等基线或宿主能力不再被描述成已经完成真实语料生产验收。

## 升级、容量与运维边界

- `lexical.chunkIndex` 现在是必需编译产物。缺少它的旧 generation 会失败关闭，不会在在线查询时重新分词。Runtime catalog schema v3 不接受 v2 原位覆盖：升级时先停止该 catalog 的全部 publisher 与在线进程，把旧私有 catalog 移到隔离备份（或使用新 catalog 路径），再在来源介质在线时运行一次 `node dist/src/offlineCompile.js --once` 并重启在线服务。兼容 generation 可复用；这只处理仓库外的本地派生产物，不修改 Markdown 原文。
- Watch 每轮仍会读取并 Hash 全部 eligible Markdown 以证明快照未变。当扫描结果、policy、compiler、Vector 契约均一致且不需强制 compaction 时，它跳过解析、embedding 和新 generation，复用同一 `generationId`；逻辑上相同的 runtime catalog 也不重写。
- 复用旧 generation 前会运行在线 loader 同一套深跨层校验；Hash 自洽但层间语义损坏时放弃旧派生数据并干净重建。Watch 自动重试正常源编辑、纯 pin CAS 竞争和短暂锁占用；首次成功发布会把 catalog 路径永久绑定到该来源 / embedding / Writer 配置，因此不同配置即使在下一轮读到最新 checksum 也持续失败关闭。受控换配置必须先停掉该 catalog 的全部 publisher，再使用新的 catalog 路径，或离线移走可重建的旧 catalog 后重新编译。
- 外部 offline CLI 原子发布新 catalog 后，已运行的 MCP / HTTP 进程需重启或重建 bootstrap 才会重读 catalog；`runtime.reload()` 只重读已绑定 descriptor，不会自行重读外部 catalog。受控写的本进程路径则会先校验精确 generation、CAS 更新 catalog pin，再更新 descriptor 并热 reload。
- MCP `after_content` 上限为 262,144 UTF-8 bytes，完整私有审核文档上限为 1,000,000 bytes。后者包含 Diff、理由和绑定元数据，所以大型既有文件的 replace / delete 可能在打开审核时被拒绝；该失败不会写入文件。
- Build、generation 与 catalog 锁使用固定 `*.lock.recovery` transition gate 防止并发恢复 ABA。受保护操作结束后先持久写入 token-bound `released.json`，实际摘除仍经 gate；后继可回收 marker 完整的旧锁，即使原 PID 仍存活。仅获取阶段的 busy 可安全重试；操作已经完成后的释放异常是明确的 `retryable=false`，publish / rollback 不得自动重放。升级时必须先停掉共用状态根的全部旧进程，不得混跑锁协议版本。人工清理未知 gate 前须停机、确认无持锁者并把 gate 移到隔离位置，系统绝不自动删除它。
- Linux 可能快速复用锁目录 inode，因此锁交接以随机 owner token 识别实例，device / inode 只作路径替换辅检；文件型 Writer / audit 锁则在 `O_EXCL` 后的 owner 发布窗口内有界重试，超时仍失败关闭。FAT/exFAT 等无法可靠执行私有权限、原子持久化语义或会生成目录 sidecar 的文件系统不支持承载任何运行时状态；macOS 应使用本机私有 APFS 应用数据目录。项目源码可位于外置盘，但 Catalog、generation、checkpoint、approval、audit 和 rollback 状态不得随源码落在该盘。
- 通用 generation prune 不知道 runtime catalog 的跨来源 pins；生产第二大脑不调用它，在 catalog-aware GC 完成前也不得对这些 generation 根手工运行。
- 显式 runtime catalog 和 write-state 路径会先解析最近存在祖先的真实路径，再进行 Git-worktree 与 source-overlap 检查，避免符号链接把敏感派生状态绕入仓库或原始资料目录；在线 bootstrap 会重新校验 catalog 内的 generation / compiler / writer / write-state 路径与 Git、catalog 可见的可写 source roots 的边界。只读 sourceRoot 为避免泄露而不写入 catalog，其 overlap 边界只在受信离线配置阶段验证，在线进程不能从手工 catalog 中恢复该私有定位。

## 不需要用户日常处理的事项

Hash、分块、索引、候选召回、融合、压缩、重编译和一致性发布都由系统完成。用户日常只需要提问；当系统建议修改事实源时，才在私有面板中核对路径、风险和 Diff，并确认或取消。

首次来源设置、来源 / Project 权限、是否允许写入，以及任何最终写入决定属于受信配置或人工选择，不能由笔记正文或检索模型自行扩大。

## 仍需用真实环境验收的质量项

1. 用仓库外的私有标注集测量 recall、拒答准确性、跨项目隔离、中文 / 长尾查询和目标硬件上的 p95；决定是否启用语义 embedding、学习型 reranker 或 ANN Adapter。
2. 在真实 Obsidian 桌面宿主实现并验证 `ObsidianWriteBridge`，覆盖确认、取消、版本冲突、离线磁盘、回滚和写后刷新。
3. 用至少两个实际模型客户端做相同 Evidence Pack 与 capability handshake 的兼容验收。模型身份只进入审计，不进入授权决策。
