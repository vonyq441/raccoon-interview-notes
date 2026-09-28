# 多机器人中央调度平台 V2：校招自学与项目面试手册

> **定位**：围绕简历内容编写的 V2 目标实施方案。它说明系统应该怎样实现、为什么这样设计，以及面试时怎样讲清楚；不代表下文所有 V2 能力都已在原项目上线。
>
> **项目边界**：2 台机器人、单展厅、模块化单体、PostgreSQL、Spring Boot、Spring AI。bot_mind 与 g1_base 是已有机器人侧代码；本文重点设计 Java 中央平台和智能体，并解释它们如何接入机器人。

## 0. 阅读指南

### 0.1 项目一句话介绍

接待员创建参观任务，中央规划 Agent 建议机器人和路线；工作人员审核后，Java 选择当前 PlanStep 并构造 ExecutionContext，由动作 Agent 直接调用 bot_mind 的导航、讲解和动作 Tools。同步完成的 Tool Result 可以直接回到当前 Agent Tool Calling 循环继续推理；对于长耗时异步操作，Java 根据后续 RobotEvent 更新 Command，并在需要继续当前 Step 时重新构造 ExecutionContext 唤醒动作 Agent。

系统边界可以先记成三句话：

1. **模型受控调用能力**：LLM/Agent 可以通过白名单 bot_mind Tool Calling 发起机器人能力调用，但不能绕过 Tool 门禁直接访问 ROS2、Unitree SDK、Shell 或任意机器人接口；Task、Step 等业务状态仍由 Java 修改。
2. **Java 保存事实并作决定**，负责校验、事务、权限、幂等和状态推进。
3. **机器人执行并回报结果**，路径规划和硬件安全留在机器人侧。

### 0.2 简历职责映射

| 简历内容 | 对应部分 | 掌握要求 |
|---|---|---|
| Spring Boot 多机器人中央调度平台 | 第一部分 | 能完整讲出 Task 执行链 |
| 状态跟踪、命令去重、超时重试、人工接管 | 第一部分 | 能解释异常恢复 |
| 中央规划 Agent、结构化输出、工具调用 | 第二部分 | 能画出规划与校验链 |
| G1 动作编排与执行 | 第三部分 | 能说明机器人实际如何执行 |
| QA Agent、RAG、工具调用、多轮上下文 | 第四部分 | 能说明 Spring AI 编排边界 |
| 意图识别、自然语言机器人控制 | 第四部分 | 理解路由、技能选择和安全门禁 |
| 认证、安全、部署与扩展调度 | 附录 | 面试追问时查阅 |

### 0.3 推荐学习顺序

建议按下面顺序阅读，而不是按技术名词逐个背诵：

~~~text
中央调度平台基础
→ 中央规划 Agent
→ 命令可靠执行
→ G1 机器人执行
→ QA Agent
→ Intent / 动作 Agent（Robot Control Agent）
~~~

第一次阅读先完成第一至第四部分的业务主线，再看第五部分面试题。认证、设备安全、部署、完整数据库和高级扩展放到第二遍查阅。

### 0.4 项目完整主流程

~~~text
创建 Task
↓ Planning Agent
↓ PlanDraft
↓ Java Validator
↓ 人工审核
↓ 下发并原子绑定 Robot
↓ Java TaskExecutionService 选中当前 PlanStep
↓ 构造 ExecutionContext
↓ 动作 Agent
↓ tool_call：目标机器人 bot_mind Tool
↓ Java ToolCallback 伴随记录 RobotCommand
↓ MCP tools/call → bot_mind
↓
├─ 同步最终 Tool Result
│  ↓ Java 更新 RobotCommand
│  Result 回到当前 Agent Tool Loop
│  ↓ Agent 可继续选择下一个 Tool
│
└─ 异步 ACCEPTED
   ↓ 当前 Agent 执行暂停，机器人继续实际执行
   RobotEvent 最终反馈
   ↓ Java 更新 RobotCommand
   TaskExecutionService 重新判断当前 PlanStep
   ↓ 如需继续：新 ExecutionContext → 重新唤醒动作 Agent

Step 完成
↓ Java 将 PlanStep 标记为 SUCCEEDED
↓ 推进下一 PlanStep
↓ Task COMPLETED
~~~

同步分支中的 Agent Tool Loop 没有被打断；异步分支才需要 Java 在最终反馈到达后恢复当前 Step。无论采用哪条分支，Java 都不选择 `navigate_to`、`booth_show`、`play_named_action` 等具体 Tool，Tool 选择始终属于动作 Agent。

记录 RobotCommand 和执行 `tools/call` 可以由同一个 Java ToolCallback / MCP Client 调用边界完成；图中的分支表达“同时产生调用记录和真实 Tool 调用”，不是把 Tool 转换成 Command 后再转换回 Tool。

当前项目边界是 2 台机器人、单展厅、Spring Boot 模块化单体、PostgreSQL 和 Spring AI。bot_mind 与 g1_base 是已有机器人侧代码；本文重点说明 Java 中央平台和智能体如何组织并接入机器人。文中的“目标”“建议”“V2”表示深化设计，不能自动等同于原项目已上线能力。

---

# 第一部分：中央调度平台基础 ⭐⭐⭐

> **这一部分要掌握什么**：六个核心业务对象、一次 Task 的完整执行链，以及重复、超时、乱序和人工接管时系统怎样保持一致。

## 1.1 系统解决什么问题

```text
接待员创建参观任务
→ 生成或选择参观路线
→ 分配一台可用机器人
→ 机器人按步骤去 A、B、C
→ 到站讲解、回答问题、做动作
→ 平台持续知道执行到哪一步
→ 异常时重试、停止或交给工作人员
```

平台处理的是业务协调，不是 Nav2 如何避障。当前规模采用 Spring Boot 模块化单体，数据统一落 PostgreSQL，无需微服务、消息队列或分布式锁。

## 1.2 核心业务模型

| 对象 | 一句话解释 | 典型字段 |
|---|---|---|
| Robot | 一台可被分配的机器人及其最新业务状态 | robotId, onlineStatus, workStatus, areaCode |
| Task | 一批访客的一次完整接待任务 | taskId, requirement, status, assignedRobotId |
| Plan | Task 经人工审核后的执行路线 | planId, taskId, version, status |
| PlanStep | 一个业务阶段，例如 `VISIT A03`；不展开机器人内部每个动作 | stepId, type, targetCode, sequence, status |
| RobotCommand | 一次有副作用的机器人 Tool Calling 的持久化记录及当前状态快照 | commandId, taskId, stepId, robotId, toolName, payload, status |
| RobotEvent | 机器人对某次 RobotCommand 的异步执行反馈 | eventId, commandId, type, occurredAt |

### PlanStep.type：业务步骤类型

`PlanStep.type` 描述“这一阶段业务上要完成什么”，不描述机器人底层具体执行什么动作。第一版只保留少量稳定类型：

| PlanStep.type | 业务含义 | targetCode | 典型完成条件 | 动作 Agent 可能使用的 bot_mind Tool |
|---|---|---|---|---|
| `VISIT` | 到指定展台并完成该站接待 | `A03`、`B05` | 到达目标展台，并完成该站讲解或接待流程 | `navigate_to`、`booth_show`，必要时 `play_named_action` |
| `WAIT` | 当前业务流程暂时等待时间或现场指令 | 可为空 | 等待条件满足，例如用户说“继续” | 通常不主动调用动作 Tool；必要时使用 `stop_speaking`、`stop_robot` 等停止类 Tool |
| `RETURN` | 返回大厅、集合点或指定位置 | `LOBBY`、`HOME` | 到达指定返回点 | `navigate_to` |
| `END` | 当前接待任务结束 | 可为空 | Java 完成 Task 收尾 | 通常不再产生机器人业务 Tool |

```java
public enum PlanStepType {
    VISIT,   // 到目标展台并完成本站接待
    WAIT,    // 等待时间或现场继续指令
    RETURN,  // 返回指定集合点
    END      // 结束任务并由 Java 收尾
}
```

这四个值是允许的业务步骤类型，不表示每个 Plan 都必须包含四种步骤。Java 在交给动作 Agent 前校验类型与目标组合：`VISIT`、`RETURN` 必须提供已配置的 targetCode，`WAIT`、`END` 可以为空；模型不能用自由文本临时创造新类型或任意导航目标。

还要区分 `PlanStep.type = WAIT` 与 `PlanStep.status = WAITING_INTERACTION`：前者是计划中明确安排的等待阶段，后者是任意 Step 执行到一半时的运行状态。例如 `VISIT B05` 到站后因“先别讲”进入 `WAITING_INTERACTION`，其 type 仍然是 `VISIT`。

```text
Robot 1 ─ n Task（历史上可以执行多个 Task）
同一时刻，一个 Robot 最多执行一个活动 Task
Task  1 ─ 1 Plan
Plan  1 ─ n PlanStep
PlanStep 1 ─ n RobotCommand
RobotCommand 1 ─ 0..n RobotEvent
```

这组关系表达的是历史记录，不表示机器人可以同时执行多个活动任务。

PlanStep 记录业务目标，不把正常接待拆成 `NAVIGATE / SPEAK / WAVE` 等机器人动作步骤。`WAIT` 只表示业务计划明确要求的等待阶段，导航中的短暂等待或 Tool 内部暂停不会自动生成一个 WAIT Step。以 `S3 = VISIT A03` 为例，动作 Agent 为完成它可能发起多次有副作用的 Tool Calling，每次调用都伴随一条 RobotCommand 记录：

```text
PlanStep S3：VISIT A03
↓ 动作 Agent
├─ tool_call：navigate_to("A03")          → RobotCommand C101
├─ tool_call：play_named_action("wave")  → RobotCommand C102
└─ tool_call：booth_show("开始讲解展台") → RobotCommand C103
```

`NAVIGATE`、`SPEAK`、`WAVE`、`PLAY_ACTION`、`TTS` 描述的是机器人能力或实现方式，不是当前 V2 的 StepType。同一个 `VISIT` 可能使用导航、挥手和讲解多个 Tool；如果把这些能力名提升为业务 Step 类型，正式 Plan 就会与 bot_mind 的具体实现耦合。

