# 统一工作区与会话架构

> 状态：**已交付并提交**（2026-08-12；分支 `feat/multi-server-remote-open`，共 45 个提交领先 `main`；兼容层全量删除与收尾改动（URL-token allowlist、设置页重命名、VS Code descriptor、`toBeUndefined` matcher）均已提交，工作区干净）
> 基线日期：2026-08-10
> 适用范围：`packages/ui`、`packages/web`、`packages/electron`、`packages/vscode`、`packages/mobile`
> 核心目标：以一个本地 OpenChamber 控制面统一管理所有服务器上的工作区与会话；用户不再通过切换服务器来切换会话。
>
> 已交付内容（架构结论、模块索引、功能开关与诊断语义、架构不变量）已全量迁移至代码与各模块 `DOCUMENTATION.md`，本文件只保留**未完成事项（退出门禁）**。

## 1. 未完成事项（退出门禁）

### 1.1 兼容层删除 — 全部关闭（2026-08-12，发布周期门禁经决策豁免）

1. ~~`projectId.ts` 删除~~ —— **已关闭**：模块已删除，三个导入者（`openchamberConfig.ts`、`persistence.ts`、`useProjectsStore.ts`）全部迁移，路径派生身份零引用。
2. ~~`useProjectsStore` legacy 双读 + VS Code folder bridge~~ —— **已关闭**：`legacyProjectMetadataByPath`/`legacyKey`/`syncVSCodeWorkspaceFolders` 全部移除，Catalog 为唯一权威；VS Code 经 descriptor bridge（`api:workspace:descriptor:get`，状态机 `available`/`no_folder`/`capability_unavailable`/`not_found`，非 available 态绝不合成 workspaceId）消费。
3. ~~`runtime-switch.ts` 核心导出 + sync-context ambient fallback~~ —— **已关闭**：模块删除，重安置为 `packages/ui/src/lib/control-plane.ts`（`setControlPlane`/`resetControlPlane`（key 保持 `'mobile-disconnected'`）/`getControlPlaneBaseUrl`/`getControlPlaneKey`/`subscribeControlPlane*`/`initializeControlPlane`，relay 隧道激活与 URL-token 路径行为字节一致）；`sync-context` 12 处 ambient fallback 全部移除，`scopeKey = workspaceHandle.scopeKey` 为唯一来源；`getControlPlaneKey` 仅剩控制面身份用途（主机匹配/`local`/`mobile-disconnected`/自动评审匹配/宿主缓存分区），无任何 ambient sync scope 回退（全文约 69 处非测试引用，性质均为控制面身份）。
4. ~~`runtimeEndpointReset.ts` + 全部 reset 动作~~ —— **已关闭**：模块删除；`resetForRuntimeSwitch`/`prepareForRuntimeSwitch`/`restoreForRuntimeSwitch` 从全部 8 个 store 移除（终端/文件标签/会话文件夹/Git/GitHub PR/文件搜索/项目/全局）；App.tsx 与 MobileApp.tsx 触发点改为窄控制面 bootstrap（catalog+session-index refresh + epoch，绝不清理 workspace 作用域 store）。
5. ~~`useGlobalSessionsStore` 退役~~ —— **已关闭**：store 与其测试删除，33 个消费者全部迁移（session-index summaries / 活动工作区 handle SDK）；新增 `workspaces/session-summary.ts` 与 `lib/sessionDirectory.ts`；`WorkspaceSessionSummary` 增补 `parentID`/`createdAt`（含服务端 `session-index.js` 同步）；竞态不变量 3 项移植到 `session-index-store.test.ts`（含 `refresh()` 的 revision ≤ lastApplied 拒绝提交守卫）。
6. ~~旧分片数据与 legacy 存储双读删除~~ —— **已关闭**：persist-cache/session-prefetch-cache/viewport/session-deletion-cleanup/selection/session-ui-store/messageQueue/pinned/todos/草稿/工作树拓扑等 legacy key 双读与桶全部移除，仅剩 workspace scope 键读写；保留的有意兼容回退：`oc.chatInput.lastDraftTarget` 无作用域键仅作一次性提升迁移（读入当前 scope 后仍保留原键以支持降级，`session-ui-store.ts` `readPersistedDraftTarget`），selection-store 内存 legacy maps、工作树拓扑 ambient 桶与 session-activity-timing 裸键为文档化兼容读取（写入恒 scoped）。

