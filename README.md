# Continuum Canvas

Continuum Canvas 是一个基于 React、TypeScript 和 React Flow 的无限画布编辑器。浏览器端负责画布交互、项目状态与本地持久化；仓库内置的 Node gateway 负责供应商配置、素材存储、任务执行和静态文件托管。

gateway 使用 provider registry + adapter 架构。当前随仓库提供的可用 adapter 是 AIStartLab OpenAPI；其他供应商可以通过实现 `server/providers/provider-adapter.ts` 接入，但没有安装 adapter 的供应商会保持不可用，不会接收或发送密钥。

## 系统结构

- React Flow 画布：节点、连线、分组、选区、生成面板与工作流交互。
- Zustand + IndexedDB：浏览器中的画布状态、项目数据和界面偏好。
- Node gateway：`/api`、供应商注册表、目录缓存、生成任务和素材文件。
- AIStartLab adapter：provider adapter 接口的内置实现，密钥只在 gateway 进程内使用。
- 本地数据目录：JSON 状态、任务恢复信息、目录缓存和素材二进制文件。

## 环境要求

- Node.js 22.18 或更高版本
- npm 10 或更高版本

Node 版本下限来自 gateway 直接运行 TypeScript 文件以及 Vite 8 的运行要求。

## 安装与开发

Windows PowerShell：

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

macOS / Linux：

```bash
npm ci
cp .env.example .env.local
npm run dev
```

`npm run dev` 同时启动 Vite 客户端和本地 gateway：

- 客户端：`http://127.0.0.1:4173`
- gateway：`http://127.0.0.1:4174`

画布入口示例：`http://127.0.0.1:4173/canvas?spaceId=local&projectId=reference`

## 生产运行

Windows、macOS 和 Linux 使用同一组 npm 脚本：

```bash
npm ci
npm run build
npm start
```

`npm start` 默认在 `127.0.0.1:4173` 启动 gateway，并从 `dist/` 提供前端静态文件。部署到非本机地址时，应通过下面的环境变量显式配置 host，并仅在受信任网络或经过访问控制的反向代理后使用。

## 配置

配置优先级从低到高为：仓库 env 文件、`process.env`、程序化启动 options。默认 env 文件是项目根目录下的 `.env.local`，它不会覆盖容器、服务管理器或 shell 已注入的环境变量。

