# AI-Native PR Quality Platform

---

## 目录

1. 项目背景
2. 项目目标
3. 系统架构
4. 技术选型
5. 核心功能模块
6. 工作流程
7. 部署方案
8. 安全设计
9. 演示用例
10. 开发指南

---

## 1. 项目背景

- 课程教学中，学生 PR 质量参差不齐，人工 Review 成本高
- 缺乏自动化的测试、代码检查、预览环境能力
- 需要一套面向教学场景的**轻量级 PR 质量门禁平台**

---

## 2. 项目目标

| 目标 | 说明 |
|---|---|
| **自动化流水线** | PR 提交后自动触发测试 + 安全扫描 + 预览部署 |
| **AI 辅助审查** | 利用 LLM 对代码变更进行结构化分析 |
| **临时预览环境** | 每次 PR 生成独立的 Kubernetes 预览环境 |
| **教学友好** | 固定 Profile，学生无需配置环境 |
| **低成本部署** | 单节点可运行，适合课程团队使用 |

---

## 3. 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                       Gitea                             │
│              (仓库 / Issue / PR / Review / 权限)          │
└──────────┬──────────────────────────────────────────────┘
           │ Webhook / OAuth
           ▼
┌──────────────────┐    ┌──────────────────┐
│    API 服务        │◄───│   PostgreSQL      │
│  (NestJS+Fastify)  │    │   + pg-boss 队列   │
└────────┬─────────┘    └──────────────────┘
         │ 任务队列
         ▼
┌──────────────────┐    ┌──────────────────┐
│   Worker 编排器    │───►│   K8s Run 资源     │
│  (工作流调度)       │    │   (独立 Namespace)  │
└────────┬─────────┘    └──────────────────┘
         │ Review 请求
         ▼
┌──────────────────┐    ┌──────────────────┐
│  Agent Review     │    │   Web 前端        │
│  (AI 审查服务)      │    │   (React + Vite)  │
└──────────────────┘    └──────────────────┘
```

### 组件职责

| 组件 | 职责 |
|---|---|
| **Gitea** | 代码托管、PR 管理、OAuth 认证、分支保护 |
| **API** | Webhook 接收、OAuth 认证、查询接口（入库即返回 202） |
| **PostgreSQL** | 持久化 Run / Step / Report / Audit，pg-boss 任务队列 |
| **Worker** | 工作流编排：Source Fetch → Analysis → Build/Test → Preview → Agent |
| **K8s** | 每 Run 独立 Namespace、Job、PVC、Service、Ingress |
| **Agent Review** | 脱敏输入 → LLM 分析 → 结构化审查报告 |
| **Web** | PR 状态看板、运行历史、报告展示 |

---

## 4. 技术选型

| 层次 | 选型 | 选型理由 |
|---|---|---|
| **运行环境** | Node.js 22 LTS | 长期支持、ESM 原生支持 |
| **包管理** | pnpm 11 + Workspace | 高效 monorepo 管理 |
| **后端框架** | NestJS 11 + Fastify | 企业级架构、高性能 HTTP |
| **前端** | React 19 + Vite 5 | 现代 UI 开发、快速 HMR |
| **数据库** | PostgreSQL 16 | 成熟可靠、JSON 支持 |
| **ORM** | Drizzle ORM | 类型安全、SQL-like |
| **任务队列** | pg-boss | 基于 PostgreSQL 的可靠队列 |
| **容器编排** | Docker + k3d/k3s | 轻量 K8s、本地开发友好 |
| **Schema 校验** | Zod | 类型推导、运行时校验 |
| **代码托管** | Gitea 1.22 | 轻量自托管 Git 服务 |
| **AI** | 可插拔 Provider | Mock / 真实 LLM 灵活切换 |

---

## 5. 核心功能模块

### 5.1 自动化测试流水线

```
Source Fetch ─► Gitleaks 安全扫描 ─► Build / Test ─► 结果收集
```

- 固定 Profile：`node-http` / `python-http`
- 平台生成受控 Dockerfile，不接受仓库自带
- 测试结果自动回写到 Gitea Status

### 5.2 Kubernetes 临时预览

```
独立 Namespace ─► Preview Deployment ─► Service / Ingress ─► 自动清理
```

- 每 Run 独立隔离，避免互相影响
- 支持健康检查路径配置
- 运行完成后自动清理资源

### 5.3 AI Agent 审查

- 从 pg-boss review 队列拉取任务
- 输入脱敏、长度限制
- 输出通过严格 Schema 校验
- 支持 Mock Provider（默认）和真实模型 Provider
- 单 PR 只生成一份聚合报告

### 5.4 容量管理

| 参数 | 默认值 |
|---|---|
| 最大活跃 Runs | 1 |
| 最大排队 Runs | 3 |
| 超出容量处理 | `REJECTED_BY_CAPACITY` |
| Agent Pod 副本 | 1（推荐最多 3） |

---

## 6. 工作流程

```
PR 提交
   │
   ▼