因此 `PlanStep 1 ─ n RobotCommand` 表达的是：完成一个业务 Step 的过程中发生了多次具有副作用的机器人 Tool Calling。Tool 是 bot_mind 真正提供的能力；Command 是中央平台对调用的执行记录。C101、C102 成功只说明导航和挥手完成；只有 `VISIT A03` 的整体完成条件满足，Java 才能把 S3 标记为 `SUCCEEDED`。


## 1.3 一个 Task 从创建到完成

```text
Task CREATED → 生成 PlanDraft → 人工审核 → Plan APPROVED
→ 事务内分配 Robot → Task RUNNING
→ TaskExecutionService 选择当前 Step 并构造 ExecutionContext
→ 动作 Agent 选择并调用 bot_mind Tool
→ ToolCallback 伴随保存 RobotCommand，并执行 tools/call
├─ 同步最终结果：Tool Result 回到当前 Agent Loop，Agent 可继续选 Tool
└─ 异步 ACCEPTED：Agent 暂停，最终 RobotEvent 到达后由 Java 恢复 Step
→ 动作 Agent 返回当前 Step 的执行结果
→ Java 判断等待、完成或继续
→ 全部成功 → Task COMPLETED
```

- LLM 只生成草案、意图或工具参数，不能把 Task 改成 RUNNING。
- 工作人员审核计划、确认下发、人工接管。
- Java 是业务事实中心，根据状态机改变 Task、Step、Command。
- 对长耗时调用，机器人可以通过 RobotEvent 异步回传 `STARTED`、`SUCCEEDED`、`FAILED` 或 `CANCELED`。

## 1.4 命令与事件为什么要分开

先用三句话理解：

~~~text
Step    = 这一阶段业务上要完成什么
Command = 这次具体调用了哪个机器人 Tool，以及当前执行到什么状态
Event   = 机器人后来告诉平台，这次调用实际执行得怎么样
~~~

其中，**RobotEvent 的第一定义是：机器人对某次 RobotCommand 的异步执行反馈。** “执行事实、Java 状态机输入”可以作为补充理解，但不需要把它上升为复杂领域事件或事件溯源系统。

最小执行例子如下：

~~~text
PlanStep S3：VISIT B05
        ↓ 动作 Agent
tool_call：navigate_to("B05")
        ↓ Java 记录
RobotCommand C201
tool = navigate_to
status = RUNNING
        ↓ bot_mind 实际导航
RobotEvent E201
commandId = C201
type = SUCCEEDED
        ↓ Java
C201.status → SUCCEEDED
        ↓
TaskExecutionService 判断 VISIT B05 是否完成
├─ 还需要讲解：新 ExecutionContext → 动作 Agent → booth_show(...)
└─ 业务目标已满足：S3 → SUCCEEDED → 下一 Step
~~~

Step 和 Command 不能合并：Step 表达业务目标；动作 Agent 为完成一次 `VISIT A03` 可以依次调用导航、动作和讲解 Tool，每次有副作用的 Tool Calling 各留一条 Command。Command 不是机器人必须理解的中央控制协议，也不是对 Step 的再次翻译。

### Command.status 与 RobotEvent

`RobotCommand.status` 是这次 Tool Calling 的**当前执行状态快照**；RobotEvent 是执行过程中收到过的**异步反馈记录**。可以类比为：

~~~text
RobotCommand.status = 订单当前状态
RobotEvent           = 物流轨迹

Command C201.status = SUCCEEDED
表示：这次导航现在已经成功

Event E1 = STARTED
Event E2 = SUCCEEDED
表示：机器人先后反馈过哪些执行阶段
~~~

正文只使用 `STARTED`、`SUCCEEDED`、`FAILED`、`CANCELED` 这组通用反馈；主流程重点关注最终的成功、失败和取消。某种机器人能力如果需要更细的进度展示，可以增加细粒度反馈，但那只服务于界面进度和审计，不是理解主执行链的前提，也不要求每个 Tool 都设计一套专属 Event 类型。

### Tool Result 与 RobotEvent

**同步 Tool Result 与异步 RobotEvent 的最大区别，不只是结果来源不同，还决定了动作 Agent 是否需要被重新唤醒。**

~~~text
情况 A：同步 Tool 等到实际完成

play_named_action("wave")
→ 动作真正完成
→ Tool Result = SUCCEEDED
→ Java ToolCallback 更新 RobotCommand
→ Result 直接回到当前 Agent Tool Loop
→ Agent 继续推理并选择下一个 Tool

当前 Agent Loop 没有被打断，不需要经过
RobotEvent → TaskExecutionService → 重新启动 Agent。

情况 B：异步 Tool 只返回受理结果

navigate_to("B05")
→ Tool Result = ACCEPTED
→ Java 只能将 C201.status 更新为 RUNNING
→ 当前 Agent 执行暂停，不能立即调用 booth_show(...)
→ 机器人继续实际导航
→ RobotEvent(type = SUCCEEDED)
→ Java 才将 C201.status 更新为 SUCCEEDED
→ TaskExecutionService 重新判断当前 Step
→ 如仍需继续，构造新 ExecutionContext 并重新唤醒动作 Agent
~~~

因此，Tool Result 表示一次 MCP 调用返回了什么；RobotEvent 表示机器人后续异步执行反馈了什么。同步最终 Tool Result 可以直接回到当前 Agent Tool Calling 循环，Java 仍可更新 Command，但不需要为每个 Tool Result 再启动一次 Agent。对长耗时操作，如果 Tool 只返回 ACK，就必须暂停当前 Agent 执行并等待最终 Event 或状态回调，不能直接调用依赖其完成结果的下一个 Tool，也不能把 Command 或 Step 标成 `SUCCEEDED`。

### Java 怎样处理 RobotEvent

Java 要检查 eventId、commandId、机器人身份和当前状态，避免重复反馈或错误机器人推进任务：

```java
@Transactional
public void handleRobotEvent(RobotEvent event) {
    // eventId 唯一约束：重复事件不重复推进。
    if (!eventRepository.insertIfAbsent(event)) return;

    RobotCommand command = commandRepository.lockById(event.commandId());
    if (!command.robotId().equals(event.robotId())) {
        throw new IllegalArgumentException("事件来源与命令目标不一致");
    }
    command.apply(event);
    taskExecutionService.onCommandUpdated(command.stepId());
}
```

把代码翻译成人话就是：

1. 用 eventId 防止同一个反馈被重复处理；
2. 用 commandId 找到这次反馈属于哪一次 Tool Calling；
3. 校验 robotId，确认反馈来自目标机器人；
4. 根据 Event 更新 RobotCommand 的当前状态；
5. 调用 `taskExecutionService.onCommandUpdated(stepId)`，恢复此前因异步执行而暂停的 Step。

~~~text
RobotEvent
↓ Java 更新 RobotCommand
TaskExecutionService 重新判断当前 Step
├─ 已完成 → Step SUCCEEDED → 下一 Step
├─ 需要等待 → WAITING_INTERACTION
└─ 未完成 → 构造新 ExecutionContext → 再调用动作 Agent
~~~

`onCommandUpdated(stepId)` 不是正常 Agent Tool Calling 循环中每一步的必经入口，也不是“把 Event 直接发给动作 Agent”。它主要用于异步调用打断当前 Agent 执行后，在最终 RobotEvent 或等价状态反馈到达时通知 Java：某条 Command 已经变化，请重新评估这个 Step。只有 Step 尚未完成且还需要机器人继续执行时，Java 才构造新的 ExecutionContext 重新唤醒动作 Agent。动作 Agent 看到的是最新执行上下文和结果摘要，不直接消费 RobotEvent 表。

~~~text
同步最终 Tool Result
→ 直接返回当前 Agent Tool Loop

异步最终 RobotEvent
→ onCommandUpdated(stepId)
→ Java 重新评估 Step
→ 必要时重新唤醒动作 Agent
~~~

两个 ID 只需记住：

~~~text
commandId = 找到这个 Event 属于哪次 Tool Calling
eventId   = 判断这个反馈本身是否已经处理过
~~~

数据库锁只保护短事务，不在网络请求期间持有。Java ToolCallback 先持久化本次 Tool Calling 的 RobotCommand，再在事务提交后执行网络调用；Tool Result 或异步 RobotEvent 使用新事务更新记录和状态。

## 1.5 命令可靠执行

每一次真正对机器人产生副作用的 Tool Calling 都对应一条 RobotCommand。动作 Agent 实际选择和调用的是 bot_mind Tool；RobotCommand 只是中央平台伴随该调用保存的持久化执行记录，用于追踪、幂等、超时恢复和审计。

```text
动作 Agent：tool_call navigate_to("B05")

中央平台记录：
commandId = C201
taskId = T100
stepId = S2
robotId = R1
toolName = navigate_to
payload = {"waypointName":"B05"}
status = SENT / RUNNING / SUCCEEDED
createdAt = ...

真正执行：
MCP tools/call
name = navigate_to
arguments = {"waypointName":"B05"}
```

`navigate_to`、`move_distance`、`rotate_robot`、`play_named_action`、`execute_arm_action`、`booth_show`、`stop_robot` 和 `stop_speaking` 等有副作用 Tool 需要 RobotCommand。`get_robot_state`、`get_current_waypoint` 等只读 Tool 如果不要求完整业务审计，可以只保存普通 Tool Trace 或日志。

commandId 由中央 Java 平台为每次副作用调用生成，用于归属 Step、日志追踪、幂等、`UNKNOWN` 对账、恢复执行和 RobotEvent 关联。只比较 Tool 名称不够，因为连续两次合法挥手必须允许；同一 commandId 的幂等重试才代表同一次调用。

当前 bot_mind 的真实 MCP Tool 参数未必都原生包含 commandId。V2 设计要求中央平台能将 commandId 与机器人侧执行关联，具体可以通过 MCP 调用上下文、扩展参数或机器人侧适配层透传，实际方式以现有接口改造为准，不能虚构当前 Tool 已经存在该字段。