### 1.2 环境与真实验收门禁

1. ~~**生产构建阻塞**~~ —— **已关闭**（2026-08-12）：根因是 node_modules 过期（5-26 安装后再未刷新），`bun install` 后 `packages/ui` 与 `packages/web` type-check 均为 **0 错误**，`build:ui` 与 `build:web` 通过（bun.lock 零改动，无新增依赖）；`MessageList.tsx`（tanstack 3.14.5 pinned API）与 `client.ts`（SDK Permission2）本身无代码漂移。唯一代码修复：`packages/ui/src/types/bun-test.d.ts` 补 `toBeUndefined()`。残留：`bun install` 的 postinstall 下载 Electron 二进制被网络阻塞（`--best-effort` 设计内不失败），electron 二进制缺失状态未变。
2. **性能实测**（§17.5）：构建已通过（见 1.2-1），仅剩 Chrome 环境阻塞。用 `scripts/perf` 实测会话点击 <100ms 反馈、空闲 CPU、后台刷新行为。当前状态：代码级修复已完成并有单元测试证据（见 1.4 证据表），但任何预算项不得仅凭代码审查视为实测通过。
3. **真机 wire 验收**（Phase 5 遗留）：Direct/Relay/SSH 真实服务器 + 设备上的 HTTP/SSE/WS（尤其移动端经 Relay tunnel 的 WebSocket）、URL token、重连与凭据不泄露验证。
4. **上线演练**（§20.5）：升级、降级、迁移中断、Catalog 损坏恢复、远端全部离线、Electron 隧道活跃时退出——代码级演练测试已覆盖 9 项（`phase6-rehearsal.test.js`），仍需真实环境复演。
5. **真实边界报告**：Direct、Relay、SSH、Electron packaged、VS Code、Mobile 分别报告成功路径与 capability unavailable。
6. ~~`GET /api/workspaces/capabilities` 与 diagnostics 未加入 ui-auth URL-token allowlist（与 `/api/workspaces` 同 pattern，cookie-less 面回落为启用）~~ —— **已关闭**（2026-08-12）：`/api/workspaces/capabilities` 与 `/api/workspaces/diagnostics` 已加入 `isUrlAuthReadableHttpPath`（HTTP URL-token allowlist），`ui-auth.test.js` 与 `DOCUMENTATION.md` 同步更新；WS allowlist 无需改动（workspace-prefixed runtime socket 已在 `isUrlAuthWebSocketPath` 与 tunnel-host `WORKSPACE_RUNTIME_WS_PATH_PATTERN` 覆盖）。

### 1.3 产品决策门禁

1. ~~17 处 `switchRuntimeEndpoint` 调用远期改造~~ —— **已关闭（经迁移解决）**：facade 删除后控制面重定向作为一等机制保留在 `lib/control-plane.ts`（`setControlPlane`/`resetControlPlane`），全部调用点（DesktopHostSwitcher、mobileConnections、MobileApp 断开、SessionAuthGate、desktopRelayRestore、RemoteInstancesPage revoke）已迁移，语义不变；不再存在"旧切换藏在按钮后"的问题。
2. ~~设置页"Remote Instances"重命名为"服务器/连接"（§13.4/§15.4）~~ —— **已关闭**（2026-08-12）：页面标题/侧栏标题改为"Servers"（zh-CN 服务器），`settings/metadata.ts` title 与关键词、`settings/search.ts` 关键词、全部 11 个 locale 的 `settings.page.remoteInstances.title` 与 `settings.remoteInstances.sidebar.title` 已更新；slug `remote-instances` 保留（深链/anchors 兼容，DesktopHostSwitcher 与 SettingsView 仍按该 slug 定位）。

### 1.4 工程 DoD 未达成项

