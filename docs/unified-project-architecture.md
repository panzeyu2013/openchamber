# 统一项目架构

> 状态：**已交付并提交**（2026-08-13；本文件由 `unified-workspace-session-architecture.md` 更名，避免与 Catalog 中的 project 实体混淆（原文件名为 `unified-workspace-session-architecture.md`））。
> 基线日期：2026-08-10
> 适用范围：`packages/ui`、`packages/web`、`packages/electron`、`packages/vscode`、`packages/mobile`
> 核心目标：以一个本地 OpenChamber 控制面统一管理所有服务器上的项目（连接）与会话；用户不再通过切换服务器来切换会话。
>
> 已交付内容（架构结论、模块索引、功能开关与诊断语义、架构不变量）已全量迁移至代码与各模块 `DOCUMENTATION.md`。本文件定义：统一连接模型（§1）、分层原则（§2）、连接管理统一化的调整计划（§3），以及未完成事项（退出门禁，§4）。

## 1. 统一连接模型（单一实体）

产品只有一种"服务器"实体：**connection profile**。它不是导航实体，而是统一连接管理的对象；导航实体是它派生的 project。

```
connection profile（唯一实体：id + label + capabilities）
  ├─ kind: local   → broker: localAdapter（内置，控制面本机）
  ├─ kind: direct  → broker: directAdapter（baseUrl + token，SSRF 防护 + 服务端凭据注入）
  ├─ kind: ssh     → broker: sshAdapter（sshInstanceId → ssh-manager 隧道）
  └─ kind: relay   → broker: relayAdapter（relayId + credentialRef，connection-keyed E2EE 隧道）
        ↓
  project(connectionId + canonicalPath)   ← Catalog 唯一实体
        ↓
  session(projectId + upstreamSessionId)  ← 会话索引
```

不变量：

- `kind` 只存在于服务器 Broker 层（profile store + adapters）；Catalog 公共模型（文件与 DTO）不含 kind 分支，`toConnectionSummary` 是唯一公共投影。
- **通道配置是连接的属性，不是平行实体**：SSH 实例、relay 凭据、direct 目标都是某个 kind 的连接的私有实现细节，绝不与连接并列管理。
- 一个 SSH 服务器 = 一个 catalog 连接（上层身份）+ 一个 ssh-manager 实例（通道配置）；两者共享同一生命周期，删除/改名/探活双向一致。
- 设备配对（`/api/client-auth/pairing`）与"远程客户端"是**设备连接**概念，不是服务器连接，管理面与服务器分开。

## 2. 分层原则：底层复用，上层抽象

**底层通道维护直接使用现有组件，绝不重新实现通道**：

| 通道 | 现有组件（保持不变） | 上层只负责 |
|---|---|---|
| SSH | `ssh-manager`（Electron main，隧道生命周期）+ `useDesktopSshStore`（renderer IPC 桥）+ `createSshWorkspaceConnectionAdapter`（按调用解析当前 tunnel URL） | 经 `desktop_ssh_*` IPC 桥发起 创建/连接/断开/重连/删除；renderer 永不接触密钥与 tunnel URL |
| Direct | `directAdapter` + catalog HTTP 端点（创建/探活/浏览） | 表单收集 URL + token |
| Relay | `relayAdapter` + 服务端凭据提供方 | （Phase 5 剩余）创建表单 |
| 本机 | `localAdapter`（内置） | 无 |

**上层只做抽象与编排**：

- `ServersPage` 是全部 connection 的统一管理入口（CRUD + 类型化通道操作 + 探活状态）。
- 公共 DTO `toConnectionSummary` 补 `kind`（非敏感投影：kind 本身不是凭据），使统一入口能区分连接类型并为每种类型提供正确的操作（如 ssh 连接行提供隧道连接/断开）。
- `AddProjectDialog` 的 Add server 表单按类型扩展：direct 沿用现有 URL+token 表单；ssh 经 IPC 创建 ssh-manager 实例并 seed profile（一条龙）；relay 后续接入。
- Catalog 文件与公共 DTO 仍不承载密钥/隧道地址；`kind` 只让 UI 选择操作，不参与权限决策。