**Outbox 只是可靠性增强，不是机器人能力调用模型。** 如果 Java 已保存 RobotCommand C201，却在真正发出 `tools/call` 前崩溃，可以把同一待发送调用写入 Outbox；服务恢复后 Poller 使用原 commandId 和原 Tool 参数重新投递。正常路径在事务提交后立即尝试调用，不故意等待定时扫描。Outbox 保存的是待恢复的原始 Tool 调用，不会把 Command 翻译成另一种机器人协议。当前规模无需引入消息队列。

请求超时先进入 UNKNOWN，因为“没收到结果”不等于“没执行”：

1. 按 commandId 查询机器人侧状态；
2. 仅对明确幂等、业务允许的命令重发原 ID；
3. 仍不确定则暂停 Step 并人工接管；
4. 不能换新 ID 盲目重试移动或动作。

RobotEvent 仍由 1.4 节的处理器落库：Java 先更新 RobotCommand，再由 TaskExecutionService 重新评估 Step。只有 Step 未完成且还需要继续执行时，Java 才构造新的 ExecutionContext 调用动作 Agent；整体条件满足时由 Java 把 PlanStep 标记成功并推进下一步。

接管时 Task 进入 PAUSED_MANUAL，Java 停止产生新命令并请求机器人停止/取消。进程退出和网络断开都不能证明机器人已安全停止，必须等待设备状态或现场确认。

## 1.6 本部分小结

~~~text
Task              一次完整接待任务
Plan              人工审核后的业务路线
PlanStep          一个业务阶段，例如 VISIT A03
Tool Call         动作 Agent 对 bot_mind 真实机器人能力的调用
RobotCommand      中央平台对一次副作用 Tool Calling 保存的执行记录
RobotEvent        机器人对某次 RobotCommand 的异步执行反馈
commandId         标识同一次命令，支撑幂等、追踪与 UNKNOWN 对账
eventId           标识一次反馈，防止同一 Event 被重复处理
UNKNOWN           表示结果暂时无法确认
~~~

Java 是任务事实中心；机器人负责执行并回报。同步最终 Tool Result 在更新 RobotCommand 后直接返回当前 Agent Tool Loop；异步 RobotEvent 则由 Java 更新状态并恢复此前暂停的 Step。两条路径最终都由 Java 判断 PlanStep 是否完成。

---

# 第二部分：中央规划 Agent ⭐⭐⭐

> **这一部分要掌握什么**：Java 与 LLM 的职责边界、结构化计划怎样校验和修订，以及为什么规划不锁资源而下发必须原子分配。

## 2.1 为什么需要 Planning Agent

用户可能说：“带一批学生参观，希望多看 AI 互动项目，必须经过 A03，最好少走回头路。”

Java 擅长在线、空闲、区域、能力、展台开放、mustVisit、avoid、maxStops 等硬事实；LLM 擅长理解“学生”“互动”“AI 主题”“少走回头路”等软偏好。边界是：**Java 管硬约束，模型处理语义偏好，Java 再验证结果。**

## 2.2 Planning Agent 总流程

```text
规划请求
  ↓
Java 查询并过滤可用机器人、开放展台
  ↓
PlanEvidence
  ↓
Planner 输出 PlanDraft
  ↓
Java 格式校验 + 业务 Validator
  ├─ 合法：保存 DRAFT
  ├─ 可修订：错误反馈给 Reviser
  └─ 无解：NEEDS_HUMAN_REVIEW
  ↓
人工审核
  ↓
下发前重新查询最新状态
  ↓
事务内原子占用机器人
  ↓
生成 Plan / PlanStep 并执行
```

规划期间不锁机器人。草案是建议，真正占用发生在人工批准并点击下发时。

## 2.3 PlanEvidence：模型允许使用的事实

```java
public record PlanEvidence(
    List<RobotCandidate> candidateRobots,
    List<ExhibitCandidate> candidateExhibits,
    List<String> mustVisit,
    List<String> avoid,
    Integer maxStops
) {}

public record RobotCandidate(
    String robotId,
    String areaCode,
    Set<String> capabilities
) {}
```

Java 先过滤 ONLINE + IDLE + 区域允许 + 能力满足，只把合法候选交给模型。Planning Agent 不自己查数据库判断机器人状态：这是强一致事实，Java 直接查询更快、更稳定，也不会让模型漏查。

## 2.4 Planning Tool：只补充语义信息

工具可查询展台主题、适合人群、互动特征和业务背景，不能判断机器人在线、空闲或占用。

```java
@Tool(description = "查询展台主题、受众与展示特点，用于路线偏好判断")
public PlanningSnippetResult searchPlanningKnowledge(String query) {
    return planningKnowledgeService.search(query);
}
```

工具返回 snippetId。模型若引用知识片段，PlanDraft 必须回传对应 ID，Java 才能检查来源。

## 2.5 PlanDraft 与结构化输出

```json
{
  "suggestedRobotId": "R2",
  "orderedExhibitCodes": ["A", "B", "C"],
  "reasonCodes": ["THEME_MATCH", "LESS_BACKTRACKING"],
  "planningSnippetIds": ["PS-17"],
  "needsHumanReview": false
}
```

```java
public record PlanDraft(
    @NotBlank String suggestedRobotId,
    @NotEmpty List<@NotBlank String> orderedExhibitCodes,
    List<String> reasonCodes,
    List<String> planningSnippetIds,
    boolean needsHumanReview
) {}
```

JSON 是传输文本，DTO 是 Java 接收对象，Schema 描述字段和类型，Bean Validation 检查必填与基本结构。Schema 和 Bean Validation 解决“格式能不能读”，后面的业务 Validator 解决“内容能不能用”。优先使用模型或框架的结构化输出约束，再严格解析；可清理外围 Markdown 围栏，但不能用“删逗号、猜字段”悄悄修业务内容。

## 2.6 Java Validator：保证内容能用

```json
{"suggestedRobotId":"R9","orderedExhibitCodes":["A","B","B"]}
```

它是合法 JSON，却可能选择不存在的候选并重复展台。Validator 检查：

- 机器人、展台是否属于候选；
- 路线是否重复；
- mustVisit 是否覆盖，avoid 是否出现；
- 是否超过 maxStops；
- planningSnippetId 是否来自本轮真实工具结果。

```java
public List<PlanViolation> validate(
        PlanDraft draft, PlanEvidence evidence, Set<String> actualSnippetIds) {
    List<PlanViolation> errors = new ArrayList<>();
    boolean robotAllowed = evidence.candidateRobots().stream()
        .anyMatch(r -> r.robotId().equals(draft.suggestedRobotId()));
    if (!robotAllowed) errors.add(new PlanViolation("ROBOT_NOT_CANDIDATE"));

    if (draft.orderedExhibitCodes().size()
            != new HashSet<>(draft.orderedExhibitCodes()).size()) {
        errors.add(new PlanViolation("DUPLICATED_EXHIBIT"));
    }
    if (!draft.orderedExhibitCodes().containsAll(evidence.mustVisit())) {
        errors.add(new PlanViolation("MUST_VISIT_MISSING"));
    }
    if (!actualSnippetIds.containsAll(draft.planningSnippetIds())) {
        errors.add(new PlanViolation("FAKE_EVIDENCE_ID"));
    }
    return errors;
}
```

## 2.7 Reviser 与有限尝试

```text
Planner：A → B → B → C
Validator：DUPLICATED_EXHIBIT
Reviser：A → B → C
Validator：VALID
```

Java 把错误码、字段和允许候选反馈给 Planning ChatClient，让模型重写完整草案。Java 不偷偷删除第二个 B，因为它知道“哪里错”，却不一定知道如何改仍符合用户偏好。

```java
for (int attempt = 1; attempt <= 3; attempt++) {
    PlanDraft draft = planningClient.plan(request, evidence, violations);
    violations = validator.validate(draft, evidence, toolTrace.snippetIds());
    if (violations.isEmpty()) return draftRepository.saveDraft(draft);
    if (validator.isUnsatisfiable(violations)) break;
}
return draftRepository.saveNeedsHumanReview(request, violations);
```

调用顺序是 Attempt 1 使用 Planner，Attempt 2 和 Attempt 3 才是 Reviser；最多 3 次模型尝试。首次合法立即结束；候选为空、mustVisit 与 avoid 冲突等明确无解情况直接人工处理。

它可称“有限反思式修订”，但不是自由运行的 Reflection Agent：反馈来自确定性 Java Validator，次数有上限，输出不能越过人工审核。

## 2.8 人工审核、下发前校验与原子占用

人工审核确认三项内容：建议机器人、展台顺序和必须满足的路线约束。此时仍然只是已批准计划，没有占用机器人。工作人员点击“下发任务”后，Java 才重新查询机器人最新状态并检查：

```text
ONLINE？
IDLE？
能力是否满足？
是否没有其他活动 Task？
```

全部通过后，Java 用一个短事务同时完成业务占用和执行状态初始化：

```text
Robot R1：IDLE → ASSIGNED，currentTaskId = T100
Task T100：assignedRobotId = R1，status = RUNNING
Plan：进入执行状态
第一个 PlanStep：PENDING → READY
```

核心流程是：

```text
Planning Agent → PlanDraft
→ 人工审核路线、机器人和展台顺序
→ 点击下发
→ Java 复查 R1 最新状态
→ 事务内原子占用 R1，并初始化 Task / Plan / 首个 Step
→ 提交事务
→ TaskExecutionService 选中当前 PlanStep 并构造 ExecutionContext
→ 动作 Agent 调用 R1 的 bot_mind Tools 完成该 Step
```

草案生成后 R1 可能已被其他任务占用，所以条件更新必须发生在下发事务内：

```sql
UPDATE robot
SET work_status = 'ASSIGNED', current_task_id = :taskId
WHERE robot_id = :robotId
  AND online_status = 'ONLINE'
  AND work_status = 'IDLE'
  AND area_code = :requiredArea;
```

影响 1 行才成功；0 行返回 `ASSIGN_CONFLICT`，重新规划或人工处理。不能静默换机器人，因为人工审核的是“机器人 + 路线”的整体。