Gitea Webhook ──────────────────────► API (入库)
                                           │
                                           ▼
                                    Worker 编排
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    ▼                      ▼                      ▼
             Source Fetch           Analysis Tools           Build/Test
             (Git Clone)           (Gitleaks 等)          (固定 Profile)
                    │                      │                      │
                    └──────────────────────┼──────────────────────┘
                                           ▼
                                   Preview 部署
                                   (K8s Namespace)
                                           │
                                           ▼
                                   Agent Review
                                   (结构化报告)
                                           │
                                           ▼
                              Gitea Status/Comment
                                           │
                                           ▼
                                 人工 Review / 合并
                                           │
                                           ▼
                                  自动清理资源
```

---

## 7. 部署方案

### 7.1 本地开发（Docker Compose + k3d）

```bash
# 启动依赖服务
docker compose up -d

# 创建本地 K3s 集群
k3d cluster create

# 启动开发服务器
pnpm dev
```

| 服务 | 端口 |
|---|---|
| Gitea | 3001 |
| API | 3000 |
| Web | 8080 |
| Agent Review | 3002 |
| PostgreSQL | 5432 |
| Registry | 5001 |

### 7.2 服务器演示（单节点 k3s）

- 单节点 k3s + Traefik + 本地 Registry
- 所有组件运行在同一 Node
- **推荐配置**：8 vCPU、16GB RAM、80-100GB SSD
- **无高可用**：Node 宕机即不可用

---

## 8. 安全设计

| 原则 | 实现 |
|---|---|
| **最小权限** | Worker 不执行用户代码、不访问 K8s API、不读取 Sandbox Secret |
| **输入限制** | Agent 仅接收脱敏限长输入 |
| **拒绝风险** | 不接受仓库自带的 Dockerfile / Shell / K8s YAML |
| **受控构建** | 平台生成 Dockerfile，仅支持固定 Profile |
| **隔离** | 每 Run 独立 K8s Namespace |
| **自动清理** | Run 完成后删除所有资源 |
| **容量保护** | 超出容量自动拒绝 |

> 面向受邀学生团队和非敏感课程代码，不适用于生产环境或公共不可信代码。

---

## 9. 演示用例

| 用例 | 说明 | 预期结果 |
|---|---|---|
| `node-good` | 正确 Node.js 项目 | 全部通过 |
| `node-test-fail` | 测试失败 | 测试阶段失败，报告标注 |
| `python-good` | 正确 Python 项目 | 全部通过 |
| `python-health-fail` | 健康检查失败 | 预览阶段失败 |

所有示例仓库无公网依赖，可作为课程 Fixture 使用。

---

## 10. 开发指南

### 环境要求

- Docker
- Node.js 22 LTS
- pnpm 11
- kubectl
- k3d

### 常用命令

```bash
pnpm install              # 安装依赖
pnpm build                # 构建所有包（按依赖顺序）
pnpm dev                  # 启动 API 开发模式
pnpm typecheck            # 全项目类型检查
pnpm test                 # 运行所有测试
pnpm lint                 # 代码检查
pnpm db:generate          # 生成 Drizzle 迁移文件
pnpm db:migrate           # 执行数据库迁移
pnpm test:e2e             # 端到端测试
pnpm ci                   # CI 流程（typecheck + test）
```

### 文档索引

| 文档 | 内容 |
|---|---|
| [DEVELOPMENT.md](./DEVELOPMENT.md) | 启动、环境变量、迁移、测试、清理 |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 贡献指南 |
| [SECURITY.md](./SECURITY.md) | 安全策略 |
| [docs/architecture.md](./docs/architecture.md) | 架构说明 |
| [docs/threat-model.md](./docs/threat-model.md) | 威胁模型 |
| [docs/demo.md](./docs/demo.md) | Demo 脚本 |
| [docs/verification.md](./docs/verification.md) | 验证记录 |
| [docs/deployment.md](./docs/deployment.md) | 部署详细说明 |

---

## 许可证

Apache-2.0