## 3. 调整计划（连接管理统一化，分步落地）

背景：SSH 服务器当前的实例管理（`RemoteInstancesPage`/`useDesktopSshStore`）与 catalog 连接管理（`ServersPage`）相互无感知——同一服务器的生命周期被撕裂在两个模块。按 §2 原则收敛为单一实体：

1. **契约层**：`toConnectionSummary` 暴露 `kind`（catalog-schema + 测试）。ServersPage 借此显示类型徽标并为 ssh 连接提供类型化操作。—— **已交付**（2026-08-13）：`kind` 进入公共 DTO（白名单 `local|direct|ssh|relay`，非法/缺失省略），客户端 `ConnectionProfileSummary.kind` 同步，路由与 schema 测试覆盖。
2. **SSH 桥**：ServersPage 增加 SSH 类型创建表单与隧道操作（复用 `desktop_ssh_*` IPC 面，不重复实现通道）；Add server 表单增加类型选择。—— **已交付**（2026-08-13）：ServersPage/ServersSidebar 显示 kind 徽标与 ssh 隧道 phase，提供 Connect/Disconnect/Retry；AddProjectDialog 服务器表单支持 URL/SSH 类型（SSH 仅桌面端，经 `useDesktopSshStore.createFromCommand` 建实例）；同时修复 `workspace-connection-adapter.mjs` 的 `status.status`→`phase` 判定 bug（此前 SSH 隧道解析恒 503）。
3. **生命周期合并**：删除联动——删除 catalog 连接（kind: ssh）同时停隧道并删除 ssh-manager 实例；连接状态与隧道状态（`useDesktopSshStore` 的 statusesById 按 `ssh:<instanceId>` 对应）在上层合并呈现；配对/设备管理从 `RemoteInstancesPage` 拆出为独立"设备"面。—— **已交付**（2026-08-13）：ServersPage 删除 ssh 连接后 best-effort 调用 `removeInstance`（先断隧道再删实例）；设备面抽为 `components/sections/devices/DevicesPage.tsx`（slug `devices`，搜索落点与导航已注册）。运行期 SSH 实例经 Electron 热注入闭环：server 暴露 `registerInjectedAdapter`/`unregisterInjectedAdapter`（handle 方法 `registerWorkspaceConnectionAdapter`/`unregisterWorkspaceConnectionAdapter`），Electron 在 `desktop_ssh_instances_set` 与启动时 diff 同步——实例创建后立即成为 catalog 连接（修复了旧启动快照注入的 shape bug，SSH 注入此前从未真正生效）；实例删除仅注销 adapter + 停观察，profile 与 projects 保留（用户数据保护），profile 删除路径的 sweep 现覆盖 ssh adapter，DELETE 后 observer 不再死重试。
4. **导航收尾**：`RemoteInstancesPage` 退役为设备管理页（slug 保留深链/anchors 兼容，`hiddenInNav` 已生效）；`ServersPage` 成为唯一连接入口。DesktopHostSwitcher 的 hosts 概念与 Relay 创建 UI 属 §4 剩余。—— **部分交付**（2026-08-13）：设备面已独立成页（`devices` 入导航）；SSH 实例管理面已从 `RemoteInstancesPage` 删除（2223→457 行），其 SSH 部分由 ServersPage 完整接管（含运行期热注入，见步骤 2/3）；旧页面现仅保留 direct hosts 管理面（DesktopHostSwitcher 无 hosts 增删改能力，不能删除），slug/hiddenInNav/搜索落点全部保留。其 direct hosts 面随 DesktopHostSwitcher 的 hosts 概念（§4 剩余）一并退役。

## 4. 未完成事项（退出门禁）

> 以下门禁记录保留自原 `unified-workspace-session-architecture.md`；状态按 2026-08-13 更新。

### 4.1 兼容层删除 — 全部关闭（2026-08-12，发布周期门禁经决策豁免）