这里的“锁定机器人”不是在整个接待任务期间持有数据库行锁。事务提交后数据库锁立即释放，但 `work_status=ASSIGNED` 和 `current_task_id=T100` 会继续保存业务占用；其他任务的条件 UPDATE 因为要求 `work_status=IDLE` 而失败。机器人网络调用必须在事务提交以后开始，避免拿着数据库锁等待设备响应。

## 2.9 本部分小结

~~~text
PlanEvidence
→ Planner
→ PlanDraft
→ Validator
→ 必要时 Reviser
→ 人工审核
→ 下发前校验
→ 原子分配
~~~

**LLM 负责提出计划，Java 负责保证计划合法并决定是否执行。**

---

# 第三部分：G1 机器人执行系统 ⭐⭐⭐

> **这一部分要掌握什么**：bot_mind Tool Calling 如何下沉到机器人、Python Worker 为什么存在、三层动作体系怎样复用，以及多个控制源如何安全协作。

## 3.1 从 Java 到机器人的完整调用链

```text
Java TaskExecutionService 选中当前 PlanStep
  ↓ 构造 ExecutionContext
动作 Agent 产生 tool_call
  ↓ Java ToolCallback / MCP Client
  ├─ 伴随保存 RobotCommand 执行记录
  └─ MCP tools/call
  ↓
bot_mind
  ↓ 本机 ROS2 调用
G1ControlServer
  ↓
RobotController
  ├─ NavigationManager / Nav2：导航
  └─ UnitreeSdkBridge / Python Worker：底盘、手臂、动作
                               ↓
                          Unitree SDK
  ↓
  ├─ 同步最终 Tool Result
  │  → 更新 RobotCommand
  │  → Result 回到当前 Agent Tool Loop
  │  → Agent 可继续选择 Tool
  │
  └─ 异步 ACCEPTED
     → 当前 Agent 暂停
     → RobotEvent 最终反馈
     → Java 更新 RobotCommand
     → TaskExecutionService 重新判断 Step
     → 必要时用新 ExecutionContext 重新唤醒动作 Agent
```

## 3.2 G1ControlServer 与 RobotController

G1ControlServer 统一承接需要持续反馈的导航 Action、短时控制 Service 和运行状态发布；RobotController 再把这些上层调用收敛到导航、底盘、手臂和安全状态。正文不枚举所有接口，只保留职责边界：

- Java TaskExecutionService 决定当前执行哪个正式 PlanStep，并维护业务状态；
- 动作 Agent 根据 ExecutionContext 选择并组合 bot_mind Tools；
- bot_mind 承接机器人本机语音、讲解与技能；
- G1ControlServer 是 ROS2 控制入口，提供导航 Action、动作/移动/停止 Service 并发布状态；
- RobotController 组合导航、运动和安全状态；
- UnitreeSdkBridge / Worker 隔离 SDK。

动作 Agent（文档中的 Robot Control Agent）是 PlanStep 的统一机器人 Tool 执行入口。语义上它直接调用 bot_mind 暴露的 Tool；技术上 Spring AI ToolCallback / MCP Client 是受控调用边界，负责绑定 robotId、校验权限和参数、伴随保存 RobotCommand，并执行真实的 `tools/call`。ToolCallback 不选择业务动作，也不是第二个决策 Agent。本章描述 Tool 调用之后的机器人执行层，它负责让动作真正、安全、可取消地执行。

## 3.3 为什么使用独立 Python Worker

现有 UnitreeSdkBridge 启动 Python 子进程，通过 stdin/stdout 逐行 JSON：

```json
{"id":41,"command":"loco_move","vx":0.2,"vy":0.0,"wz":0.0}
{"id":41,"ok":true,"result":{}}
```

这样可以隔离 SDK 依赖与崩溃，用 requestId 对齐响应，用 stdin 锁和请求锁避免并发串线，用独立线程消费 stderr 以免管道堵塞。底盘高频指令采用“只保留最新值 + 限频”，停止指令优先。

目标实现还要补充请求超时、取消和 Worker 健康检查。杀掉 Worker 只表示进程结束，不能证明机器人停稳。

## 3.4 snapshot / motion / script

- **snapshot**：单个关键姿态，如抬右手、指向左侧、恢复；从当前姿态平滑插值过去。
- **motion**：多帧带时间的连续轨迹，如完整挥手。
- **script**：把 snapshot、motion、等待、播报、移动编成完整表演。

```text
script：向前一步 → 播报欢迎语 → wave motion → 等待 1 秒 → 转身
```

~~~text
snapshot（关键姿态）
    ↓ 组成
motion（连续轨迹）
    ↓ 参与编排
script（完整表演流程）
~~~

三层让关键姿态可组成不同动作，动作又可复用到多段讲解脚本；关节数据与业务流程也能分别维护。

## 3.5 导航、动作和控制互斥

| 控制源 | 示例 | 基本规则 |
|---|---|---|
| navigation | Nav2 速度指令 | 导航占用底盘时拒绝普通移动 |
| manual | 人工遥控/紧急停止 | 可按规则抢占并取消导航 |
| script | 表演中的移动与动作 | 独占脚本需要的控制资源 |

```text
导航成功且底盘稳定
→ 取得动作控制权
→ 执行 snapshot / motion / script
→ 发布 STARTED / SUCCEEDED / FAILED / CANCELED
→ 释放控制权
→ Java 决定是否推进下一 Step
```

cancel 终止当前目标；stop 还要立即发安全停止。蹲下状态下移动或导航应被 squat guard 拒绝。Java 不能绕过本机安全拒绝强行重发。

## 3.6 本部分小结

Java 选择当前业务 Step 并记录 Tool Calling 的执行事实，动作 Agent 直接编排 bot_mind Tools，G1ControlServer 与 RobotController 统一机器人本机控制，UnitreeSdkBridge/Worker 隔离 SDK。snapshot、motion、script 解决动作素材复用；navigation、manual、script 的互斥、取消和状态同步守住执行安全。

---

# 第四部分：Spring AI 智能体能力 ⭐⭐

> **这一部分要掌握什么**：ChatClient 如何组织模型和工具、QA 的上下文与数据访问如何隔离，以及意图分类、技能选择、实际机器人执行为何分层。

## 4.1 知识问答 Agent 总流程

```text
用户提问
  ↓
KnowledgeQaAgent + 当前 TaskStep
  ↓
ChatMemory 提供同展台历史
  ↓
LLM 选择 RAG / Weather / Web Search / 0 Tool
  ↓
Java 收集真实 Evidence
  ↓
模型回答
  ↓
Java 校验证据引用后播报
```

## 4.2 ChatClient、ChatModel 与 Tool Calling

ChatModel 是底层模型连接；ChatClient 是组合 Prompt、Tool、Advisor 和输出契约的调用入口。ChatClient 构建时确定模型，不在每次请求里随意切换。

## 4.3 请求级 QaTools

KnowledgeQaAgent、ChatClient、RagService、WeatherService、WebSearchService 是共享对象；QaTools 每轮创建并绑定 robotId、taskId、stepId、exhibitCode、knowledgeVersion。

```java
public QaTools create(QaContext c, EvidenceCollector collector) {
    return new QaTools(c.robotId(), c.taskId(), c.stepId(),
        c.exhibitCode(), c.knowledgeVersion(),
        ragService, weatherService, webSearchService, collector);
}
```

RAG 工具由 Java 绑定当前展台与知识版本，模型只生成 query：

```java
@Tool(description = "查询当前展台已经审核的内部知识")
public RagEvidence searchExhibitKnowledge(String query) {
    return ragService.search(exhibitCode, knowledgeVersion, query);
}
```

若让模型填写 exhibitCode，它可能越界。RAG 和工具调用是两个维度：RAG 是检索增强方法；这里将其封装为 Tool，让模型按需选择。天气和联网也是 Tool，但不是 RAG。

## 4.4 ChatMemory 与上下文边界

“这个设备是什么？”之后追问“它有什么特点？”，需要历史理解“它”。采用：

```text
conversationId = taskId + ":" + stepId
```

同一展台共享上下文；换展台后 stepId 改变，不继承上一站语义。多机器人任务不同，也不会共享历史。

```text
ChatMemory → 之前聊过什么
QaTools    → 当前允许查什么
```

历史存 PostgreSQL，每轮只加载最近若干条或摘要。工具结果不长期原样混入记忆，避免旧天气和旧证据被复用。

## 4.5 RAG

```text
已审核文档 → Chunk → Embedding → pgvector
→ exhibitCode + knowledgeVersion 过滤
→ 相似度 TopK → Evidence → LLM
```

先做元数据过滤，再做向量检索。切分大小、TopK 和阈值应通过真实问答集评估。

## 4.6 Evidence 与工具容错

- RAG 无结果：不回答展厅内部事实；
- Weather 超时：明确实时天气不可用，不靠模型记忆补写；
- Web Search 失败：实时问题降级，普通非实时知识仍可回答；
- Tool 参数错误：受控返回，最多允许有限改参。

每次工具结果登记真实 evidenceId。模型回传的 evidenceIds 必须是本轮真实集合的子集：

```java
if (!collector.evidenceIds().containsAll(answer.evidenceIds())) {
    throw new UntrustedAnswerException("模型引用了不存在的证据");
}
```

conversationId 隔离语义，请求级 QaTools 隔离业务数据访问。

## 4.7 意图识别

“停止”“下一站”等明确指令由 Java 规则直接处理；识别为 `NEXT_STEP` 后，Java 必须根据已审核的正式 Plan 查询当前 Step 和下一个 Step，再校验 Task、Robot 与目标展台。动作 Agent 不允许根据自然语言自己猜下一站。未命中规则的复杂文本才进入无工具、低温度、结构化输出的 Intent ChatClient：

```text
ROBOT_CONTROL / KNOWLEDGE_QA / CENTRAL_PLANNING / OTHER
```

分类失败或置信不足时澄清，不能猜测具有副作用的路由。

## 4.8 动作 Agent（Robot Control Agent）

> **项目经历边界**：本节用于解释中央平台与机器人控制链的完整协作方式。动作 Agent 不是本文作者实际主责开发的模块；以下内容属于 V2 架构理解和面试扩展，不能表述成“我实现了动作 Agent”。

