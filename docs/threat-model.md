# Threat Model

## 结论

课程版只降低受邀、非敏感课程仓库的常见误操作和跨组件泄露风险。它不是恶意代码沙箱，也不承诺防御 Kubernetes 内核漏洞、容器逃逸、公网不可信输入、SSD 密码学擦除、生产级多租户隔离、高并发、HA 或节点故障。

## 资产与信任边界

| 资产 | 保护目标 | 主要边界 |
|---|---|---|
| Gitea Token、OAuth Session、Webhook Secret | 不进入任务和日志；可撤销 | Gitea/API/Worker 与任务容器之间 |
| 模型 API Key | 仅由 Agent review 使用 | Agent Deployment 与其他 Pod 之间 |
| PR 源码、Diff、测试和构建结果 | 限定到当前 Run；脱敏后才进入 Agent | Gitea、Worker、Run Namespace、review 队列 |
| PostgreSQL、Registry 和平台日志 | 持久化、权限隔离、可清理 | 平台服务与持久化卷之间 |
| Kubernetes 控制面 | 任务不能操作控制面 | Worker RBAC 与 Run Pod 之间 |
| Gitea Status、Comment、人工批准 | 只能由受信任 Worker 和人写入 | Worker 与 Gitea API 之间 |

受信任组件是 Gitea、API、Worker、数据库、受控镜像和 `agent-review` 服务本身；Run 内的 Source Fetch、Analysis、Build/Test 和 Preview 视为不可信输入执行环境。Agent 不是代码执行器，但其输入和输出仍按不可信文本处理。

## 主要威胁与控制

| ID | 威胁 | P0 控制 | 残余风险 |
|---|---|---|---|
| T1 | 伪造或重放 Webhook | 原始字节签名、delivery 幂等、时间窗、payload hash 审计 | Gitea 或签名 Secret 本身失陷不在课程版能力内 |
| T2 | 任务容器读取 Token、Key 或 kubeconfig | 凭据按组件最小分发；Source Fetch 一次性 Secret；任务关闭 Token 挂载 | 同一单节点共享内核，不能承诺对抗逃逸 |
| T3 | 容器获得宿主或控制面能力 | Restricted PSA、non-root、禁止 privileged/hostPath/host namespace/Docker Socket/设备映射、最小 Worker RBAC | Kubernetes 内核、运行时或节点漏洞未覆盖 |
| T4 | 资源耗尽 | 每 Run Quota/LimitRange、CPU/内存/临时盘/日志/时长上限、最多一个活动 Run、自动清理 | 单节点故障和高并发不在承诺内 |
| T5 | Secret 进入 Agent 或报告 | Gitleaks 输出隔离、`[REDACTED]` 脱敏、输入 64 KiB 限长、日志和报告清洗、Canary 测试 | 未被测试覆盖的新工具输出可能需要补充规则 |
| T6 | Prompt Injection 扩大 Agent 权限 | Agent 无 K8s/Gitea 写权限；只生成 Schema 报告；人工 Review 才能合并 | Agent 的判断可能错误，不能替代确定性测试和人工判断 |
| T7 | 恶意 YAML、Shell 或 Dockerfile | 固定 Profile、受控 Dockerfile、固定命令和资源；模型禁止生成命令/YAML | 固定 Profile 自身缺陷仍需测试和修复 |
| T8 | Worker 崩溃造成重复或丢失执行 | 事务 Outbox、pg-boss lease、advisory lock、步骤终态检查和资源对账 | 外部 Gitea/Registry 长期不可用需人工处理 |
| T9 | 越权读取别人的 Run | OAuth、仓库读取权限复核、401/403、维护者操作校验 | Gitea 权限配置错误会扩大暴露面 |
| T10 | 旧 PR 状态覆盖新提交 | Status、Comment、报告绑定 head SHA 和 attempt | Gitea 外部配置错误仍可能造成误读 |
| T11 | 预览或临时镜像长期暴露 | Ingress 过期时间、Preview 30 分钟、临时镜像/日志 7 天、Retention Worker | 单节点存储删除不是密码学擦除 |

## 非承诺的隔离项

P0 不以 k3d 网络策略是否生效作为安全证明；需要跨 Namespace 网络隔离证明时，使用 P1 的 kind + Calico 独立验证。P0 不接收公网任意仓库和敏感代码，不针对容器逃逸或 Kubernetes 内核漏洞设计。单节点 k3s 不提供 HA、故障转移或节点级隔离；多个 Agent Pod 与其他平台组件可能运行在同一个 Node 上。

## 验证要求

安全变更至少应验证无效签名、重放事件、任务无凭据、无 Docker Socket/hostPath/特权、资源和日志上限、Gitleaks Canary 八处脱敏、Prompt Injection 无额外权限、OAuth/CSRF/仓库权限、Worker RBAC、失败/超时/取消/重启清理和 Retention。任何未通过项都不能在 README 或发布说明中写成已完成安全能力。

## 风险接受

课程维护者接受上述单节点、受邀代码、非生产和非对抗环境的限制，换取可在有限资源上完成教学演示。若使用场景变为公网、不可信代码、敏感数据或生产服务，应暂停复用本方案并重新进行隔离、身份、审计、备份、网络和高可用设计。