相对路径始终相对于项目根目录解析，不依赖启动命令的当前工作目录。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CANVAS_ENV_FILE` | `<项目根>/.env.local` | env 文件路径；通过进程环境或程序化 option 设置 |
| `CANVAS_DATA_DIR` | `<项目根>/data` | gateway 数据目录 |
| `CANVAS_GATEWAY_HOST` | `127.0.0.1` | gateway 监听地址 |
| `CANVAS_GATEWAY_PORT` | 开发 `4174`，生产 `4173` | gateway 监听端口；兼容旧变量 `GATEWAY_PORT` |
| `CANVAS_VITE_HOST` | `127.0.0.1` | Vite 开发服务器监听地址；局域网开发可设为 `0.0.0.0` |
| `CANVAS_ALLOW_INSECURE_LAN` | 未设置 | 显式允许私网 IP 使用 HTTP 协作；公网地址不受此开关影响，仍强制 HTTPS |
| `CANVAS_PUBLIC_ORIGIN` | 未设置 | 公开协作部署的 HTTPS 站点 Origin；非回环监听时必填 |
| `CANVAS_ALLOWED_ORIGINS` | 未设置 | 允许访问 HTTP 与 WebSocket 协作接口的 Origin，逗号分隔且必须包含公开 Origin |
| `CANVAS_GENERATION_MAX_RUN_TIME_MS` | `1800000` | 单个上游生成任务的最长本地跟踪时间；允许 1 分钟至 24 小时 |
| `API_PROVIDER_AISTARTLAB_KEY` | 未设置 | AIStartLab API 密钥 |
| `CANVAS_DOH_ENDPOINT` | 未设置 | 可选的 DNS-over-HTTPS resolver |

Windows PowerShell 临时覆盖示例：

```powershell
$env:CANVAS_GATEWAY_PORT = '5180'
$env:CANVAS_DATA_DIR = Join-Path $env:ProgramData 'libtv-canvas'
npm run server
```

macOS / Linux 临时覆盖示例：

```bash
CANVAS_GATEWAY_PORT=5180 CANVAS_DATA_DIR=/var/lib/libtv-canvas npm run server
```

这些路径只是命令示例，不是代码中的默认值；仓库没有硬编码盘符、用户名或用户主目录。

## 自托管多人协作

多人协作与普通画布共用同一个 Node gateway。默认只绑定 `127.0.0.1`，适合本机开发；局域网或公网协作必须显式修改 `CANVAS_GATEWAY_HOST`，并同时设置 `CANVAS_PUBLIC_ORIGIN` 和 `CANVAS_ALLOWED_ORIGINS`。公开 Origin 强制使用 HTTPS，WebSocket 应由同源反向代理升级为 WSS。

开发服务会自动选择真实的私网 IPv4 地址（优先避开 VMware、WSL 等虚拟网卡），让 Vite 与 gateway 监听局域网，并让邀请链接使用该地址。`npm run dev:service` 启动时会同时输出本机地址和 `LAN share` 地址；另一台设备应打开后者。若系统存在多个真实网卡或需要固定地址，可在 `.env.local` 中显式设置 `CANVAS_PUBLIC_ORIGIN`、`CANVAS_ALLOWED_ORIGINS`、`CANVAS_VITE_HOST` 与 `CANVAS_GATEWAY_HOST`，显式值优先于自动检测。此 HTTP 模式只接受私网 IP，不适用于互联网部署。

如果另一台设备打不开 `LAN share` 地址，先确认两台设备连接同一局域网，并允许 Windows 防火墙中的 TCP `4173` 端口。邀请必须从新的局域网页面重新复制；旧的 `127.0.0.1` 邀请链接仍然只能在本机使用。

典型反向代理需要把静态页面、`/api` 和 `/api/collaboration/ws` 转发到同一 gateway，并为 WebSocket 路径保留 `Upgrade` 和 `Connection` 请求头。不要绕过 gateway 直接暴露协作数据目录。首次开启协作的设备是房间所有者；编辑和查看邀请使用不同权限，邀请秘密只在 URL fragment 中传递，交换为 HttpOnly 会话后会从地址栏移除。

协作房间的 Yjs 快照、增量日志、成员和邀请元数据保存在 `CANVAS_DATA_DIR/collaboration`。部署迁移或升级前应备份整个数据目录。供应商 API Key、上传签名和邀请明文不会写入 Yjs 文档；供应商密钥仍只应通过 secret manager 或进程环境注入。

当前协作实现面向最多 10 个客户端的单实例自托管部署，不包含中心账号、跨实例联邦、水平扩展、端到端加密、评论或云端“共享给我”。需要多实例时，必须先增加共享持久化、房间路由和跨实例广播，不能让多个 gateway 直接并发写同一个数据目录。

## 数据与密钥安全

默认 `data/` 包含 `providers.json`、`jobs.json`、`catalog-cache.json`、任务恢复文件和 `assets/`。一个数据目录同一时间只能由一个 gateway 进程使用。

`.gitignore` 保留 `data/`、`secrets/`、`.env` 和 `.env.*`；只有不含真实值的 `.env.example` 可以提交。生产环境应使用部署平台的 secret manager 或进程环境注入密钥，不要把真实密钥写入仓库、README、日志或 issue。

供应商 API 只返回密钥是否已配置和掩码，不返回明文。gateway 的启动错误与上游错误会映射为受控错误码，不把密钥、上游 URL 或原始异常正文写入响应。`.env.example` 中的密钥值为空，不能直接调用真实供应商。

## 验证

```bash
npm run test:server
npm test
npm run lint
npm run build
```

端到端测试使用 `npm run test:e2e`。视觉参考与当前截图位于 `tests/visual/reference` 和 `tests/visual/current`，测量说明见 `docs/reference-matrix.md`。