### 4.8.1 动作 Agent 负责什么

这条执行链只有一个机器人 Tool 决策入口：

```text
Planning Agent       → 决定去哪，形成正式 Plan
Java TaskExecutionService → 决定现在执行哪个 PlanStep
动作 Agent           → 决定当前 Step 调用哪些 bot_mind Tools
bot_mind             → 定义并实现具体 Tool
Java 状态机          → 保存事实并修改 Task / Step 状态
```

TaskExecutionService 只负责查询当前正式 Step、判断是否允许开始、构造 ExecutionContext、接收 Agent 执行结果、更新 Step 状态并推进下一 Step。它不决定调用 `navigate_to`、`booth_show` 还是 `play_named_action`。

每个需要机器人执行的业务 PlanStep 都由动作 Agent 根据 ExecutionContext 调用 bot_mind Tools 完成。普通 `VISIT` 因上下文简单，Agent 通常执行 `navigate_to → booth_show` 的标准组合；出现“先别讲”“到站挥手”等临时要求时，仍是同一个 Agent，只是调整 Tool 顺序和等待条件。

动作 Agent 不决定正式 Plan 的下一 Step，也不修改 Task、PlanStep、RobotCommand 或 RobotEvent 数据。它可以通过白名单 Tool Calling 发起机器人能力调用，但不能绕过 Tool 门禁直接访问 ROS2、Unitree SDK、Shell 或任意机器人接口。

### 4.8.2 ExecutionContext

TaskExecutionService 从当前 Task、正式 Plan、PlanStep、Robot 状态、RobotCommand 当前状态和 Java 整理后的结果摘要临时组装只读上下文，不要求新增数据库表。RobotEvent 先由 Java 归并到 Command 和结果摘要，不会原样交给动作 Agent：

```java
public record ExecutionContext(
    String taskId,
    String stepId,
    String robotId,
    PlanStepType stepType,
    String targetCode,
    String currentRobotState,
    String executionPhase,
    String temporaryInstruction
) {}
```

它明确告诉 Agent：执行哪个 Step、控制哪台机器人、业务上要完成什么、目标在哪里、已经完成到哪一步以及本轮有什么临时要求。`stepType` 和 `targetCode` 来自 Java 查询的正式 Plan，不能由 Agent 猜测或改写。

机器人能力来自目标机器人上的 bot_mind。Java/Spring AI 通过 `tools/list` 获取 Tool 定义，通过受控 ToolCallback / MCP Client 执行 `tools/call`。当前源码中的代表性工具包括：

| 能力 | bot_mind 当前真实 Tool |
|---|---|
| 点位导航 | `navigate_to`、`navigate_to_next_waypoint` |
| 位置与状态 | `get_current_waypoint`、`get_robot_state` |
| 小范围移动 | `move_distance`、`move_steps`、`rotate_robot` |
| 动作 | `play_named_action`、`execute_arm_action` |
| 展台讲解 | `booth_show`、`booth_continue`、`stop_speaking` |
| 安全停止 | `stop_robot` |

当前源码没有启用名为 `activate_waypoint` 的 MCP Tool，因此本文使用真实的 `booth_show` 表达“播放当前展台讲稿、TTS 和配置动作”。`get_robot_state`、`get_current_waypoint` 等只读 Tool 可以只留普通 Trace；对机器人产生副作用的 Tool 才必须建立 RobotCommand。

动作 Agent 按三个层次决定下一次 Tool Calling：

1. `stepType` 先限定业务完成目标和允许使用的能力范围；
2. `targetCode` 提供 Java 已确认的固定业务目标，Agent 不能自行换站；
3. `currentRobotState`、`executionPhase`、`temporaryInstruction` 等上下文决定现在应该调用哪个 Tool、等待还是结束本 Step。

Agent 不是只看到一个 `"VISIT"` 字符串后自由猜测。Java 会同时提供 ExecutionContext、目标机器人的 Tool Schema，并在系统提示中预先定义 StepType 语义和完成目标，例如：

```text
你只能围绕当前 ExecutionContext 完成当前 PlanStep：

VISIT：在 targetCode 指定展台完成一次接待。
通常需要到达目标，并完成该站讲解或接待流程。
可以按 temporaryInstruction 调整 Tool 顺序，但不得改变 targetCode。

RETURN：返回 targetCode 指定位置。
确认到达该位置后，可以报告当前 Step 已完成。

WAIT：暂停推进当前业务流程，等待时间条件或新的现场指令。
不得自行选择或推进下一个正式 PlanStep，也不存在必须调用的 wait Tool。

END：不再发起新的机器人业务动作，返回收尾结果，由 Java 完成 Task 收尾。

Tool Result 只说明某次能力调用的结果；不得自行修改 PlanStep 状态。
```

```text
VISIT + A03
├─ 尚未到站                         → navigate_to("A03")
├─ 已到站 + temporaryInstruction=先别讲 → 返回等待结果，不调用 booth_show
└─ 已到站 + 允许讲解                 → booth_show(...)

WAIT + targetCode=null              → 通常不调用动作 Tool，返回等待结果
RETURN + LOBBY                      → navigate_to("LOBBY")
END + targetCode=null               → 不调用机器人业务 Tool，由 Java 完成 Task 收尾
```

这不是把 `type` 硬编码成唯一 Tool：`VISIT` 可能因为现场要求增加 `play_named_action`，也可能在到站后先等待。但 Java ToolCallback 仍要校验 Tool 与当前 Step 是否相容，例如 `RETURN LOBBY` 的 `navigate_to` 参数不能被模型改成未授权点位。

完成条件也不能只看 Tool 名字。`navigate_to("A03") → SUCCEEDED` 只证明机器人已到达 A03；如果 `VISIT A03` 还要求完成该站讲解或接待，Java 不能把 Step 标成成功。对于只要求回到指定位置的 `RETURN HOME`，关联 HOME 的最终导航成功结果则可能已经满足整个 Step。**Tool Result 表示一次机器人能力调用结果；PlanStep 是否完成，要按 StepType 的业务完成条件由 Java 状态机最终判断。**

### 4.8.3 Agent 直接 Tool Calling

“动作 Agent 直接调用 bot_mind Tool”是语义定义：Agent 选择的就是 bot_mind 实际暴露的 Tool，不先生成另一套 RobotCommand 控制协议。Spring AI / Java ToolCallback 是安全和持久化边界，不是第二个机器人决策层。

```text
PlanStep S2：VISIT B05
          ↓
       动作 Agent
          ↓
 tool_call：navigate_to("B05")
          │
          ├──── 伴随记录 ────→ RobotCommand C201
          │                    “记录本次 Tool Calling”
          ▼
   MCP tools/call
          ↓
      R1 bot_mind
          ↓
       真正导航
```

Java ToolCallback / MCP Client 在这个受控调用边界完成 robotId 绑定、权限检查、参数校验、commandId 生成、RobotCommand 记录和真实 `tools/call`。这些是同一次 Tool Calling 的门禁与留痕，不是“Tool → Command → Tool”的转换。

动作 Agent 的正常 Tool Calling 可以在同一次框架执行中连续循环：

```text
动作 Agent
↓ tool_call A
Tool Result A = 最终结果
↓ 返回当前 Agent Tool Loop
Agent 继续推理
↓ tool_call B
Tool Result B = 最终结果
↓
Agent 返回当前 PlanStep 的执行结果
```

例如 `VISIT A03` 中，`play_named_action("wave")` 如果等待动作真正完成并返回 `SUCCEEDED`，结果会直接回到当前 Agent，Agent 可以继续调用 `booth_show(...)`。这些 Tool 都返回最终结果时，可以在同一次 Agent 执行中连续完成，`onCommandUpdated()` 不是每一步的必经入口。

如果 `navigate_to("A03")` 只返回 `ACCEPTED`，导航仍在异步执行，当前 Agent Loop 必须暂停。之后等待 RobotEvent 最终反馈，由 Java 更新 Command、重新评估 Step，并在仍需继续时使用新的 ExecutionContext 重新唤醒动作 Agent。动作 Agent 不直接订阅或消费 RobotEvent。

### 4.8.4 普通 PlanStep 怎样执行

正式计划给出：

```text
Task T100
Robot R1
PlanStep S3：VISIT A03
```

TaskExecutionService 构造 `stepType = VISIT`、`targetCode = A03`、`temporaryInstruction = null` 的 ExecutionContext。动作 Agent 据此判断业务目标是“到 A03 并完成本站接待”，再结合机器人状态执行标准 Tool 组合。具体如何衔接取决于对应 bot_mind Tool 的真实返回语义：

```text
模式 A：navigate_to 同步返回最终结果

动作 Agent → navigate_to("A03")
→ Tool Result = SUCCEEDED
→ Result 回到同一次 Agent Tool Loop
→ 动作 Agent继续选择 booth_show(...)
→ Tool Result = SUCCEEDED
→ 动作 Agent返回：当前 VISIT 已完成

模式 B：navigate_to 只返回异步受理

动作 Agent → navigate_to("A03")
→ Tool Result = ACCEPTED
→ 当前 Agent 执行暂停
→ RobotEvent = SUCCEEDED
→ Java 更新 RobotCommand
→ TaskExecutionService 重新判断 S3
→ 新 ExecutionContext 重新唤醒动作 Agent
→ 动作 Agent选择 booth_show(...)

两种模式最终都由 Java 校验 S3 整体完成条件
→ S3 → SUCCEEDED
→ TaskExecutionService 选择下一正式 Step
```

正文不假定所有 Tool 都采用同一种返回模式，应以对应 bot_mind Tool 的真实接口为准。这里没有另一条“普通流程执行器”：动作 Agent 始终是唯一 Tool 决策入口；Java 只决定当前 Step、维护生命周期、提供上下文并处理异步恢复。

如果同一个 Step 带有临时要求：

