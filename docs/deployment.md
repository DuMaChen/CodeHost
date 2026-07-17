# 基础部署

本项目维护三条地址和凭据边界：

| 模式 | Registry 地址 | Worker Kubernetes 凭据 |
| --- | --- | --- |
| Compose | `registry:5000` | 只读挂载 k3d bootstrap 生成的 kubeconfig |
| k3d | `ai-registry:5000` | Compose Worker 使用 `host.docker.internal:6550` 访问 k3d API |
| k3s | `${REGISTRY_HOST}:30500` | Worker 使用 `platform-worker` In-Cluster ServiceAccount |

不要把宿主机调试端口、`localhost` 或用户输入拼进 Pod 的镜像地址。不要给任何平台或 Run 容器挂载 Docker Socket；rootless BuildKit 通过受控 Job 和 Registry 推送镜像。

## 本地顺序

```sh
infra/k3d/bootstrap.sh
docker compose up -d postgres gitea registry
docker compose --profile migration run --rm migrate
docker compose up -d api worker web agent-review
```

先验证 `docker compose ps` 的数据库、Gitea、Registry 和 API 健康状态，再执行 BuildKit push -> Registry -> containerd pull -> Preview Deployment smoke test。Worker 的 kubeconfig 只读挂载，用户 Run 不继承该挂载。

## 服务器顺序

1. 在唯一 k3s 节点配置 `/etc/rancher/k3s/registries.yaml`，HTTP 只用于私有实验网；正式服务器使用 HTTPS CA。
2. 设置 `infra/k3s/.env.example` 中的私有 Registry、镜像、域名和敏感环境变量。
3. 执行 `infra/k3s/install.sh`；脚本会先运行唯一的 `platform-migrate` Job，迁移成功后才等待 API、Worker、Agent Review 和 Web rollout。确认 `platform-system` 中的四个 PVC、迁移 Job 和基础服务状态。
4. 先完成镜像链路 smoke test，再创建第一个 Run；无稳定 DNS/`PREVIEW_BASE_URL` 时设置 `PREVIEW_MODE=ssh`、`PREVIEW_SSH_HOST` 和 `PREVIEW_SSH_USER`，由 API 返回 SSH 隧道命令。

SSH Preview 使用服务器上的 `kubectl port-forward`，命令只允许指向平台生成的 `service://<namespace>/<service>` 引用；平台不会执行命令，也不会把服务器端口伪装成本机 URL。`PREVIEW_SSH_PORT` 默认为 `22`，缺少 SSH 主机或用户时 Preview 接口会返回可解释的配置错误。

基础 PVC 的回收策略为 Retain：Gitea 5 GiB、PostgreSQL 10 GiB、Registry 20 GiB、平台日志 10 GiB。Run workspace PVC 应由 Worker 使用 Delete 策略并在 Namespace 清理时回收。