1. ~~`projectId.ts` 删除~~ —— **已关闭**：模块已删除，三个导入者（`openchamberConfig.ts`、`persistence.ts`、`useProjectsStore.ts`）全部迁移，路径派生身份零引用。
2. ~~`useProjectsStore` legacy 双读 + VS Code folder bridge~~ —— **已关闭**：`legacyProjectMetadataByPath`/`legacyKey`/`syncVSCodeWorkspaceFolders` 全部移除，Catalog 为唯一权威；VS Code 经 descriptor bridge（`api:workspace:descriptor:get`，状态机 `available`/`no_folder`/`capability_unavailable`/`not_found`，非 available 态绝不合成 workspaceId）消费。
3. ~~`runtime-switch.ts` 核心导出 + sync-context ambient fallback~~ —— **已关闭**：模块删除，重安置为 `packages/ui/src/lib/control-plane.ts`（`setControlPlane`/`resetControlPlane`（key 保持 `'mobile-disconnected'`）/`getControlPlaneBaseUrl`/`getControlPlaneKey`/`subscribeControlPlane*`/`initializeControlPlane`，relay 隧道激活与 URL-token 路径行为字节一致）；`sync-context` 12 处 ambient fallback 全部移除，`scopeKey = projectHandle.scopeKey` 为唯一来源；`getControlPlaneKey` 仅剩控制面身份用途（主机匹配/`local`/`mobile-disconnected`/自动评审匹配/宿主缓存分区），无任何 ambient sync scope 回退（全文约 69 处非测试引用，性质均为控制面身份）。
4. ~~`runtimeEndpointReset.ts` + 全部 reset 动作~~ —— **已关闭**：模块删除；`resetForRuntimeSwitch`/`prepareForRuntimeSwitch`/`restoreForRuntimeSwitch` 从全部 8 个 store 移除（终端/文件标签/会话文件夹/Git/GitHub PR/文件搜索/项目/全局）；App.tsx 与 MobileApp.tsx 触发点改为窄控制面 bootstrap（catalog+session-index refresh + epoch，绝不清理 project 作用域 store）。
5. ~~`useGlobalSessionsStore` 退役~~ —— **已关闭**：store 与其测试删除，33 个消费者全部迁移（session-index summaries / 活动项目 handle SDK）；新增 `projects/session-summary.ts` 与 `lib/sessionDirectory.ts`；`ProjectSessionSummary` 增补 `parentID`/`createdAt`（含服务端 `session-index.js` 同步）；竞态不变量 3 项移植到 `session-index-store.test.ts`（含 `refresh()` 的 revision ≤ lastApplied 拒绝提交守卫）。
6. ~~旧分片数据与 legacy 存储双读删除~~ —— **已关闭**：persist-cache/session-prefetch-cache/viewport/session-deletion-cleanup/selection/session-ui-store/messageQueue/pinned/todos/草稿/工作树拓扑等 legacy key 双读与桶全部移除，仅剩 project scope 键读写；保留的有意兼容回退：`oc.chatInput.lastDraftTarget` 无作用域键仅作一次性提升迁移（读入当前 scope 后仍保留原键以支持降级，`session-ui-store.ts` `readPersistedDraftTarget`），selection-store 内存 legacy maps、工作树拓扑 ambient 桶与 session-activity-timing 裸键为文档化兼容读取（写入恒 scoped）。

### 4.2 环境与真实验收门禁