- [x] 设置页重命名与 settings search 关键词已更新（见 1.3-2，2026-08-12）。
- [x] type-check / build 已通过（2026-08-12）：`packages/ui`、`packages/web`、`packages/vscode` 均 0 错误，`build:ui`/`build:web`/vscode build 成功；lint 0 错误 0 警告。
- [ ] 真实边界报告（1.2-5）未交付——VS Code 侧已具备（descriptor + 控制面 HTTP/SSE 转发，WS 显式 501），Electron packaged/Direct/Relay/SSH/Mobile 需真实实例复验。
- [ ] 性能预算真实测量证据（1.2-2 阻塞）——当前代码级证据：

| §17.5 预算项 | 代码审查结论 |
|---|---|
| 每连接最多一个事件流，无每工作区 polling | 通过：server `session-index.js` `ensureObserved`/`startObserver` 每连接单流（含 `observerStartInFlight` 合并、EOF 指数退避 1s→60s 上限）；renderer 侧只有一条 SSE 流（`session-index-client.ts`）。 |
| 单条 session event 的 reducer 工作量与受影响实体成正比，不扫描全部 10,000 项 | **通过**（单元测试证据）：server 每连接 `sessionsByUpstreamId` 活动索引（10,000 session 夹具：事件零迭代、恰 1 次索引查找 + 1 次 Map get/set、恰 1 个 upsert 事件 + 1 次 revision bump）；renderer `applyEvent` 用 `sessionIndex`（key→位置）Map，upsert O(1) 单元素替换/追加，remove O(1) + `slice`+`splice`，`findIndex`/`filter`/`map` 全部移除（5,000 session 计数代理：1 次 `slice`，扫描方法调用为 0）。 |
| 后台摘要刷新并发 ≤4 且带退避/jitter | **通过**（单元测试证据）：`refreshAll` worker 池默认并发 4（`refreshConcurrency` 可注入）；8 慢连接夹具峰值并发恰 4、队列排空、每连接恰 1 次刷新；6 连接含 1 失败夹具：失败方 `offline`+`ok:false`，其余全部 `complete`。重连退避加确定性 jitter（FNV-1a + mulberry32 按连接/流播种，±20% 均匀，钳制在既有 bounds：server 1s→60s，client 1s→30s，可见标签页 10s 上限）。 |
| 少量最近 WorkspaceRuntimeHandle 驻留，上限与淘汰可观测 | 通过（附注）：`workspace-runtime-registry.ts` `MAX_RETAINED_HANDLES=8`，超限扫描驱逐零 lease handle（5s `disposeGraceMs`），上限可注入且有驱逐测试；淘汰按插入序而非严格最近使用序。 |

实测状态（2026-08-12，本机环境）：生产构建已通过（见 1.2-1），`scripts/perf` 测量仍缺 Chrome/Chromium（electron 缓存因缺 libnspr4 无法启动，且 electron 下载被网络阻塞）；`profile:idle`/`profile:session`/`profile:animation` 均未产生数据。Chrome 就绪后必须复测。

### 1.5 上线前安全复核清单

- [ ] Catalog API 返回体没有 `clientToken`、headers、relay credential、SSH key/path 或真实内部凭据引用。
- [ ] 日志只记录 connectionId/workspaceId 和脱敏错误，不记录 URL query token 或用户敏感路径内容。
- [ ] upstream URL 只能由保存的 connectionId 解析，不能由请求参数覆盖。
- [ ] Direct adapter 阻止重定向到未登记 host，限制协议、端口和超时。
- [ ] workspace runtime proxy 具有 method/path allowlist 和 body/stream 限制。
- [ ] 目录浏览、文件、Git、终端和 session action 校验 workspace scope。
- [ ] WebSocket upgrade 与普通 HTTP 使用同一认证和授权决定。
- [ ] 远程 renderer 无法调用 desktop host 枚举秘密或全局 native IPC。
- [ ] 删除工作区/连接前的目标解析精确，不使用宽泛路径或未解析变量。
- [ ] Relay/SSH 的 lease 在退出、崩溃恢复、最后消费者释放和认证失败时可清理。

