# Claude Code Viewer 项目分析

## 一、项目概述

Claude Code Viewer 是一个用于查看和管理 Claude Code 会话日志的 Web 应用。它直接从 JSONL 文件（`~/.claude/projects/`）读取会话数据，提供零数据丢失的会话查看体验。

## 二、项目架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ TanStack     │  │ TanStack     │  │ Jotai            │  │
│  │ Router       │  │ Query        │  │ (State Mgmt)     │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                           │                                  │
│                    Hono RPC Client                           │
└─────────────────────────────────────────────────────────────┘
                            │
                    HTTP / SSE / WebSocket
                            │
┌─────────────────────────────────────────────────────────────┐
│                        Backend                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Hono         │  │ Effect-TS    │  │ EventBus         │  │
│  │ (Web Server) │──│ (Services)   │──│ (Event System)   │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                           │                                  │
│                    Claude Code SDK                           │
└─────────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────────┐
│                     Data Layer                               │
│  ~/.claude/projects/*.jsonl  │  ~/.claude-code-viewer/cache │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 前端架构

#### 技术栈
- **框架**: React 19 + Vite
- **路由**: TanStack Router（文件系统路由）
- **数据获取**: TanStack Query（useSuspenseQuery, useMutation）
- **状态管理**: Jotai（原子化状态）
- **国际化**: Lingui
- **样式**: Tailwind CSS + shadcn/ui

#### 路由结构
```
src/routes/
├── __root.tsx           # 根路由，提供全局 Provider
├── index.tsx            # / - 首页
├── login.tsx            # /login - 登录页
└── projects/
    ├── index.tsx        # /projects - 项目列表
    └── $projectId/
        └── session.tsx  # /projects/:projectId/session - 会话详情
```

#### 关键组件
| 组件 | 路径 | 功能 |
|------|------|------|
| `SyncSessionProcess` | `src/app/components/SyncSessionProcess.tsx` | 同步会话进程状态到 Jotai |
| `PermissionDialog` | `src/components/PermissionDialog.tsx` | 权限请求对话框 |
| `SessionPageMain` | `src/app/projects/.../components/SessionPageMain.tsx` | 会话主页面 |
| `ChatActionMenu` | `src/app/projects/.../components/resumeChat/ChatActionMenu.tsx` | 聊天操作菜单（含终止按钮）|

### 2.3 后端架构

#### 技术栈
- **Web 框架**: Hono
- **函数式编程**: Effect-TS
- **数据验证**: Zod
- **CLI 交互**: @anthropic-ai/claude-agent-sdk

#### 核心服务模块 (`src/server/core/`)
```
src/server/core/
├── claude-code/       # Claude Code 集成
│   ├── models/        # 数据模型（CCSessionProcess, ClaudeCode）
│   └── services/      # 业务服务
│       ├── ClaudeCodeLifeCycleService.ts  # 生命周期管理（启动、终止）
│       ├── ClaudeCodeSessionProcessService.ts  # 会话进程状态机
│       └── ClaudeCodePermissionService.ts  # 权限处理
├── events/            # 事件系统
│   ├── services/EventBus.ts  # 内部事件总线
│   └── presentation/SSEController.ts  # SSE 推送控制器
├── session/           # 会话管理
├── project/           # 项目管理
├── git/              # Git 操作
├── terminal/         # 终端服务
└── platform/         # 平台配置
```

#### API 路由 (`src/server/hono/routes/`)
| 路由 | 方法 | 功能 |
|------|------|------|
| `/api/claude-code/session-processes` | GET | 获取所有会话进程 |
| `/api/claude-code/session-processes` | POST | 创建新会话进程 |
| `/api/claude-code/session-processes/:id/continue` | POST | 继续暂停的会话 |
| `/api/claude-code/session-processes/:id/abort` | POST | **终止会话进程** |
| `/api/claude-code/permission-response` | POST | 响应权限请求 |
| `/api/sse` | GET | SSE 事件流 |

## 三、功能实现流程

### 3.1 会话管理流程

#### 创建新会话
```
┌──────────┐    POST /session-processes    ┌──────────────┐
│ Frontend │ ─────────────────────────────>│ Backend      │
│          │                               │              │
│          │    1. 创建 AbortController     │              │
│          │    2. 初始化 SessionProcess    │              │
│          │    3. 调用 Claude Code SDK     │              │
│          │                               │              │
│          │<─────── SSE 事件推送 ──────────│              │
│          │   sessionProcessChanged       │              │
└──────────┘                               └──────────────┘
```

#### 会话进程状态机
```
          ┌─────────────────────────────────────────────┐
          │                                             │
          ▼                                             │
     ┌─────────┐                                        │
     │ pending │  消息待解析                             │
     └────┬────┘                                        │
          │ 消息解析完成                                 │
          ▼                                             │
  ┌───────────────────┐                                 │
  │ not_initialized   │  等待 init 消息                 │
  └────────┬──────────┘                                 │
           │ 收到 init 消息                             │
           ▼                                            │
    ┌─────────────┐                                     │
    │ initialized │  已初始化，分配 sessionId           │
    └──────┬──────┘                                     │
           │ 会话文件创建                               │
           ▼                                            │
   ┌──────────────┐                                     │
   │ file_created │  文件已创建                         │
   └──────┬───────┘                                     │
          │                                             │
    ┌─────┴─────┐                                       │
    │           │                                       │
    ▼           ▼                                       │
┌────────┐  ┌───────────┐                              │
│ paused │  │ completed │──────────────────────────────┘
│ (暂停) │  │ (完成/终止)│
└────────┘  └───────────┘
     │            ▲
     │  continue  │ abort
     └────────────┘
```

### 3.2 实时更新机制 (SSE)

#### SSE 事件类型 (`src/types/sse.ts`)
```typescript
type SSEEventDeclaration = {
  connect: {};                           // 连接成功
  heartbeat: {};                         // 心跳
  sessionListChanged: { projectId };     // 会话列表变化
  sessionChanged: { projectId, sessionId };  // 单个会话变化
  sessionProcessChanged: { processes };  // 会话进程状态变化
  permissionRequested: { permissionRequest }; // 权限请求
  virtualConversationUpdated: {...};     // 虚拟会话更新
}
```

#### SSE 事件流
```
Backend Service ──> EventBus ──> SSEController ──> HTTP SSE Stream
                                                        │
Frontend EventSource <───────────────────────────────────
        │
        ▼
useServerEventListener Hook ──> React Component State Update
```

## 四、终止（Abort）功能详解

### 4.1 功能概述

终止功能允许用户中断正在运行的 Claude Code 会话。实现基于 JavaScript 的 `AbortController` 机制，从前端 UI 到后端服务层实现完整的信号传播。

### 4.2 实现流程

#### 第一步：前端触发终止

**文件**: `src/app/projects/[projectId]/sessions/[sessionId]/components/SessionPageMain.tsx`

```typescript
// L197-L212: 定义 abort mutation
const abortTask = useMutation({
  mutationFn: async (sessionProcessId: string) => {
    const response = await honoClient.api["claude-code"]["session-processes"][
      ":sessionProcessId"
    ].abort.$post({
      param: { sessionProcessId },
      json: { projectId },
    });
    
    if (!response.ok) {
      throw new Error(response.statusText);
    }
    return response.json();
  },
});
```

**文件**: `src/app/projects/.../components/resumeChat/ChatActionMenu.tsx`

```typescript
// L109-L129: Abort 按钮 UI
{sessionProcess && abortTask && (
  <Button
    type="button"
    variant="destructive"
    size="sm"
    onClick={() => {
      abortTask.mutate(sessionProcess.id);  // 触发终止
    }}
    disabled={abortTask.isPending || isPending}
  >
    {abortTask.isPending ? (
      <LoaderIcon className="animate-spin" />
    ) : (
      <XIcon />
    )}
    <Trans id="session.conversation.abort" />
  </Button>
)}
```

#### 第二步：后端 API 处理

**文件**: `src/server/hono/routes/claudeCodeRoutes.ts`

```typescript
// L137-L147: Abort 路由处理
.post(
  "/session-processes/:sessionProcessId/abort",
  zValidator("json", z.object({ projectId: z.string() })),
  async (c) => {
    const { sessionProcessId } = c.req.param();
    // 异步执行，立即返回响应
    void Effect.runFork(
      claudeCodeLifeCycleService.abortTask(sessionProcessId),
    );
    return c.json({ message: "Task aborted" });
  },
)
```

#### 第三步：服务层实现终止

**文件**: `src/server/core/claude-code/services/ClaudeCodeLifeCycleService.ts`

```typescript
// L433-L444: abortTask 核心实现
const abortTask = (sessionProcessId: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    // 1. 获取当前会话进程
    const currentProcess =
      yield* sessionProcessService.getSessionProcess(sessionProcessId);

    // 2. 触发 AbortController，发送终止信号
    currentProcess.def.abortController.abort();

    // 3. 将会话进程状态转换为 completed
    yield* sessionProcessService.toCompletedState({
      sessionProcessId: currentProcess.def.sessionProcessId,
      error: new Error("Task aborted"),
    });
  });
```

#### 第四步：AbortController 信号检查

**文件**: `src/server/core/claude-code/services/ClaudeCodeLifeCycleService.ts`

```typescript
// L176-L189: 消息处理时检查终止信号
const handleMessage = (message: SDKMessage) =>
  Effect.gen(function* () {
    const processState = yield* sessionProcessService.getSessionProcess(
      sessionProcess.def.sessionProcessId,
    );

    // 检查 abort 信号
    if (sessionProcess.def.abortController.signal.aborted) {
      return "break" as const;  // 退出消息处理循环
    }

    if (processState.type === "completed") {
      return "break" as const;
    }
    // ... 继续处理消息
  });
```

#### 第五步：AbortController 传递给 Claude Code SDK

**文件**: `src/server/core/claude-code/services/ClaudeCodeLifeCycleService.ts`

```typescript
// L316-L322: 将 AbortController 传递给 SDK
return yield* ClaudeCode.query(generateMessages(), {
  ...permissionOptions,
  resume: task.def.baseSessionId,
  cwd: sessionProcess.def.cwd,
  abortController: sessionProcess.def.abortController,  // 传递终止控制器
});
```

#### 第六步：状态变更广播

**文件**: `src/server/core/claude-code/services/ClaudeCodeSessionProcessService.ts`

```typescript
// L203-L215: 状态变更时发送 SSE 事件
if (currentStatus !== nextState.type) {
  yield* eventBus.emit("sessionProcessChanged", {
    processes: updatedProcesses
      .filter(CCSessionProcess.isPublic)
      .map((process) => ({
        id: process.def.sessionProcessId,
        projectId: process.def.projectId,
        sessionId: process.sessionId,
        status: process.type === "paused" ? "paused" : "running",
      })),
    changed: nextState,
  });
}
```

#### 第七步：前端接收状态更新

**文件**: `src/app/components/SyncSessionProcess.tsx`

```typescript
// L15-L17: 监听 SSE 事件更新状态
useServerEventListener("sessionProcessChanged", async ({ processes }) => {
  setSessionProcesses(processes);  // 更新 Jotai 原子状态
});
```

### 4.3 终止流程时序图

```
┌────────────┐      ┌────────────┐      ┌─────────────────┐      ┌───────────┐      ┌────────────┐
│  用户点击   │      │  Hono API  │      │ LifeCycleService│      │ EventBus  │      │ SSE Client │
│  Abort按钮 │      │   路由     │      │                 │      │           │      │            │
└─────┬──────┘      └─────┬──────┘      └────────┬────────┘      └─────┬─────┘      └─────┬──────┘
      │                   │                      │                     │                  │
      │ POST /abort       │                      │                     │                  │
      │──────────────────>│                      │                     │                  │
      │                   │                      │                     │                  │
      │                   │ abortTask()          │                     │                  │
      │                   │─────────────────────>│                     │                  │
      │                   │                      │                     │                  │
      │ 200 OK            │                      │ abortController     │                  │
      │<──────────────────│                      │ .abort()            │                  │
      │                   │                      │                     │                  │
      │                   │                      │ toCompletedState()  │                  │
      │                   │                      │─────────┐           │                  │
      │                   │                      │         │           │                  │
      │                   │                      │<────────┘           │                  │
      │                   │                      │                     │                  │
      │                   │                      │ emit("sessionProcess│                  │
      │                   │                      │ Changed")           │                  │
      │                   │                      │────────────────────>│                  │
      │                   │                      │                     │                  │
      │                   │                      │                     │ SSE: session     │
      │                   │                      │                     │ ProcessChanged   │
      │                   │                      │                     │─────────────────>│
      │                   │                      │                     │                  │
      │                   │                      │                     │                  │ UI 更新
      │                   │                      │                     │                  │ (状态变为
      │                   │                      │                     │                  │  completed)
```

## 五、暂停（Paused）功能详解

### 5.1 功能概述

暂停是会话进程的一种自然状态，当 Claude Code 完成一轮对话（返回 result 消息）后，会话自动进入暂停状态，等待用户输入下一条消息。

### 5.2 自动暂停实现

**文件**: `src/server/core/claude-code/services/ClaudeCodeLifeCycleService.ts`

```typescript
// L284-L301: 收到 result 消息时自动暂停
if (message.type === "result") {
  if (
    processState.type === "file_created" ||
    processState.type === "initialized"
  ) {
    // 转换为 paused 状态
    yield* sessionProcessService.toPausedState({
      sessionProcessId: processState.def.sessionProcessId,
      resultMessage: message,
    });

    // 触发会话变更事件
    yield* eventBusService.emit("sessionChanged", {
      projectId: processState.def.projectId,
      sessionId: message.session_id,
    });
  }
  return "continue" as const;
}
```

### 5.3 暂停状态转换

**文件**: `src/server/core/claude-code/services/ClaudeCodeSessionProcessService.ts`

```typescript
// L372-L418: toPausedState 实现
const toPausedState = (options: {
  sessionProcessId: string;
  resultMessage: SDKResultMessage;
}) => {
  const { sessionProcessId, resultMessage } = options;

  return Effect.gen(function* () {
    const currentProcess = yield* getSessionProcess(sessionProcessId);
    
    // 只有 file_created 或 initialized 状态才能转为 paused
    if (
      currentProcess.type !== "file_created" &&
      currentProcess.type !== "initialized"
    ) {
      return yield* Effect.fail(
        new IllegalStateChangeError({
          from: currentProcess.type,
          to: "paused",
        }),
      );
    }

    // 更新任务状态为 completed
    const newTask = yield* changeTurnState({
      sessionProcessId,
      turnId: currentProcess.currentTask.def.turnId,
      nextTask: {
        status: "completed",
        def: currentProcess.currentTask.def,
        sessionId: resultMessage.session_id,
      },
    });

    // 转换进程状态为 paused
    const newProcess = yield* dangerouslyChangeProcessState({
      sessionProcessId,
      nextState: {
        type: "paused",
        def: currentProcess.def,
        tasks: currentProcess.tasks.map((t) =>
          t.def.turnId === newTask.def.turnId ? newTask : t,
        ),
        sessionId: currentProcess.sessionId,
      },
    });

    return { sessionProcess: newProcess };
  });
};
```

### 5.4 继续暂停的会话（Continue）

**文件**: `src/server/hono/routes/claudeCodeRoutes.ts`

```typescript
// L111-L136: Continue 路由
.post(
  "/session-processes/:sessionProcessId/continue",
  zValidator(
    "json",
    z.object({
      projectId: z.string(),
      input: userMessageInputSchema,
      baseSessionId: z.string(),
    }),
  ),
  async (c) => {
    const body = c.req.valid("json");
    const input = normalizeUserMessageInput(body.input);
    const response = await effectToResponse(
      c,
      claudeCodeSessionProcessController
        .continueSessionProcess({
          ...c.req.param(),
          ...body,
          input,
        })
        .pipe(Effect.provide(runtime)),
    );
    return response;
  },
)
```

### 5.5 前端状态显示

**文件**: `src/app/projects/[projectId]/sessions/[sessionId]/components/SessionPageMain.tsx`

```typescript
// L166-L176: 获取会话进程状态
const sessionProcess = useSessionProcess();
const relatedSessionProcess = useMemo(() => {
  if (!sessionId) return undefined;
  return sessionProcess.getSessionProcess(sessionId);
}, [sessionProcess, sessionId]);

// 计算有效状态（考虑本地命令输出）
const effectiveSessionStatus =
  relatedSessionProcess?.status === "running" && hasLocalCommandOutput
    ? "paused"
    : relatedSessionProcess?.status;

// 获取状态徽章属性
const statusBadge = getSessionStatusBadgeProps(effectiveSessionStatus);
```

### 5.6 暂停与继续流程图

```
┌───────────────────────────────────────────────────────────────────────┐
│                         正常会话流程                                   │
│                                                                       │
│  ┌──────────┐  用户输入  ┌───────────┐  SDK处理  ┌──────────────────┐ │
│  │  paused  │ ─────────> │  running  │ ────────> │  收到 result 消息│ │
│  │ (已暂停) │            │ (运行中)  │           │                  │ │
│  └──────────┘            └───────────┘           └────────┬─────────┘ │
│       ▲                                                   │           │
│       │                                                   │           │
│       │              自动转为 paused                      │           │
│       └───────────────────────────────────────────────────┘           │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────┐
│                         终止会话流程                                   │
│                                                                       │
│  ┌──────────┐  用户点击  ┌───────────┐  abort()  ┌──────────────────┐ │
│  │  running │ ─────────> │  abortTask│ ────────> │    completed     │ │
│  │ (运行中) │   Abort    │  被调用   │           │    (已终止)      │ │
│  └──────────┘            └───────────┘           └──────────────────┘ │
│                                                                       │
│  注意: completed 状态不可恢复，会话进程结束                           │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

## 六、权限请求机制

### 6.1 权限请求流程

当 Claude Code 执行需要权限的工具时（如文件操作、命令执行），会触发权限请求：

```
Claude Code SDK ──> 权限检查 ──> EventBus("permissionRequested")
                                        │
                                        ▼
              SSE 推送 ──> Frontend usePermissionRequests Hook
                                        │
                                        ▼
                           PermissionDialog 显示
                                        │
                          用户点击 Allow/Deny
                                        │
                                        ▼
              POST /permission-response ──> 后端处理 ──> 继续/拒绝执行
```

### 6.2 前端权限处理

**文件**: `src/hooks/usePermissionRequests.ts`

```typescript
export const usePermissionRequests = () => {
  const [currentPermissionRequest, setCurrentPermissionRequest] =
    useState<PermissionRequest | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  // 监听权限请求 SSE 事件
  useServerEventListener("permissionRequested", (data) => {
    if (data.permissionRequest) {
      setCurrentPermissionRequest(data.permissionRequest);
      setIsDialogOpen(true);
    }
  });

  // 处理用户响应
  const handlePermissionResponse = useCallback(
    async (response: PermissionResponse) => {
      const apiResponse = await honoClient.api["claude-code"][
        "permission-response"
      ].$post({
        json: response,
      });
      
      setIsDialogOpen(false);
      setCurrentPermissionRequest(null);
    },
    [],
  );

  return {
    currentPermissionRequest,
    isDialogOpen,
    onPermissionResponse: handlePermissionResponse,
  };
};
```

## 七、与 Claude Code SDK 的集成

### 7.1 SDK 调用入口

**文件**: `src/server/core/claude-code/models/ClaudeCode.ts`

```typescript
import * as agentSdk from "@anthropic-ai/claude-agent-sdk";

export const query = (
  prompt: AgentSdkPrompt,
  options: AgentSdkQueryOptions,
) => {
  return Effect.gen(function* () {
    const { claudeCodeExecutablePath, claudeCodeVersion } = yield* Config;
    
    // 检查版本兼容性
    const availableFeatures = getAvailableFeatures(claudeCodeVersion);
    
    if (!availableFeatures.agentSdk) {
      return yield* new ClaudeCodeAgentSdkNotSupportedError({...});
    }

    // 调用 Claude Code Agent SDK
    return agentSdk.query({
      prompt,
      options: {
        settingSources: ["user", "project", "local"],
        pathToClaudeCodeExecutable: claudeCodeExecutablePath,
        disallowedTools: ["AskUserQuestion", ...],  // 禁用 CLI 交互工具
        ...options,
      },
    });
  });
};
```

### 7.2 会话进程数据模型

**文件**: `src/server/core/claude-code/models/CCSessionProcess.ts`

```typescript
// 会话进程定义（包含 AbortController）
export type CCSessionProcessDef = {
  sessionProcessId: string;
  projectId: string;
  cwd: string;
  abortController: AbortController;  // 关键: 终止控制器
  setNextMessage: (input: UserMessageInput) => void;
};

// 会话进程状态类型
export type CCSessionProcessState =
  | CCSessionProcessPendingState      // pending: 消息待解析
  | CCSessionProcessNotInitializedState  // not_initialized: 等待 init
  | CCSessionProcessInitializedState  // initialized: 已初始化
  | CCSessionProcessFileCreatedState  // file_created: 文件已创建
  | CCSessionProcessPausedState       // paused: 已暂停，可继续
  | CCSessionProcessCompletedState;   // completed: 已完成/终止
```

## 八、总结

### 关键设计模式

1. **AbortController 模式**: 使用 JavaScript 原生的 AbortController 实现跨层级的终止信号传播
2. **状态机模式**: 会话进程使用清晰的状态机管理生命周期
3. **事件驱动**: 使用 EventBus + SSE 实现后端到前端的实时状态同步
4. **Effect-TS**: 后端使用函数式编程，提供可组合、可测试的业务逻辑

### 终止与暂停的区别

| 特性 | 终止 (Abort) | 暂停 (Paused) |
|------|-------------|--------------|
| 触发方式 | 用户手动点击 | 自动（收到 result 消息） |
| 最终状态 | completed | paused |
| 是否可恢复 | 否 | 是（通过 continue） |
| AbortController | 调用 abort() | 保持不变 |
| 错误信息 | "Task aborted" | 无 |