1. ~~**生产构建阻塞**~~ —— **已关闭**（2026-08-12）：根因是 node_modules 过期（5-26 安装后再未刷新），`bun install` 后 `packages/ui` 与 `packages/web` type-check 均为 **0 错误**，`build:ui` 与 `build:web` 通过（bun.lock 零改动，无新增依赖）；`MessageList.tsx`（tanstack 3.14.5 pinned API）与 `client.ts`（SDK Permission2）本身无代码漂移。唯一代码修复：`packages/ui/src/types/bun-test.d.ts` 补 `toBeUndefined()`。残留：`bun install` 的 postinstall 下载 Electron 二进制被网络阻塞（`--best-effort` 设计内不失败），electron 二进制缺失状态未变。
2. **性能实测**（§17.5）：构建已通过（见 4.2-1），仅剩 Chrome 环境阻塞。用 `scripts/perf` 实测会话点击 <100ms 反馈、空闲 CPU、后台刷新行为。当前状态：代码级修复已完成并有单元测试证据（见 4.4 证据表），但任何预算项不得仅凭代码审查视为实测通过。
3. **真机 wire 验收**（Phase 5 遗留）：Direct/Relay/SSH 真实服务器 + 设备上的 HTTP/SSE/WS（尤其移动端经 Relay tunnel 的 WebSocket）、URL token、重连与凭据不泄露验证。
4. **上线演练**（§20.5）：升级、降级、迁移中断、Catalog 损坏恢复、远端全部离线、Electron 隧道活跃时退出——代码级演练测试已覆盖 9 项（`phase6-rehearsal.test.js`），仍需真实环境复演。
5. **真实边界报告**：Direct、Relay、SSH、Electron packaged、VS Code、Mobile 分别报告成功路径与 capability unavailable。
6. ~~`GET /api/projects/capabilities` 与 diagnostics 未加入 ui-auth URL-token allowlist（与 `/api/projects` 同 pattern，cookie-less 面回落为启用）~~ —— **已关闭**（2026-08-12）：`/api/projects/capabilities` 与 `/api/projects/diagnostics` 已加入 `isUrlAuthReadableHttpPath`（HTTP URL-token allowlist），`ui-auth.test.js` 与 `DOCUMENTATION.md` 同步更新；WS allowlist 无需改动（project-prefixed runtime socket 已在 `isUrlAuthWebSocketPath` 与 tunnel-host `PROJECT_RUNTIME_WS_PATH_PATTERN` 覆盖）。

### 4.3 产品决策门禁

1. ~~17 处 `switchRuntimeEndpoint` 调用远期改造~~ —— **已关闭（经迁移解决）**：facade 删除后控制面重定向作为一等机制保留在 `lib/control-plane.ts`（`setControlPlane`/`resetControlPlane`），全部调用点（DesktopHostSwitcher、mobileConnections、MobileApp 断开、SessionAuthGate、desktopRelayRestore、RemoteInstancesPage revoke）已迁移，语义不变；不再存在"旧切换藏在按钮后"的问题。
2. ~~设置页"Remote Instances"重命名为"服务器/连接"（§13.4/§15.4）~~ —— **已关闭**（2026-08-12）：页面标题/侧栏标题改为"Servers"（zh-CN 服务器），`settings/metadata.ts` title 与关键词、`settings/search.ts` 关键词、全部 11 个 locale 的 `settings.page.remoteInstances.title` 与 `settings.remoteInstances.sidebar.title` 已更新；slug `remote-instances` 保留（深链/anchors 兼容，DesktopHostSwitcher 与 SettingsView 仍按该 slug 定位）。
3. **连接管理统一化**（§3，2026-08-13 立项）：`ServersPage` 与 `RemoteInstancesPage`（SSH 实例管理）合并为单一连接管理入口；设备配对拆为独立管理面；`RemoteInstancesPage` 退役（slug 保留）。—— **已关闭**（2026-08-13）：全部四步落地（见 §3），`RemoteInstancesPage` 仅剩 direct hosts 面。
4. **desktopHosts（DesktopHostSwitcher 的 hosts 概念）收编进 catalog** —— **决策：保持分离**（2026-08-13，经全仓研究论证）。理由（证据见研究结论）：① SSRF 门禁硬冲突——hosts 核心场景是 LAN/loopback 直连（如 `http://192.168.1.10:2606`），catalog direct 明确拒绝私有/loopback 地址，收编需开特权旁路，安全代价不可接受；② "baseUrl/凭据不下发 renderer"不变量与"desktop 必须持证直连"互斥，收编必须新增 local-only 凭据分发面；③ relay 消费模型相反（客户端 in-process 隧道需要描述符 vs 服务端代理永不下发）；④ hosts 是"窗口级运行时选择"（主进程在窗口创建前同步消费），catalog 是"数据面连接"（broker 代理 project 域），是两层而非两个平行面。残余 UI 重叠用命名收敛处理（"窗口目标" vs "服务器连接"）。`RemoteInstancesPage` 的 direct hosts 面随 hosts 概念共存亡；未来若统一，方向是"hosts 采用 catalog 式 profile 存储 + local-only runtime IPC"（存储层统一），而非"catalog 承担 hosts 职责"。

