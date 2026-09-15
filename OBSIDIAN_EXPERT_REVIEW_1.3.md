# Obsidian 第二大脑 1.3 专家审核

## 审核结论

1.3 已经把五层目标落实为一个可执行、可恢复、可拒答、可审计的工程闭环。最重要的架构变化不是“多加一个向量数据库”，而是把慢且高风险的资料处理从在线请求中分离出来，并让查询、权限、写入和撤销都消费同一个有版本的事实边界。

建议将当前状态表述为：**五层工程闭环已实现，真实私有语料与 Obsidian 桌面 UI 尚待用户环境验收。** 不建议表述为“相关性已经超过现有系统”或“任意硬件都能达到某个 p95”，因为仓库内合成测试不能证明这些结论。

## 目标—实现审核

| 目标层 | 1.3 状态 | 主要证据 | 仍需验收 |
| --- | --- | --- | --- |
| 离线编译面 | 已实现 | 安全扫描、严格策略、分块、授权域去重、per-file checkpoint / journal、final rescan、六层 artifact、原子发布 | 真实大目录的恢复耗时、embedding 资源占用 |
| 本地持久化层 | 已实现 | Catalog、compact Lexical、Vector、Derived、Temporal、Hierarchy、checksummed READY / CURRENT、runtime catalog | 长期运行后的 delta / tombstone / orphan 运维体验 |
| 在线查询面 | 已实现 | server Principal、五路并行召回、RRF、可选 reranker、重复抑制、抽取压缩、5 秒 deadline、安全拒答 | 私有问题集上的 Recall、nDCG、拒答正确率和目标硬件时延 |
| 受控写入面 | 已实现于普通目录 | proposal、Diff、risk、私有 exact review、一次性凭据、CAS、原子写、审计、回执、再次审核的 rollback、reingest | 真实 Obsidian 宿主 bridge 与 UI；高风险失败演练 |
| 可复用接口 | 已实现 | directory / Vault 读取，directory / injectable Obsidian writer 契约，Runtime、MCP、只读 HTTP、Embedding / Reranker、模型无关协议 | 第二个真实模型客户端和 Obsidian 插件宿主的互操作验收 |

## 对原始三个问题的判断

### 1. 文件夹过大、token 消耗过多

解决方向正确。整个目录不再进入模型上下文，只有检索后的有界 Evidence Pack 才可能发送。首次编译可以慢，之后无变化查询只使用本地已加载的 immutable view。这比“每次让大模型重新阅读文件夹”更稳定，也把 token 成本从资料规模改为证据预算。

需要注意：当前 Evidence Pack 对 excerpt 有明确字符预算，但完整 JSON 还包含 query、相对路径、标题、分数组件等结构开销。因此预算应理解为“证据正文上界”，不是某个供应商 tokenizer 对整个响应的精确 token 数。真实客户端仍应测量完整响应大小。

### 2. 长期资料散落在不同位置

通过多来源 runtime catalog、稳定 source ID 和各自独立 generation，文件可以留在原位置又共享一个查询面。这个选择优于先把正文复制进一个中心数据库：它保留原始文件所有权和可移植性，同时把数据库降为可重建派生层。

需要注意：来源移动时，应保留稳定逻辑 `id`；相对路径变更仍会产生新的 document 身份。系统不会自动假定两个路径是同一份资料，这个决定应由显式迁移工具或人工确认完成。

### 3. 切换大模型后记忆不互通

基础条件已经具备。Evidence Pack、版本 ID、权限和写入协议都独立于模型供应商；多个模型可以读取同一个本地编译层。模型 provider/name 只进入审计 actor，不授予权限。

这不等于已经完成“自主长期记忆治理”。哪些观点是事实、哪些偏好需要保留、冲突如何解决、什么可以成为稳定 core，仍需要后续的记忆策略层和人工治理。当前设计正确地没有用模拟遗忘曲线去删除 AI 能保留的内容，而是通过 scope、时间、版本和检索排序实现选择性注意。

## 架构质量评价

### 做得好的部分

1. **离线与在线真正分离。** 在线 bootstrap 读 runtime catalog 和 generation，而不是再次解析来源。只读来源硬盘离线仍可查询，是这个分层是否成立的关键证据。
2. **权限在检索之前。** Source / Project / Mode / Path 都由服务器 Principal 决定；请求只能收窄，项目记录缺少显式授权就失败关闭。
3. **Dense 是可替换通道，不是新真理层。** 向量与 adapter、model、dimension、输入 recipe 绑定，和 BM25 / metadata / temporal / hierarchy 平行，再由 RRF 汇合。可以 A/B，不能静默改变语义。
4. **发布是一项状态机。** checkpoint 解决长任务恢复，final rescan 解决编译途中源变化，READY / CURRENT 解决在线只看完整版本，runtime catalog 解决多来源集合的一致发布。
5. **写入授权与模型能力分离。** MCP 写工具默认不注册；可信宿主显式启用后，模型能准备建议，但不能实现自己的审批器或签发凭据。写入、删除和撤销都必须由私有 UI 的精确人类确认解锁。
6. **不确定提交不会被隐藏。** 文件已经改变但审计 / reingest 失败时返回 degraded 回执和恢复信息，避免客户端误以为失败后安全重试。
7. **接口不绑定单一模型。** MCP、HTTP、runtime、embedding、reranker 和 writer 契约分开，使本地知识层可以跨客户端复用。

### 需要持续关注的风险

#### A. 真实检索质量仍未知