```text
stepType = VISIT
targetCode = A03
temporaryInstruction = "到了以后先别讲，先挥个手"

动作 Agent：
navigate_to("A03")
→ 等待导航完成
→ play_named_action("wave")
→ 返回“等待用户继续”，暂不调用 booth_show

Java：
S3.type 仍为 VISIT
S3.status → WAITING_INTERACTION

用户说“开始讲”
→ Java 校验当前仍是 T100 / S3 / R1 / A03
→ 重新构造 ExecutionContext
→ 动作 Agent 调用 booth_show(...)
→ 讲解完成
→ Java 校验 VISIT 整体完成条件
→ S3.status → SUCCEEDED
```

如果上述 Tool 同步返回最终结果，Agent 可在当前 Tool Loop 中继续；如果导航只返回 `ACCEPTED`，则在 RobotEvent 到达后由 Java 用新 ExecutionContext 恢复。临时自然语言要求只改变当前 Step 的 Tool 调用方式，不改变 `PlanStep.type`、`targetCode` 或正式路线。

### 4.8.5 “下一站，但是到了先别讲”怎样执行

数据库中的正式计划是：

```text
S1 = VISIT A03（当前）
S2 = VISIT B05（下一步）
```

用户说“去下一站，但是到了先别讲解”时，一句话中同时包含确定性任务控制和动态执行要求：

```text
机器人麦克风 → ASR
→ 中央 Java / Intent 解析
→ Java 识别 NEXT_STEP
→ 根据正式 Plan 确定下一 Step = S2，targetCode = B05
→ temporaryInstruction = "到站以后先不要讲解"
→ TaskExecutionService 校验当前 S1 允许切换，再将 S2 设为当前活动 Step
→ 构造 ExecutionContext(T100, S2, R1, VISIT, B05, ..., temporaryInstruction)
→ 动作 Agent
→ tool_call：navigate_to("B05")
├─ 伴随记录 RobotCommand C201
└─ MCP tools/call → R1 bot_mind
↓
├─ 同步 Tool Result = SUCCEEDED
│  → Java 更新 C201
│  → Result 回到当前 Agent Tool Loop
│  → Agent 根据 temporaryInstruction 返回“等待现场交互”
│
└─ 异步 Tool Result = ACCEPTED
   → 当前 Agent 执行暂停
   → RobotEvent = SUCCEEDED
   → Java 更新 C201，TaskExecutionService 重新判断 S2
   → 新 ExecutionContext 重新唤醒动作 Agent
   → Agent 根据 temporaryInstruction 返回“等待现场交互”

→ Java 将 S2 更新为 WAITING_INTERACTION
```

用户随后说“开始讲吧”时：

```text
Java 确认 T100 / S2 / R1 / B05 仍匹配当前活动 Step
→ 重新构造 ExecutionContext
→ 动作 Agent tool_call：booth_show("开始讲解展台")
├─ 伴随记录 RobotCommand C202
└─ MCP tools/call → R1 bot_mind
→ 同步最终 Tool Result 回到当前 Agent，或异步 Event 到达后恢复 Agent
→ 动作 Agent 返回：当前 VISIT 已完成
→ Java 确认 C202 已进入最终态并校验 S2
→ VISIT B05 整体完成条件满足，S2 → SUCCEEDED
→ TaskExecutionService 推进下一正式 Step
```

“去下一站”的目标 Step 由 Java 根据正式 Plan 确定；“到了先别讲”的执行方式由动作 Agent 理解并落实。工具失败时，Agent 只能在当前 Step 和策略允许范围内改参、停止或等待，不能改写后续路线；取消与停止仍调用 `stop_robot`、`stop_speaking` 等白名单 Tool。同步最终结果直接续接当前 Agent；只有异步执行暂停后，才由 RobotEvent 触发 Java 恢复 Step。

完整心智模型如下：

```text
Planning Agent：“去哪？”
        ↓
正式 Plan
        ↓
Java TaskExecutionService：“现在执行哪个 Step？”
        ↓
PlanStep：VISIT B05
        ↓
ExecutionContext
        ↓
动作 Agent：“这个 Step 怎么完成？”
        ↓
tool_call：navigate_to("B05")
        │
        ├──── RobotCommand C201
        │     “记录本次副作用 Tool Calling”
        ▼
MCP tools/call
        ↓
bot_mind：“真正实现 Tool”
        ↓
G1 / Nav2 / TTS
        ↓
├─ 同步最终 Tool Result → 当前 Agent Tool Loop 继续
│
└─ ACCEPTED → Agent 暂停 → RobotEvent
              ↓
            Java 更新 RobotCommand
              ↓
            TaskExecutionService 重新判断 Step
              ├─ 未完成 → 新 ExecutionContext → 重新唤醒动作 Agent
              └─ 已完成 → Step SUCCEEDED → 下一 Step
```

```text
Planning Agent       → 决定去哪
Java                 → 决定现在执行哪个 Step，并维护状态
动作 Agent           → 决定当前 Step 怎么调用机器人 Tools
bot_mind             → 定义并执行机器人能力
RobotCommand         → 一次副作用 Tool Calling 的执行记录
RobotEvent           → 机器人对某次 RobotCommand 的异步执行反馈
```

面试时应如实表达：“动作 Agent 不是我主责开发的模块，但因为它与我负责的中央平台和 G1 执行模块直接协作，我后续系统梳理过它的 Tool Calling 和 ExecutionContext 机制。”

## 4.9 本部分小结

~~~text
QA Agent：按问题选择 RAG / Weather / Web / 0 Tool
Intent ChatClient：只分类，不调用工具
TaskExecutionService：选择当前正式 Step、构造上下文并维护生命周期
动作 Agent：统一结合 ExecutionContext 调用 bot_mind 白名单 Tools
RobotCommand：伴随副作用 Tool Calling 保存的执行记录
G1 执行层：真正执行技能并保障硬件安全
~~~

ChatMemory 管“之前聊过什么”，请求级 QaTools 管“当前允许查什么”；模型负责语义判断和动态工具编排，Java 负责范围、权限、参数、证据、Command 状态、异步 Event 处理和副作用校验。

---

# 第五部分：项目面试复习

> **这一部分要掌握什么**：用项目问题、设计取舍和异常处理组织回答，避免只背框架名或把 V2 目标设计说成全部已上线。

## 5.1 中央调度平台高频问题

### Q1：Step、Tool、Command、Event 分别是什么？

**推荐回答：** PlanStep 是 `VISIT B05` 这样的业务目标；Tool 是机器人真正提供的能力；RobotCommand 记录这次调用了哪个有副作用的 Tool 以及当前状态；RobotEvent 是机器人对某次 RobotCommand 的异步执行反馈。同步最终 Tool Result 可以直接回到当前 Agent Loop；异步 Event 则由 Java 更新 Command 并恢复 Step。

**一句话记忆：** Step 是目标，Tool 是能力，Command 记当前调用，Event 是异步反馈。

#### 追问：RobotEvent 是什么？

**推荐回答：** RobotEvent 是机器人对某次 RobotCommand 的异步执行反馈。比如导航 Tool 已经发出后，机器人稍后回报导航成功或失败。Java 根据 Event 更新 Command，再判断当前 PlanStep 是否完成。

**一句话记忆：** Event 是机器人异步执行反馈。

#### 追问：Command 已经有 status，为什么还要 Event？

**推荐回答：** `Command.status` 表示当前状态，Event 表示机器人实际回报过哪些执行阶段。对长耗时动作，Tool 可能只先返回 `accepted`，真正完成要靠后续 Event 或状态回调确认。

**一句话记忆：** Command 看现在，Event 记过程。

#### 追问：Event 只是日志吗？

**推荐回答：** 不是。它既可以记录异步执行反馈，也会作为 Java 更新 Command 和重新判断 Step 的输入，但不需要把它设计成复杂事件溯源系统。

**一句话记忆：** Event 能留痕，也能推动 Java 重评估状态。

#### 追问：onCommandUpdated 是发给动作 Agent 吗？

**推荐回答：** 不是。它主要处理异步执行暂停后的恢复：最终 Event 到达后，Java 重新评估当前 Step；只有 Step 还没完成且需要继续执行时，才重新构造 ExecutionContext 并唤醒动作 Agent。同步 Tool Calling 的每一步不经过它。

**一句话记忆：** 先由 Java 判断 Step，再决定是否继续调用 Agent。

#### 追问：每次 Tool 执行完都要 Java 再调用一次动作 Agent 吗？

**推荐回答：** 不一定。如果 Tool 等到真正执行完成再返回，Tool Result 会直接回到当前 Agent 的 Tool Calling 循环，Agent 可以继续选择下一个 Tool；如果 Tool 只是返回 `accepted`，而机器人还在异步执行，那么当前 Agent 执行先暂停，等 RobotEvent 最终回报后，Java 更新 Command 和 Step 上下文，再重新唤醒动作 Agent。

**一句话记忆：** 同步结果直接续 Agent，异步结果由 Event 恢复 Agent。

#### 追问：Java TaskExecutionService 会决定下一次调用哪个机器人 Tool 吗？

**推荐回答：** 不会。Java 只决定当前执行哪个正式 Step，并维护 Step 生命周期和 ExecutionContext；`navigate_to`、`booth_show`、`play_named_action` 等具体 Tool 始终由动作 Agent 选择。

**一句话记忆：** Java 决定要不要继续，Agent 决定继续时调用什么 Tool。

## 5.2 Planning Agent 高频问题

### Q2：它为什么不是普通 Chatbot？

**推荐回答：** 它接收 Java 准备的事实，按需查询规划知识，输出结构化可执行草案，经业务 Validator 后有限修订并进入人工审核。模型做语义规划，Java 掌握状态和执行权。

**追问：** 为什么不让模型查机器人在线状态？强一致事实由 Java 直接查更可靠。

**一句话记忆：** Agent 规划，Java 决策和执行。

### Q3：JSON 正确但内容错误怎么办？

**推荐回答：** Schema 和 Bean Validation 保证能解析，业务 Validator 再检查候选、重复、必到和禁入。错误反馈 Reviser，至多两次；无解或持续失败转人工。

**追问：** Java 为什么不直接删重复展台？它知道哪里错，不一定知道怎样改仍符合偏好。

**一句话记忆：** 结构校验保证能读，业务校验保证能用。

### Q4：规划为什么不锁机器人？

