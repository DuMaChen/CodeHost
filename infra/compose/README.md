# Compose 基础部署

Compose 只负责本地基础服务和平台进程：PostgreSQL、Gitea、Registry、API、Worker、Web 契约和 Agent Review 契约。每个服务使用独立的 named volume；平台日志使用单独的 `platform_logs` volume。Compose Registry 的容器内地址固定为 `registry:5000`，与 k3d 的 `ai-registry:5000`、k3s 的 `${REGISTRY_HOST}:30500` 分开。

## 启动

```sh
cp infra/compose/.env.example .env
# 修改 POSTGRES_PASSWORD、GITEA_WEBHOOK_SECRET 和 SESSION_ENCRYPTION_KEY
docker compose up -d postgres gitea registry
docker compose --profile migration run --rm migrate
docker compose up -d api worker web agent-review
docker compose ps
```

根目录 `Dockerfile` 提供 API、Worker、Web 和 Agent Review runtime。Agent Review 在配置 `DATABASE_URL` 后消费 `platform.agent-review` 队列并发布 `platform.agent-review-result`，因此必须在迁移成功后启动。

访问地址：Gitea `http://localhost:3001`、API `http://localhost:3000/healthz`、Registry 调试端口 `localhost:5001`。这些宿主机地址只用于开发者访问；Compose 内的镜像地址仍使用 `registry:5000`。

## 停止与数据

```sh
docker compose down
docker volume ls --filter name=ai-platform-compose
```

不要使用 `docker compose down -v`，除非明确要删除 Gitea、数据库、Registry 和平台日志。生产或服务器演示不使用本文件。

Worker 的 kubeconfig 必须先由 `infra/k3d/bootstrap.sh` 生成，并且只以只读方式挂载到受信任的 Worker；用户 Run 容器不挂载该文件。Compose 文件没有 Docker Socket、`privileged`、`hostPath` 或设备映射。