五路召回和 RRF 只证明结构完整，不证明真实相关性。deterministic embedding 是可复现的 lexical-hash baseline；它不是语义模型。应在私有标注集比较：

- BM25 + Metadata；
- BM25 + Metadata + Temporal / Hierarchy；
- 加本地 semantic Dense；
- 再加本地 Reranker。

每一步只有在 Recall@k、nDCG、无证据拒答和跨项目泄漏均不退化，且仍符合延迟要求时，才进入默认组合。不要用模型主观评价替代带答案的检索标注。

#### B. Compact Lexical 与在线结构还有优化空间

1.3 会持久化并严格校验 compact postings，但在线 BM25 仍从已编译 Derived records 建立内存 postings，而不是直接把 compact artifact 当作 chunk 级查询执行结构。这没有重新扫描原文，也不破坏五层闭环，但热启动和大语料内存仍有进一步优化空间。下一阶段可以把持久 lexical 规范升级到 chunk ordinal，或增加只读 memory-map / segment reader。

#### C. 五秒截止依赖协作式扩展

内置 retriever、网络 adapter 和循环会检查取消与 wall-clock；但 Node.js 同一线程无法抢占恶意或错误的同步第三方插件。若开放第三方 adapter，应默认放入 worker / 子进程，设置协议级 deadline、输入 / 输出字节限制和强制终止。

#### D. 文件系统对同用户恶意进程不是沙箱

symlink、realpath、device / inode 和 CAS 能覆盖常见错误与很多替换攻击，但 Node.js 缺少覆盖所有步骤的便携 `openat` 模型。拥有同一账户权限并能在调用之间替换祖先目录的恶意进程不在保证内。生产环境应把来源、artifact 和 writer state 放在私有、祖先不可由其他进程写的本地目录。

#### E. Windows 只具备较弱的掉电承诺

不支持目录 `fsync` 时仍能保持原子 rename 可见性和重启校验，但不能承诺突然掉电后最新 `CURRENT`、catalog 或 audit 尾记录一定落盘。文档与 UI 应继续明确这一区别。

#### F. Obsidian 写入宿主尚未闭合产品验收

可注入 Obsidian Writer 契约已经定义，但默认 runtime 只允许普通目录 Writer。要在 Obsidian 中声称“可写”，还需要插件实现 bridge，并现场验证编辑器未保存改动、移动 / 重命名、移动端同步冲突、插件热重载、审核取消和写后索引刷新。

## 用户操作审核

目标用户不应理解 BM25、RRF、generation 或 CAS 才能使用系统。建议产品 UI 只暴露：

- “添加来源 / 重新编译 / 后台保持更新”；
- 一个普通问题输入框和带来源的答案；
- 当且仅当修改原文时出现的 Diff 审核框；
- 写入回执中的“已更新”“已更新但索引刷新失败”“可撤销”三类清晰状态。

以下信息必须在人工审核中特别突出，不能折叠到高级选项：来源名称、相对路径、create / replace / delete、风险级别、完整变更 Diff、目标是否自上次读取后变化、写后重新摄取状态。删除、高风险覆盖和批量操作不应只靠颜色区分。

算法可以自动做扫描、分类、索引、候选关联、重复提示、时序线索和修改建议；用户必须决定来源 / 项目权限、长期事实的真伪、冲突取舍、最终写入内容、删除和撤销。自动校对可以生成提案和风险解释，但不能把“高置信度”当作人工批准。

## 建议的验收顺序

```text
1. 合成安全与故障测试
   → 2. 仓库外小型私有 gold set
      → 3. 大目录冷编译 / checkpoint 恢复
         → 4. 无变化 warm query 五秒验收
            → 5. 项目隔离与安全拒答红队
               → 6. 普通目录写入 / degraded / rollback 演练
                  → 7. Obsidian 桌面 bridge 与私有审核 UI
                     → 8. 第二个模型客户端互操作
```

其中 2、3、4 可以并行采集数据；5 必须在开放真实内容前完成；6 必须在 7 之前稳定，因为 UI 不应掩盖底层协议问题；8 可以和 7 平行。

私有相关性集至少应覆盖：精确事实、同义表达、中文 / 英文混合、标题与正文冲突、同文跨来源、过期材料、时间问句、层级问句、无答案、被禁项目、来源离线和近重复。答案、标题和实际路径不得写入仓库测试报告。

## 发布建议

1. 保留 1.2 只读服务作为兼容路径，但文档和可执行入口必须明确区分，避免用户以为旧 `index.js` 已经使用新 compiler。
2. 1.3 默认采用 read-only 来源、deterministic embedding、无 reranker、MCP 写工具不注册；只有能保证 app-only 工具和 `_meta` 不暴露给模型的宿主，才可显式设置 `trusted-mcp-app` 并逐项启用。该开关是部署信任声明，不是密码学用户在场证明。
3. 不把未经私有语料测试的 Dense / Reranker 设置为质量默认值。
4. HTTP 长期保持只读；需要修改时使用 MCP 私有 UI 或专门的本地可信宿主，不添加一个仅凭 API key 的远程写端点。
5. 将下一版本重点放在真实评测、Obsidian 宿主体验和直接消费 compact lexical，而不是继续增加更多未经验证的召回通道。

总体判断：1.3 的架构已经具备成为“模型之外的本地第二大脑”的正确骨架。它保留 AI 的广泛记忆优势，同时把注意力、权限、证据和人类承诺分开。接下来最有价值的工作不是再扩大功能清单，而是用真实私有语料和真实 Obsidian 操作证明这套闭环在用户环境中确实准确、简单且可恢复。
