# Course Demo

本脚本用于答辩或课程验收，目标是证明一条 PR 质量闭环，而不是展示生产运维能力。Demo 使用受邀仓库和非敏感 Fixture；不要把公网不可信仓库、真实 Secret 或生产数据接入。

## 前置条件

- Gitea 已创建课程示例仓库，并配置 Webhook、OAuth、分支保护和 Required Checks。
- PostgreSQL、Registry、平台日志卷和迁移已就绪。
- 本地路径使用 Docker Compose + k3d；服务器路径使用单节点 k3s + Traefik + Registry。
- 服务器 Ingress 模式已设置 `PREVIEW_BASE_URL` 和 DNS/hosts 映射；没有稳定地址时准备 SSH 隧道。
- 已确认 Node/Python 固定 Profile、Mock Agent、Gitleaks 和清理任务可用。
- 已确认单节点 `Allocatable` 资源，并为 k3s、CoreDNS、local-path-provisioner、Traefik 和 Registry 预留至少 20%。

## 开场说明

先说明边界：这是基于 Gitea 的课程版 PR 质量与 Kubernetes 临时预览平台，面向受邀团队和非敏感课程代码。单节点 k3s 上的多个 Pod 共享一个 Node；默认一个 Agent review Pod，推荐演示最多三个，它们消费不同 Run，不执行用户代码，也不是同一个 PR 的多 Agent 投票系统。

## 成功 PR

1. 在 Gitea 展示课程仓库、分支保护、Required Checks 和待审 PR。
2. 从短分支创建 Node 成功 PR，确认平台收到签名 Webhook 并返回 `202`；运行详情中的 Profile 应为 `node-http`。
3. 打开运行详情，展示 `detect`、`fetch`、`analyze`、`test`、`build`、`preview`、`health`、`agent-review` 和 `cleanup` 时间线。
4. 展示 `kubectl get ns` 中独立的 `pr-run-<run-short-id>` Namespace，以及 Quota、Restricted Pod Security 和 Preview 资源。
5. 展示固定测试、rootless BuildKit/Fixture 模式、镜像 Digest 和 Preview 状态。若动态构建闸门未通过，明确展示 `BUILD_MODE=FIXTURE`，不要称为动态构建已完成。
6. 本地模式执行平台返回的 `portForwardCommand`；服务器模式打开带过期时间的 Traefik Ingress URL。无稳定域名时展示 `sshTunnelCommand`，并说明访问方式。
7. 展示 Agent 结构化报告、Finding 的文件与行号、脱敏结果、平台日志和 Gitea Comment。
8. 在未人工批准时尝试合并，展示分支保护阻断。
9. 由一名非作者 Reviewer 批准，确认五个平台状态绑定当前 `head_sha` 且满足合并条件，再合并 PR。
10. 展示 Preview 默认 30 分钟过期、Run 日志/报告/临时镜像默认 7 天保留的清理策略，并等待 Worker 清理 Namespace。

需要证明第二种 Profile 时，使用 `examples/python-good` 创建 PR，运行计划应显示 `python-http`、端口 `8000` 和 `main.py`；不要把 Node 和 Python 混合仓库作为成功案例。

## 失败 PR

1. 创建 Node 测试失败 Fixture PR。
2. 展示 `platform/test` 和 `platform/quality-review` 为失败，PR 不能合并。
3. 展示测试错误摘要仍进入 Agent review，报告最终解释失败原因；不相关的后续步骤标记为跳过，而不是保持 pending。
4. 展示失败 Run 的 Namespace、Preview、临时 Job 和 workspace PVC 被清理，或展示 `cleanup_status` 和可追踪的清理错误。

可选地再演示健康检查失败 Fixture，确认 Preview 不 Ready、`platform/preview` 失败、Agent 能看到脱敏的健康结果且资源可清理。

## 重试与取消

1. 运行失败且 `cleanup_status=CLEANED` 时，在运行台点击“重新运行”，确认 `current_attempt` 增加、旧报告保留且新的 `detect` 任务进入队列。
2. 运行处于排队或执行阶段时点击“取消运行”，确认状态先变为 `CANCEL_REQUESTED`，清理确认后才变为 `CANCELLED`。
3. 若清理状态为 `FAILED`，只有维护者明确确认残留资源风险后才能重试；该请求使用 CSRF 保护的 POST，并带有单独的人工确认标记。

## 幂等与安全证据

展示同一个 Gitea delivery ID 重放后只有一个 Run 和一个 Namespace。展示任务容器没有 Gitea Token、模型 Key、kubeconfig 和 ServiceAccount Token；可以使用专门的 Secret Canary Fixture 验证值没有出现在 stdout、stderr、平台日志、Agent 输入、报告、数据库、Gitea Comment 或临时文件中。

展示 Agent 只能回传符合 strict Schema 的报告，不能生成 Shell、kubectl、Kubernetes YAML、patch、commit 或 merge 字段。说明人工 Reviewer 才能完成合并判断。

## 收尾与记录

保存脱敏的 Run ID、当前 head SHA、五个 Status、报告摘要、Preview 访问模式、Namespace 清理结果和测试命令结果。记录实际使用的部署模式、Agent 副本数量、节点资源和任何降级项。若使用的是本地 k3d，不把它描述成生产安全沙箱；若使用的是单节点 k3s，不把它描述成 HA 集群。