**推荐回答：** 草案可能被拒绝，提前锁定会浪费资源。审核下发时重新查状态，再用条件更新原子完成 IDLE → ASSIGNED；冲突显式返回，不能静默换机器人。

**追问：** 为什么不能静默换？审核的是机器人和路线整体。

**一句话记忆：** 规划是建议，下发才占资源。

### Q5：修订算 Reflection Agent 吗？

**推荐回答：** 广义是反思式修订，严格说不是独立开放的 Reflection Agent。反馈来自确定性 Validator，总共最多三次模型尝试，持续失败转人工。

**追问：** 为什么不是固定三次？首次合法即结束，无解也立即停止。

**一句话记忆：** 有限校验反馈，不是无限自我反思。

## 5.3 可靠执行与并发问题

### Q6：Tool Calling 的幂等是不是重复调用不再执行？

**推荐回答：** 对代表同一次副作用 Tool Calling 的 commandId 是。commandId 由 Java 生成，V2 要求机器人侧适配层关联 commandId、payloadHash 和结果；同 ID 同参数返回历史结果，同 ID 不同参数拒绝。两次正常挥手使用不同 ID。现有 Tool 是否原生携带 commandId 要以真实接口为准，不能把目标设计说成已有能力。

**追问：** 超时重发用什么 ID？必须用原 ID。

**一句话记忆：** 同一次不重做，不同次仍可执行。

### Q7：为什么超时是 UNKNOWN？

**推荐回答：** 平台没收到响应时，机器人可能已执行。先查询、必要时按原 ID 幂等重发，仍不确定就暂停并人工接管。

**追问：** 哪些不能自动重试？参数非法、资源冲突、安全拒绝和非幂等副作用。

**一句话记忆：** 没收到结果，不等于没有执行。

### Q8：两台机器人为什么还做并发控制？

**推荐回答：** 人少也可能同时下发或争抢同一展台。数据库条件更新、唯一约束和短事务足以守住不变量，不需要分布式锁。

**追问：** 扩到十几台要重写吗？保留状态和约束，再按吞吐决定基础设施。

**一句话记忆：** 用最小机制守住并发不变量。

---

## 5.4 G1 动作模块问题

### Q9：为什么 Unitree SDK 放独立 Worker？

**推荐回答：** 隔离 SDK 依赖、慢调用和崩溃。逐行 JSON 通信，requestId 对齐，锁保证串行，独立线程消费 stderr。

**追问：** 杀 Worker 是否等于机器人已停？不是，要靠停止指令和设备状态确认。

**一句话记忆：** Worker 隔离 SDK，安全停止仍需确认。

### Q10：snapshot、motion、script 为什么三层？

**推荐回答：** snapshot 是关键姿态，motion 是连续轨迹，script 是动作、等待、播报的业务编排。分层便于素材复用并隔离关节数据与业务流程。

**追问：** 为什么动作与导航互斥？两个控制源同时写底盘或姿态会不可预测。

**一句话记忆：** 姿态组成动作，动作组成表演。

### Q11：cancel 和 stop 有什么区别？

**推荐回答：** cancel 结束当前目标；stop 还要立即发送安全停止。取消后需发布状态、释放控制权，Java 再决定跳过、重试或人工处理。

**追问：** 结束线程够吗？不够，线程状态不是硬件状态。

**一句话记忆：** cancel 管任务，stop 管安全停止。

## 5.5 QA Agent / RAG 问题

### Q12：RAG 为什么做成 Tool？

**推荐回答：** 展台问题需要 RAG，天气需要天气工具，寒暄不需要。模型决定是否查，Java 绑定展台和知识版本，控制能查什么。

**追问：** 模型内置联网为何不够？平台还要控制来源、超时、审计、结构和降级。

**一句话记忆：** 模型决定是否查，Java 决定能查什么。

### Q13：ChatMemory 和 QaTools 有什么区别？

**推荐回答：** ChatMemory 保存同一 TaskStep 对话，理解“它”；请求级 QaTools 绑定本轮机器人、任务、展台和知识版本，限制数据访问。

**追问：** 换展台为何换 conversationId？避免语义污染。

**一句话记忆：** Memory 管聊过什么，Tools 管允许查什么。

### Q14：如何防止伪造知识来源？

**推荐回答：** Java 记录本轮工具真实 evidenceId，模型结构化返回引用，播报前做集合校验；无证据不回答内部事实。

**追问：** Prompt 要求引用够吗？不够，Prompt 是软约束。

**一句话记忆：** 证据由工具产生，引用由 Java 验真。

## 5.6 Intent / Robot Control 问题

### Q15：意图识别为什么不配工具？

**推荐回答：** 它只分类，目标是快和稳定。明确命令走规则，复杂文本才四分类；工具越多越慢，也扩大权限。

**追问：** 低置信度怎么办？澄清，不猜副作用意图。

**一句话记忆：** 路由器只路由，专业 Agent 才用工具。

### Q16：动作 Agent 到底负责什么？

**推荐回答：** Planning Agent 决定机器人和展台路线，PlanStep 用 `type + targetCode` 保存 `VISIT A03` 这样的业务目标。动作 Agent 读取 Java 给出的 type、targetCode 和 ExecutionContext：type 限定要完成的业务，targetCode 固定目标，机器人状态、执行阶段和临时要求决定下一次调用哪个 bot_mind Tool。Java 保存 Command 当前状态、处理异步 Event 并重新判断 Step，bot_mind 和 G1 执行具体技能。

**追问：** 谁决定当前执行哪个 Step？TaskExecutionService 根据正式 Plan 决定。动作 Agent 直接选择白名单 MCP Tools，但不能猜下一 Step、修改业务状态或绕过 Tool 门禁访问 ROS2、SDK、Shell。

**一句话记忆：** Planning 决定去哪，动作 Agent 决定当前 Step 动态怎么完成。

### Q17：RobotCommand 和 Tool 有什么区别？

**推荐回答：** Tool 是 bot_mind 真正提供的机器人能力，例如 `navigate_to`；RobotCommand 是中央平台对一次有副作用 Tool Calling 保存的持久化执行记录。Agent 真正调用的是 Tool，不是先生成一套 Command 协议再翻译回 Tool。

**追问：** 所有 Tool 都建 Command 吗？不需要。移动、动作、讲解、停止等副作用 Tool 要建；纯状态查询可以只留 Tool Trace。

**一句话记忆：** Tool 是能力，Command 是调用记录。

### Q18：普通 VISIT 为什么也由动作 Agent 执行？

**推荐回答：** 这版设计只有一个机器人 Tool 决策入口。普通 `VISIT A03` 的 ExecutionContext 很简单，动作 Agent 通常执行 `navigate_to(A03) → booth_show(...)`；有临时要求时仍由同一个 Agent 调整顺序或等待。TaskExecutionService 只选择 Step 和维护状态，不选择机器人 Tool。

**追问：** ToolCallback 会不会成为第二个 Agent？不会，它只做身份绑定、权限和参数校验、Command 留痕以及 MCP 调用。

**一句话记忆：** 一个 Agent 入口，普通组合稳定，现场要求动态调整。

### Q19：“下一站”和“下一站但是先别讲”怎样执行？

**推荐回答：** 两者的目标都由 Java 根据正式 Plan 确定，例如下一 Step 是 `S2 = VISIT B05`，动作 Agent 不能猜。普通“下一站”构造无临时要求的 ExecutionContext，Agent 正常调用 `navigate_to → booth_show`；“下一站但是先别讲”则把“到站后先不讲”放入 temporaryInstruction，Agent 导航成功后返回等待结果，由 Java 将 S2 更新为 `WAITING_INTERACTION`。用户说“开始讲”后，Java 校验仍是 T100/S2/R1/B05，再让 Agent 调用 `booth_show`。

**追问：** 谁修改 `WAITING_INTERACTION`？动作 Agent 只返回等待结果，Java Task/Step 状态机负责修改。

**一句话记忆：** Java 定下一 Step，Agent 定这个 Step 怎么执行。

面试时应说明：“动作 Agent 不是我主责开发的模块，但它和我负责的中央平台及 G1 执行模块直接协作，所以我系统梳理过它的 Tool Calling 和 ExecutionContext 机制。”

## 5.7 一分钟项目介绍

我参与的是一个多机器人具身智能展厅项目，主要负责 Spring Boot 中央调度平台、中央规划 Agent，以及 G1 动作编排与执行模块。Planning Agent 基于 Java 准备的候选事实生成机器人和路线草案，经 Validator、有限 Reviser 和人工审核后原子分配机器人。执行时 Java 根据正式 Plan 选择当前业务 Step，并提供 ExecutionContext；动作 Agent 通过 Spring AI Tool Calling 直接编排目标机器人 bot_mind 暴露的导航、讲解和动作能力。平台对每次有副作用的 Tool Calling 保存 RobotCommand：同步最终 Tool Result 直接回到当前 Agent Loop，长耗时调用返回 `accepted` 时则暂停，等 RobotEvent 到达后由 Java 更新状态并恢复当前 Step。执行侧还使用 commandId、UNKNOWN 对账和人工接管处理不确定结果；动作 Agent 属于我为理解完整系统梳理的 V2 深化设计，不是我主责开发的模块。

## 5.8 三分钟项目介绍

项目要解决的是两台机器人同时承担展厅接待时，中央平台怎样把自然语言需求变成计划，并可靠推进导航、讲解和动作。Java 平台采用模块化单体和 PostgreSQL，以 Task 表示一次接待，以审核后的 Plan 和 PlanStep 表示业务顺序。Tool 是 bot_mind 真正提供的机器人能力；RobotCommand 是中央平台对一次副作用 Tool Calling 保存的执行记录和当前状态快照；RobotEvent 是机器人对某次 RobotCommand 的异步执行反馈。LLM 不直接改业务状态。