### 4.4 工程 DoD 未达成项

- [x] 设置页重命名与 settings search 关键词已更新（见 4.3-2，2026-08-12）。
- [x] type-check / build 已通过（2026-08-12）：`packages/ui`、`packages/web`、`packages/vscode` 均 0 错误，`build:ui`/`build:web`/vscode build 成功；lint 0 错误 0 警告。
- [ ] 真实边界报告（4.2-5）未交付——VS Code 侧已具备（descriptor + 控制面 HTTP/SSE 转发，WS 显式 501），Electron packaged/Direct/Relay/SSH/Mobile 需真实实例复验。
- [ ] 性能预算真实测量证据（4.2-2 阻塞）——当前代码级证据：

| §17.5 预算项 | 代码审查结论 |
|---|---|
| 每连接最多一个事件流，无每项目 polling | 通过：server `session-index.js` `ensureObserved`/`startObserver` 每连接单流（含 `observerStartInFlight` 合并、EOF 指数退避 1s→60s 上限）；renderer 侧只有一条 SSE 流（`session-index-client.ts`）。 |
| 单条 session event 的 reducer 工作量与受影响实体成正比，不扫描全部 10,000 项 | **通过**（单元测试证据）：server 每连接 `sessionsByUpstreamId` 活动索引（10,000 session 夹具：事件零迭代、恰 1 次索引查找 + 1 次 Map get/set、恰 1 个 upsert 事件 + 1 次 revision bump）；renderer `applyEvent` 用 `sessionIndex`（key→位置）Map，upsert O(1) 单元素替换/追加，remove O(1) + `slice`+`splice`，`findIndex`/`filter`/`map` 全部移除（5,000 session 计数代理：1 次 `slice`，扫描方法调用为 0）。 |
| 后台摘要刷新并发 ≤4 且带退避/jitter | **通过**（单元测试证据）：`refreshAll` worker 池默认并发 4（`refreshConcurrency` 可注入）；8 慢连接夹具峰值并发恰 4、队列排空、每连接恰 1 次刷新；6 连接含 1 失败夹具：失败方 `offline`+`ok:false`，其余全部 `complete`。重连退避加确定性 jitter（FNV-1a + mulberry32 按连接/流播种，±20% 均匀，钳制在既有 bounds：server 1s→60s，client 1s→30s，可见标签页 10s 上限）。 |
| 少量最近 ProjectRuntimeHandle 驻留，上限与淘汰可观测 | 通过（附注）：`project-runtime-registry.ts` `MAX_RETAINED_HANDLES=8`，超限扫描驱逐零 lease handle（5s `disposeGraceMs`），上限可注入且有驱逐测试；淘汰按插入序而非严格最近使用序。 |

实测状态（2026-08-12，本机环境）：生产构建已通过（见 4.2-1），`scripts/perf` 测量仍缺 Chrome/Chromium（electron 缓存因缺 libnspr4 无法启动，且 electron 下载被网络阻塞）；`profile:idle`/`profile:session`/`profile:animation` 均未产生数据。Chrome 就绪后必须复测。

### 4.5 上线前安全复核清单

- [ ] Catalog API 返回体没有 `clientToken`、headers、relay credential、SSH key/path 或真实内部凭据引用。
- [ ] 日志只记录 connectionId/projectId 和脱敏错误，不记录 URL query token 或用户敏感路径内容。
- [ ] upstream URL 只能由保存的 connectionId 解析，不能由请求参数覆盖。
- [ ] Direct adapter 阻止重定向到未登记 host，限制协议、端口和超时。
- [ ] project runtime proxy 具有 method/path allowlist 和 body/stream 限制。
- [ ] 目录浏览、文件、Git、终端和 session action 校验 project scope。
- [ ] WebSocket upgrade 与普通 HTTP 使用同一认证和授权决定。
- [ ] 远程 renderer 无法调用 desktop host 枚举秘密或全局 native IPC。
- [ ] 删除项目/连接前的目标解析精确，不使用宽泛路径或未解析变量。
- [ ] Relay/SSH 的 lease 在退出、崩溃恢复、最后消费者释放和认证失败时可清理。