规划部分采用“Java 管硬约束、LLM 管语义偏好、Java 再校验”。Java 先筛出 ONLINE、IDLE、区域和能力满足的机器人以及开放展台，组成 PlanEvidence。模型可按需查询展台主题等规划知识，输出建议机器人和路线的 PlanDraft。Schema 与 Bean Validation 保证格式能读，业务 Validator 检查候选、重复、mustVisit、avoid 和证据 ID。第一次不合法时把错误交给 Reviser，总共最多三次模型尝试；随后仍需人工审核。下发时再次查询最新状态，并用条件 UPDATE 原子完成 IDLE 到 ASSIGNED，失败显式返回 ASSIGN_CONFLICT。

执行方面，TaskExecutionService 根据正式 Plan 确定当前 Step 并构造 ExecutionContext；动作 Agent 直接选择 bot_mind Tool。Java ToolCallback 在同一次调用边界完成权限和参数校验、commandId 与 RobotCommand 留痕以及 MCP 调用。同步最终结果直接续接当前 Agent Tool Loop；只返回 `accepted` 的异步调用会暂停当前 Agent，最终 RobotEvent 到达后由 Java 更新 Command、重新评估 Step，并在需要时用新 ExecutionContext 唤醒 Agent。网络超时进入 UNKNOWN，平台按原 commandId 查询或幂等重试，仍不确定则暂停并人工接管。Outbox 只用于“记录已保存、调用尚未发出时进程崩溃”的恢复，不属于机器人能力模型。G1 侧由 bot_mind 接入 G1ControlServer，RobotController 协调导航和动作，独立 Python Worker 隔离 SDK。

问答部分使用共享 KnowledgeQaAgent/ChatClient 和每请求 QaTools。工具绑定 robotId、taskId、stepId、exhibitCode 和 knowledgeVersion；conversationId 以 TaskStep 隔离。模型按需选择 RAG、天气、联网或不调用工具，Java 校验本轮真实 evidenceId。Intent ChatClient 只做路由。对于 `VISIT A03` 这类业务 Step，动作 Agent 通常调用 `navigate_to → booth_show`；出现“下一站但是先别讲”等现场要求时，Java 仍确定正式下一 Step，Agent 只调整当前 Step 的 Tool 顺序和等待条件。动作 Agent 不是我主责开发的模块，但我系统梳理了它与中央平台和 G1 执行层的协作边界。

> **本部分小结**：面试回答应始终围绕“解决了什么问题、为什么这样设计、异常如何处理、哪些是实际实现、哪些是 V2 目标方案”展开。

---

# 附录

## 附录 A：认证与权限

正文只需记住：人员和机器人都要认证，但不是同一种身份。

人员统一登录可用 Spring Security OAuth2 Client 对接 Keycloak 或企业 OIDC。OIDC 是登录协议；PKCE 是授权码流程的安全增强。浏览器完成统一登录后，Java/BFF 建立会话，再用 RBAC 判断 RECEPTIONIST、REVIEWER、OPERATOR、ADMIN 权限。后端必须鉴权，隐藏按钮不能替代权限检查。

微信网页或小程序登录只证明用户是谁：Java 用临时 code 在服务端换身份，关联本地用户，再建立平台会话；业务权限仍由本地 RBAC 决定。

## 附录 B：机器人设备安全

固定 IP 解决寻址，不代表身份。robot_registry 保存 robotId、地址、启用状态和凭据摘要；RobotGateway 只访问登记地址，不接受模型提供任意 URL。

- 每台机器人独立 Token，支持停用和轮换；
- Token 与 robotId 映射，回调也检查两者一致；
- 请求记录时间戳、commandId 和审计；
- 使用 TLS 时正常校验证书。

## 附录 C：部署

```text
Nginx / HTTPS
  ↓
Spring Boot 模块化单体
  ├─ PostgreSQL + pgvector
  ├─ 模型、天气、受控联网服务
  └─ 固定地址 RobotGateway → bot_mind / g1_base
```

当前规模单机或少量容器即可。配置外置，密钥不入库；数据库备份；外部服务分别设置连接和响应超时。上线前演练 Java 重启、机器人断网、重复事件和结果未知。

## 附录 D：完整数据库结构

| 表 | 关键字段 | 关键约束 |
|---|---|---|
| robot | robot_id, online_status, work_status, area_code, current_task_id | 条件更新完成分配 |
| task | task_id, requirement, status, assigned_robot_id, version | version 乐观锁 |
| plan | plan_id, task_id, plan_version, status, approved_by | 一个生效版本 |
| plan_step | step_id, plan_id, sequence_no, type, target_code, status | plan_id + sequence_no 唯一 |
| robot_command | command_id, robot_id, step_id, payload_hash, status, attempt_no | 同 ID 参数不可变 |
| robot_event | event_id, robot_id, command_id, type, occurred_at | event_id 唯一 |
| command_outbox | outbox_id, command_id, status, next_attempt_at | command_id 唯一 |
| exhibit | exhibit_code, area_code, capacity, open_status, knowledge_version | capacity > 0 |
| exhibit_allocation | allocation_id, task_id, robot_id, exhibit_code, status, queue_no | 一任务目标一条活动申请 |
| planning_draft | draft_id, task_id, draft_json, status, attempt_count | 保存输出和校验结果 |
| chat_memory | conversation_id, sequence_no, role, content | 会话内序号唯一 |
| knowledge_chunk | chunk_id, exhibit_code, knowledge_version, content, embedding | 只查发布版本 |
| robot_registry | robot_id, base_url, credential_hash, enabled | 地址由管理员配置 |

```sql
CREATE UNIQUE INDEX uk_event_id ON robot_event(event_id);
CREATE UNIQUE INDEX uk_plan_step_seq ON plan_step(plan_id, sequence_no);
CREATE INDEX idx_command_timeout ON robot_command(status, updated_at);
CREATE INDEX idx_allocation_queue
  ON exhibit_allocation(exhibit_code, status, queue_no);
CREATE INDEX idx_memory_conversation
  ON chat_memory(conversation_id, sequence_no);
```

容量大于 1 时，分配服务在锁定展台的短事务内统计 RESERVED、OCCUPIED、UNKNOWN；WAITING 不占容量，也不是数据库长锁。

## 附录 E：完整状态机

```text
Task:
CREATED → PLANNING → PENDING_REVIEW → APPROVED → RUNNING → COMPLETED
                 └→ NEEDS_HUMAN_REVIEW
RUNNING ↔ PAUSED_MANUAL；任意非终态 → CANCELED

PlanStep:
PENDING → READY → DISPATCHED → RUNNING → SUCCEEDED
                              ↕ WAITING_INTERACTION
RUNNING / WAITING_INTERACTION ├→ FAILED
                              ├→ UNKNOWN
                              └→ CANCELED

RobotCommand:
CREATED → QUEUED → SENT → ACKED → RUNNING → SUCCEEDED
                    ├→ REJECTED / UNKNOWN / FAILED / CANCELED

ExhibitAllocation:
WAITING → RESERVED → OCCUPIED → RELEASED
    └→ CANCELED / EXPIRED
RESERVED → EXPIRED；OCCUPIED → UNKNOWN
```

| 错误 | 默认处理 |
|---|---|
| 规划 JSON 不能解析 | 反馈 Reviser，受总尝试次数限制 |
| 规划硬约束无解 | NEEDS_HUMAN_REVIEW |
| 下发时机器人已占用 | ASSIGN_CONFLICT |
| 网络超时 | Command → UNKNOWN，按原 commandId 查询 |
| 机器人安全拒绝 | 不绕过，暂停并展示原因 |
| 重复 Event | eventId 唯一约束后忽略 |
| RAG 无证据 | 不回答内部事实 |
| 实时工具超时 | 明确降级，不用模型记忆补写 |

## 附录 F：实现顺序与源码核对入口

建议顺序：基础实体与 Task 闭环 → Planning Agent → 命令可靠执行 → G1 真机接入 → QA Agent → Intent 与动作 Agent → 外围能力。

已有机器人代码核对入口：

- `bot_mind/src/mcp/http_transport.py` 与 `src/mcp/service.py`：`tools/list`、`tools/call` 入口和 Tool 分发；
- `bot_mind/src/mcp/tools/navigate_to.py`：实际点位导航 Tool `navigate_to`；
- `bot_mind/src/mcp/tools/booth_show.py`：当前展台讲稿读取与 TTS Tool `booth_show`；
- `bot_mind/src/mcp/tools/play_named_action.py`：命名动作 Tool `play_named_action`；
- g1_base/g1_base/g1_control_server.py：ROS2 控制入口、Service/Action、状态与蹲下保护；
- g1_base/g1_base/unitree_sdk_bridge.py：Worker、逐行 JSON、requestId、串行保护、stderr pump；
- g1_teach_v2/snapshot_io.py：关键姿态；
- g1_teach_v2/motion_io.py：连续轨迹；
- g1_teach_v2/script_runner.py：复合脚本；
- g1_base/g1_base/navigation_manager.py：导航运行管理。

---

## 附录 G：展台容量与后续扩展

### G.1 展台容量、候补与等待体验

R1 正在 B 讲解，R2 下一站也是 B 时，R2 不能先过去。每个 Task 对目标展台只有一条 ExhibitAllocation：

```text
WAITING  候补，不占容量
RESERVED 已预约，短时占容量
OCCUPIED 已到达并占用
RELEASED 已离开
```

同一记录以状态字段演进，不另建重复的候补表。

```text
R2 请求去 B
→ Java 发现 R1 OCCUPIED
→ R2 进入 WAITING，前端显示候补
→ R2 留在 A 开放问答或播备用讲稿
→ R1 完成当前问题并提示前往下一站
→ R1 离开且清场确认
→ 同一事务释放 R1、将首个候补改为 RESERVED
→ R2 再校验预约和控制权后导航
```

默认冲突处理是 Java 状态机，不经过 Agent。只有要判断“换哪个展台更符合偏好”时才有限重规划。强制清场也不能绕过安全确认和工作人员策略。

### G.2 后续扩展

- 有限重规划：展台长期不可用时，用剩余 Step 和最新候选重新生成草案；
- 巡检复用：复用 Task/Plan/Step/Command 主干，巡检指标另建模；
- 跨楼层接力：增加换层点、能力和人工交接；
- 动态 ETA：有真实导航和排队数据后再建模，不能由 Agent 猜。

这些属于 P1/P2，不占用核心项目介绍时间。
