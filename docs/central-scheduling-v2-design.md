# 多机器人中央调度平台 V2：校招自学与项目面试手册

> **定位**：围绕简历内容编写的 V2 目标实施方案。它说明系统应该怎样实现、为什么这样设计，以及面试时怎样讲清楚；不代表下文所有 V2 能力都已在原项目上线。
>
> **项目边界**：2 台机器人、单展厅、模块化单体、PostgreSQL、Spring Boot、Spring AI。bot_mind 与 g1_base 是已有机器人侧代码；本文重点设计 Java 中央平台和智能体，并解释它们如何接入机器人。

## 0. 阅读指南

### 0.1 项目一句话介绍

接待员创建参观任务，中央规划 Agent 建议机器人和路线，工作人员审核后由 Java 平台逐步下发导航、讲解和动作命令，再根据机器人事件推进任务，形成可查询、可重试、可人工接管的多机器人接待闭环。

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
→ Planning Agent
→ PlanDraft
→ Java Validator
→ 人工审核
→ 点击下发并原子绑定 Robot
→ Plan / PlanStep
→ Step Executor 或动作 Agent
→ Java ToolCallback / CommandService
→ 短事务写入 RobotCommand + CommandOutbox
→ COMMIT 后由 CommandDispatcher 发送
→ MCP tools/call
→ bot_mind
→ G1ControlServer / RobotController
→ RobotEvent
→ Java 更新 Command / Step / Task
→ 下一 PlanStep
→ Task COMPLETED
~~~

没有动态要求时由 Step Executor 执行确定性模板；存在现场自然语言要求时由动作 Agent 动态编排当前机器人的 bot_mind Tools。

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
| RobotCommand | Step Executor 或动作 Agent 经 CommandService 发起的一次有副作用的 bot_mind Tool 调用 | commandId, stepId, toolName, payload, status |
| RobotEvent | 机器人针对某条 RobotCommand 回传的执行事实 | eventId, commandId, type, occurredAt |

```text
Robot 1 ─ n Task（历史上可以执行多个 Task）
同一时刻，一个 Robot 最多执行一个活动 Task
Task  1 ─ 1 Plan
Plan  1 ─ n PlanStep
PlanStep 1 ─ n RobotCommand
RobotCommand 1 ─ n RobotEvent
```

这组关系表达的是历史记录，不表示机器人可以同时执行多个活动任务。

PlanStep 记录业务目标，不把正常接待拆成 `NAVIGATE / SPEAK / WAVE / WAIT` 等一串中央步骤。以 `S3 = VISIT A03` 为例，它在执行时可能产生多条命令：

```text
PlanStep S3：VISIT A03
├─ Command C101：navigate_to(waypoint_name = "A03")
├─ Command C102：play_named_action(action_name = "wave")
└─ Command C103：booth_show(user_text = "开始讲解展台")
```

因此 `PlanStep 1 ─ n RobotCommand` 是核心关系。C101、C102 成功只说明导航和挥手完成；只有 `VISIT A03` 的整体完成条件满足，Java 才能把 S3 标记为 `SUCCEEDED`。


## 1.3 一个 Task 从创建到完成

```text
Task CREATED → 生成 PlanDraft → 人工审核 → Plan APPROVED
→ 事务内分配 Robot → Task RUNNING → 执行 Step 1
→ Step Executor / 动作 Agent → CommandService → Command + Outbox
→ CommandDispatcher → tools/call → Event → Java 更新状态 → 下一 Step
→ 全部成功 → Task COMPLETED
```

- LLM 只生成草案、意图或工具参数，不能把 Task 改成 RUNNING。
- 工作人员审核计划、确认下发、人工接管。
- Java 是业务事实中心，根据状态机改变 Task、Step、Command。
- 机器人回传 COMMAND_STARTED、NAVIGATION_SUCCEEDED 等事实事件。

## 1.4 命令与事件为什么要分开

可以把三者理解为：

~~~text
Step    = 业务目标
Command = 一次设备调用
Event   = 执行事实
~~~

Step 和 Command 不能合并：Step 表达业务目标，一次 `VISIT A03` 可以依次产生导航、动作和讲解三条 Command；单条命令失败后的重试也会留下独立执行记录，但 Step 仍是同一个业务阶段。

**Event 是输入事实，Java 状态机是裁判。** Java 要检查 eventId、commandId、机器人身份和当前状态，不能让重复或延迟事件推进错误任务。

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
    stepService.advanceIfReady(command.stepId());
    taskService.finishIfAllStepsDone(command.taskId());
}
```

数据库锁只保护短事务，不在网络请求期间持有。先在同一短事务提交 RobotCommand 与 CommandOutbox，再由 CommandDispatcher 调用机器人；响应或异步 Event 用新事务更新。

## 1.5 命令可靠执行

每一次真正对机器人产生副作用的 Tool Calling 都必须先对应一条 RobotCommand。中央 Java 平台生成唯一 commandId，用于幂等、日志、Outbox、Tool 调用追踪、RobotEvent 关联和 `UNKNOWN` 对账；V2 目标是机器人侧在收到相同 commandId 时不重复执行，而是返回已保存的状态或结果。

```text
Java 发 C100 → 网络超时 → 不知道是否执行
Java 重发 C100 → 机器人查到 C100 已接收 → 不重复移动/挥手
```

只比较命令类型不够，因为连续两次合法挥手必须允许。机器人侧适配层应保存 commandId、payloadHash 和结果：同 ID 同参数返回历史结果，同 ID 不同参数拒绝。

```text
Step Executor / 动作 Agent
        ↓
Java ToolCallback / CommandService
        ↓
短事务：RobotCommand + CommandOutbox
        ↓ COMMIT
CommandDispatcher
        ↓ MCP tools/call
目标 Robot 的 bot_mind
        ↓ tool_result / RobotEvent
Java 更新 Command / Step
```

正常情况下，事务提交后立即触发 CommandDispatcher 尝试发送，不故意等待下一轮定时扫描。Outbox Poller 只承担恢复：如果 RobotCommand 与 CommandOutbox 已提交，而 Java 在真正执行 `MCP tools/call` 前崩溃，服务恢复后 Poller 找出未发送记录，并使用原 commandId 交给同一个 CommandDispatcher 恢复发送。**Outbox 不是为了把正常机器人调用变成慢速定时任务，而是保证数据库已经记录命令、但进程在发送前崩溃时仍可恢复。** 当前规模无需引入消息队列。

动作 Agent 的 Tool Calling 与 Step Executor 的确定性调用都经过这条 CommandService / CommandDispatcher 链，不能绕过 RobotCommand 与 Outbox 直连 MCP。当前 bot_mind 的真实 MCP Tool 参数未必都原生包含 commandId，因此 V2 只要求 Java 调用链能把 commandId 与机器人侧执行关联；具体可通过 MCP 参数、调用上下文或机器人侧适配层透传，以实际接口实现为准，不能把尚未存在的参数写成当前能力。

请求超时先进入 UNKNOWN，因为“没收到结果”不等于“没执行”：

1. 按 commandId 查询机器人侧状态；
2. 仅对明确幂等、业务允许的命令重发原 ID；
3. 仍不确定则暂停 Step 并人工接管；
4. 不能换新 ID 盲目重试移动或动作。

Event 仍由 1.4 节的事件处理器落库和推进状态；本节重点是在重复、超时、乱序和结果未知时仍能守住这条执行链。

接管时 Task 进入 PAUSED_MANUAL，Java 停止产生新命令并请求机器人停止/取消。进程退出和网络断开都不能证明机器人已安全停止，必须等待设备状态或现场确认。

## 1.6 本部分小结

~~~text
Task              一次完整接待任务
Plan              人工审核后的业务路线
PlanStep          一个业务阶段，例如 VISIT A03
RobotCommand      Step Executor / 动作 Agent 经 CommandService 记录的一次有副作用 Tool 调用
RobotEvent        机器人对该次调用返回的执行事实
commandId         标识同一次命令，支撑幂等、追踪与 UNKNOWN 对账
UNKNOWN           表示结果暂时无法确认
~~~

Java 是任务事实中心；机器人负责执行并回报。正常链路和异常恢复使用同一组 Command、Event 与状态机，而不是两套互不相干的流程。

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
→ Step Executor 开始执行当前 PlanStep
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

> **这一部分要掌握什么**：业务命令如何下沉到机器人、Python Worker 为什么存在、三层动作体系怎样复用，以及多个控制源如何安全协作。

## 3.1 从 Java 到机器人的完整调用链

```text
Step Executor / 动作 Agent
  ↓ Java ToolCallback / CommandService
短事务：RobotCommand + CommandOutbox
  ↓ COMMIT 后由 CommandDispatcher 发送
MCP tools/call（关联 commandId）
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
```

## 3.2 G1ControlServer 与 RobotController

G1ControlServer 统一承接需要持续反馈的导航 Action、短时控制 Service 和运行状态发布；RobotController 再把这些上层调用收敛到导航、底盘、手臂和安全状态。正文不枚举所有接口，只保留职责边界：

- Java 决定业务步骤并持久化命令；
- bot_mind 承接机器人本机语音、讲解与技能；
- G1ControlServer 是 ROS2 控制入口，提供导航 Action、动作/移动/停止 Service 并发布状态；
- RobotController 组合导航、运动和安全状态；
- UnitreeSdkBridge / Worker 隔离 SDK。

动作 Agent（文档中的 Robot Control Agent）和确定性的 Step Executor 都是 bot_mind Tool 的调用方：固定流程由 Step Executor 发起，现场要求改变当前 Step 的执行方式时由动作 Agent 动态编排。两者都先进入 Java ToolCallback / CommandService，完成参数门禁和机器人选择，并在短事务内写入 RobotCommand 与 CommandOutbox；事务提交后再由同一个 CommandDispatcher 执行 `tools/call`。本章描述工具调用之后的实际执行层，它负责让动作真正、安全、可取消地执行。

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

Java 记录并校验业务命令，bot_mind 提供机器人 Tools，G1ControlServer 与 RobotController 统一机器人本机控制，UnitreeSdkBridge/Worker 隔离 SDK。snapshot、motion、script 解决动作素材复用；navigation、manual、script 的互斥、取消和状态同步守住执行安全。

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

“停止”“下一站”等明确指令由 Java 规则直接处理；下一站仍需校验 Task、Robot 和目标展台。未命中规则的复杂文本才进入无工具、低温度、结构化输出的 Intent ChatClient：

```text
ROBOT_CONTROL / KNOWLEDGE_QA / CENTRAL_PLANNING / OTHER
```

分类失败或置信不足时澄清，不能猜测具有副作用的路由。

## 4.8 动作 Agent（Robot Control Agent）

> **项目经历边界**：本节用于解释中央平台与机器人控制链的完整协作方式。动作 Agent 不是本文作者实际主责开发的模块；以下内容属于 V2 架构理解和面试扩展，不能表述成“我实现了动作 Agent”。

### 4.8.1 它到底解决什么问题

Planning Agent 决定“去哪”，动作 Agent 决定“当前业务 Step 具体怎样完成”。例如正式计划只保存：

```text
Task T100
Robot R1
PlanStep S3：VISIT A03
```

动作 Agent 根据当前 PlanStep、R1 最新状态、现场自然语言要求以及 R1 当前暴露的 Tools，决定调用哪些工具、参数是什么、先后顺序怎样、何时等待以及何时继续。它不负责全局路线、Task 状态机、Nav2、TTS 实现、讲稿存储或 Unitree SDK。

PlanStep 只记录 `VISIT A03` 这样的业务目标。A03 的 waypoint、讲稿、TTS 与动作素材由机器人侧维护，中央平台不把每句播报、每次挥手和每帧关节轨迹拆成独立 Step。

### 4.8.2 ExecutionContext 与 bot_mind Tools

动作 Agent 每次处理当前 Step 时，需要一份只读执行上下文。它可以由现有 Task、PlanStep、Robot 和最近 Command/Event 临时组装，不要求新增数据库表：

```java
public record ExecutionContext(
    String taskId,
    String stepId,
    String robotId,
    String stepType,
    String targetCode,
    String currentRobotState,
    String executionPhase,
    String temporaryInstruction
) {}
```

它回答的是：当前哪个 Task 和 Step、控制哪台机器人、目标点位是什么、机器人现在在哪里、该 Step 已完成到哪里、现场有没有临时要求。

机器人能力的定义来自每台机器人上的 bot_mind。Java/Spring AI 是 MCP Client 和 Tool Consumer，通过 `tools/list` 获取工具定义；实际 `tools/call` 必须经过下文的 ToolCallback、CommandService 和 CommandDispatcher。当前源码中的代表性工具包括：

| 能力 | bot_mind 当前真实 Tool |
|---|---|
| 点位导航 | `navigate_to`、`navigate_to_next_waypoint` |
| 位置与状态 | `get_current_waypoint`、`get_robot_state` |
| 小范围移动 | `move_distance`、`move_steps`、`rotate_robot` |
| 动作 | `play_named_action`、`execute_arm_action` |
| 展台讲解 | `booth_show`、`booth_continue`、`stop_speaking` |
| 安全停止 | `stop_robot` |

当前源码没有启用名为 `activate_waypoint` 的 MCP Tool，因此本文使用真实的 `booth_show` 表达“播放当前展台讲稿、TTS 和配置动作”。如果未来提供 `activate_waypoint`，它只能作为新的实际 Tool 名称，不能仅为文档概念虚构生产接口。

```text
动作 Agent 或 Step Executor（Tool Consumer）
  ↓ Spring AI ToolCallback
Java CommandService / CommandDispatcher
  ↓ MCP tools/call
R1 bot_mind（Tool Provider）
  ├─ navigate_to / get_current_waypoint
  ├─ move_distance / rotate_robot
  ├─ play_named_action / execute_arm_action
  ├─ booth_show / booth_continue / stop_speaking
  └─ stop_robot
```

Java 中的 RobotSkillTool 是受控 ToolCallback：它选择目标 robotId，校验权限、参数、状态和控制权，再调用 CommandService。CommandService 生成 commandId，并在短事务内记录 RobotCommand 与 CommandOutbox；提交后由 CommandDispatcher 把同一能力转发给 bot_mind。它们不重新实现导航、TTS 或机器人动作。

### 4.8.3 Tool Calling 执行循环

动作 Agent 可以在一个 Step 内进行多轮 Tool Calling，而不是“一句话、调一次工具就结束”：

```text
动作 Agent 读取 ExecutionContext
→ LLM 产生 tool_call：navigate_to(A03)
→ Java ToolCallback / CommandService 创建 C101 + Outbox
→ COMMIT → CommandDispatcher → MCP tools/call → R1 bot_mind
→ tool_result / RobotEvent → Java 更新 C101 为 SUCCEEDED
→ 结果重新进入动作 Agent
→ LLM 产生 tool_call：play_named_action(wave)
→ 同一链路创建并执行 C102
→ tool_result / RobotEvent → Java 更新 C102 为 SUCCEEDED
→ 动作 Agent 返回“需要等待现场交互”的执行结果
→ Java Task/Step 状态机校验当前活动 Step
→ Java 将 S3 更新为 WAITING_INTERACTION
```

模型根据观察到的工具结果决定下一步，这构成受限的“观察—调用—再观察”循环，所以它比只输出 `ROBOT_CONTROL` 标签的意图分类器更接近 Agent。循环仍受工具白名单、最大调用次数、超时和 Step 边界约束，不能无限自主运行。

### 4.8.4 默认执行模板与动态编排

不是所有 `VISIT` 都需要 LLM。Step Executor 先判断当前 Step 是否存在额外现场要求：

```text
PlanStep = VISIT A03
        ↓
是否存在额外自然语言要求或非标准现场状态？
       / \
     没有  有
      ↓    ↓
默认模板  动作 Agent
      ↓    ↓
navigate  动态 Tool Calling
→ booth_show   navigate → action → wait → booth_show
       \       /
 ToolCallback / CommandService
            ↓
 RobotCommand + Outbox → CommandDispatcher
            ↓
    MCP tools/call → bot_mind
            ↓
       完成当前 Step
```

默认情况下，`VISIT A03` 的确定性模板可以直接执行：

```text
navigate_to(waypoint_name = "A03")
→ 等待导航成功事件
→ booth_show(user_text = "开始讲解展台")
→ 等待讲解完成事件
→ Java 校验 VISIT 完成条件
→ S3 SUCCEEDED
```

现场用户如果说：

> 先过去，但先别讲解，到了以后跟大家挥个手，然后等我说开始再讲。

Plan 不变，S3 仍然是 `VISIT A03`；变化的是当前 Step 的执行方式：

```text
ExecutionContext：
taskId = T100
stepId = S3
robotId = R1
targetCode = A03
temporaryInstruction = 先过去、先别讲、到站挥手、等待开始

动作 Agent：
navigate_to(A03)
→ C101 / 导航成功
→ play_named_action("wave")
→ C102 / 动作成功
→ 返回“需要等待现场交互”的执行结果

Java Task/Step 状态机：
确认 T100 / S3 / R1 仍为当前活动执行上下文
→ S3 → WAITING_INTERACTION
```

此时 S3 不能标记为 `SUCCEEDED`，因为 A03 接待尚未完成。用户随后说“开始讲吧”，继续流程仍由 Java 把守：

```text
Java 确认 taskId / stepId / robotId 仍匹配当前活动 Step
→ 重新构造 ExecutionContext
→ 动作 Agent 继续 Tool Calling
→ booth_show(user_text = "开始讲解展台")
→ CommandService / CommandDispatcher 执行 C103
→ 执行结果返回
→ Java 校验 VISIT 整体完成条件
→ S3 → SUCCEEDED
→ 推进 S4 = VISIT B05
```

### 4.8.5 暂停、继续、失败与取消

`WAITING_INTERACTION` 表示 Step 仍在执行，只是在等待用户继续指令。继续请求必须携带或解析到同一个 taskId、stepId 和 robotId；若当前 Step 已被取消或任务已被人工接管，旧的“开始吧”不能恢复执行。

每次真正产生机器人副作用的 Tool Calling 对应一条 RobotCommand，每个执行事实对应 RobotEvent：

```text
C101：navigate_to(A03)         → SUCCEEDED
C102：play_named_action(wave) → SUCCEEDED
C103：booth_show(...)         → SUCCEEDED
```

单条 Tool 成功不自动等于 PlanStep 成功。Java 根据 Step 类型和临时要求检查整体完成条件。工具失败时，动作 Agent 只能在策略允许的范围内改参、停止或等待；它不能自行改写后续路线。网络超时仍进入 `UNKNOWN` 并按 commandId 对账。取消时优先调用 bot_mind 已有的 `stop_robot`、`stop_speaking` 等受控停止能力，再由 Java 根据事件更新 Command 和 Step。

还要区分 ACK 与最终完成：如果现有 bot_mind Tool 只表示“已受理”，Java 不能立即生成 `SUCCEEDED` 事件；V2 需要等待能够关联 commandId 的最终状态或人工确认。

### 4.8.6 与 Planning Agent、Java 和 bot_mind 的职责边界

```text
Planning Agent：“去哪？”
A03 → B05 → C02
        ↓
PlanStep：VISIT A03
        ↓
当前 Step 怎么完成？
        ↓
默认模板 或 动作 Agent
        ↓
ExecutionContext + 现场要求 + R1 Tools
        ↓
Tool Calling
        ↓
Java ToolCallback / CommandService
        ↓
RobotCommand + CommandOutbox
        ↓
CommandDispatcher → MCP tools/call
        ↓
navigate_to / play_named_action / booth_show
        ↓
bot_mind
        ↓
G1ControlServer / Nav2 / SDK / TTS
        ↓
RobotEvent
        ↓
Java 更新 Command / Step / Task
```

最终职责可以概括为：

```text
Planning Agent → 决定去哪，形成业务路线
动作 Agent     → 动态决定当前 Step 怎么完成
Step Executor  → 没有动态要求时执行确定性模板
bot_mind       → 定义机器人能做什么，并执行具体 Tool
Java           → 保存业务事实、实施安全门禁并推进 Task
```

动作 Agent 可以通过白名单 Tool Calling 发起机器人能力调用，但不能绕过 Tool 门禁直接访问 ROS2、Unitree SDK、Shell 或任意机器人接口，也不能修改 Task、Step 数据库状态。面试时应如实表达：“动作 Agent 不是我主责开发的模块，但因为它与我负责的中央平台和 G1 执行模块直接协作，我后续系统梳理过它的 Tool Calling 和执行上下文机制。”

## 4.9 本部分小结

~~~text
QA Agent：按问题选择 RAG / Weather / Web / 0 Tool
Intent ChatClient：只分类，不调用工具
Step Executor：没有动态要求时执行确定性模板
动作 Agent：结合 ExecutionContext 动态编排白名单 Tools
G1 执行层：真正执行技能并保障硬件安全
~~~

ChatMemory 管“之前聊过什么”，请求级 QaTools 管“当前允许查什么”；模型负责语义判断和动态工具编排，Java 负责范围、权限、参数、证据、Command/Event 和副作用校验。

---

# 第五部分：项目面试复习

> **这一部分要掌握什么**：用项目问题、设计取舍和异常处理组织回答，避免只背框架名或把 V2 目标设计说成全部已上线。

## 5.1 中央调度平台高频问题

### Q1：为什么同时设计 Step、Command、Event？

**推荐回答：** Step 表示业务目标，Command 表示一次设备调用，Event 是执行事实。一个 Step 可能产生多条重试 Command，一条 Command 又有开始、进度、结果事件，拆开才能审计和恢复。

**追问：** 延迟旧事件怎么处理？检查 commandId、当前状态和合法状态转换。

**一句话记忆：** Step 是目标，Command 是调用，Event 是事实。

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

### Q6：幂等是不是重复命令不再执行？

**推荐回答：** 对同一 commandId 是。commandId 由 Java 生成，V2 要求机器人侧适配层关联 commandId、payloadHash 和结果；同 ID 同参数返回历史结果，同 ID 不同参数拒绝。两次正常挥手使用不同 ID。现有 Tool 是否原生携带 commandId 要以真实接口为准，不能把目标设计说成已有能力。

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

**推荐回答：** Planning Agent 决定机器人和展台路线，PlanStep 保存 `VISIT A03` 这样的业务目标。动作 Agent 结合当前 ExecutionContext、机器人状态和现场自然语言要求，动态选择并组合 R1 的 bot_mind Tools，例如先 `navigate_to`，到站后 `play_named_action`，再根据用户指令决定何时 `booth_show`。Java 记录 Command/Event 并推进状态，bot_mind 和 G1 执行具体技能。

**追问：** 动作 Agent 能直接调用 Unitree SDK 或修改 Step 状态吗？不能。它可以通过白名单 MCP Tools 发起机器人能力调用，但不能绕过 Tool 门禁访问 ROS2、SDK、Shell 或任意机器人接口；业务状态只由 Java 修改。

**一句话记忆：** Planning 决定去哪，动作 Agent 决定当前 Step 动态怎么完成。

### Q17：为什么不把导航、TTS 和每个动作都写进 PlanStep？

**推荐回答：** 中央平台保存业务级计划。如果把每句 TTS、每次挥手和关节动作都拆成 Step，Plan 会与机器人内部实现强耦合。一个 `VISIT A03` 可以产生多条 RobotCommand；waypoint、讲稿、TTS 和动作素材由 bot_mind 管理，Java 只维护业务目标及执行事实。

**追问：** 多条 Command 成功是否等于 Step 成功？不一定，要检查 `VISIT` 的整体完成条件。

**一句话记忆：** Step 是业务阶段，Command 才是一次工具调用。

### Q18：什么时候不需要动作 Agent？

**推荐回答：** 如果 `VISIT A03` 始终是 `navigate_to(A03) → booth_show(...)`，Step Executor 直接执行确定性模板即可，不必为了 Agent 化再调用模型。现场出现“先挥手”“暂时别讲”“讲到一半暂停”等不能预先固定的要求时，才把当前 Step 交给动作 Agent 动态编排。

**追问：** 结构化 PlanStep 是否一定绕过动作 Agent？也不是，要看当前是否有临时要求或非标准现场状态。

**一句话记忆：** 固定流程走模板，动态现场要求走动作 Agent。

### Q19：“先过去别讲，到了挥手，等我说开始再讲”怎样执行？

**推荐回答：** 当前 Step 仍是 `S3 = VISIT A03`。动作 Agent 先调用 `navigate_to(A03)`，成功后调用 `play_named_action(wave)`，再返回“需要等待现场交互”的结果，由 Java 将 S3 更新为 `WAITING_INTERACTION`，此时不能标记成功。用户说“开始”后，Java 先确认 taskId、stepId 和 robotId 仍匹配当前活动 Step，再重建 ExecutionContext，让动作 Agent 继续调用 `booth_show`；讲解完成且 Java 校验整体条件后，S3 才进入 `SUCCEEDED` 并推进下一站。

**追问：** 其中每次调用怎样留痕？导航、挥手和讲解分别生成 C101、C102、C103，并接收各自 RobotEvent。

**一句话记忆：** 临时要求改变 Step 的执行方式，不改变已审核路线。

面试时应说明：“动作 Agent 不是我主责开发的模块，但它和我负责的中央平台及 G1 执行模块直接协作，所以我系统梳理过它的 Tool Calling 和 ExecutionContext 机制。”

## 5.7 一分钟项目介绍

我参与的是一个多机器人具身智能展厅项目，主要负责 Spring Boot 中央调度平台、中央规划 Agent，以及 G1 动作编排与执行模块。平台围绕 Robot、Task、Plan、PlanStep、RobotCommand 和 RobotEvent 建模，支持任务创建、计划审核、机器人分配、命令下发和进度查询。Planning Agent 由 Java 先准备在线、空闲、区域和展台候选，再由模型生成结构化 PlanDraft，通过业务 Validator 和有限 Reviser 修订，人工审核后才原子分配机器人。执行侧使用 commandId 幂等、UNKNOWN 对账和人工接管处理不确定结果；机器人动作由 G1ControlServer、RobotController 和独立 SDK Worker 执行。QA Agent 使用请求级工具、TaskStep 级 ChatMemory 和按需 RAG 保证多机器人问答隔离。

## 5.8 三分钟项目介绍

项目要解决的是两台机器人同时承担展厅接待时，中央平台怎样把自然语言需求变成计划，并可靠推进导航、讲解和动作。Java 平台采用模块化单体和 PostgreSQL，以 Task 表示一次接待，以审核后的 Plan 和 PlanStep 表示执行顺序，以 RobotCommand 表示一次设备调用，以 RobotEvent 表示机器人事实。LLM 不直接改状态，Java 根据事件和状态机推进任务。

规划部分采用“Java 管硬约束、LLM 管语义偏好、Java 再校验”。Java 先筛出 ONLINE、IDLE、区域和能力满足的机器人以及开放展台，组成 PlanEvidence。模型可按需查询展台主题等规划知识，输出建议机器人和路线的 PlanDraft。Schema 与 Bean Validation 保证格式能读，业务 Validator 检查候选、重复、mustVisit、avoid 和证据 ID。第一次不合法时把错误交给 Reviser，总共最多三次模型尝试；随后仍需人工审核。下发时再次查询最新状态，并用条件 UPDATE 原子完成 IDLE 到 ASSIGNED，失败显式返回 ASSIGN_CONFLICT。

可靠执行方面，每条命令有 commandId 和 payloadHash，重复请求返回历史结果；RobotCommand 与 Outbox 同事务保存，提交后 CommandDispatcher 立即尝试发送，Outbox Poller 只在进程崩溃等异常后恢复未发送记录。网络超时进入 UNKNOWN，而不是直接判失败，平台按原 commandId 查询或幂等重发，仍不确定则暂停并人工接管。G1 侧由 bot_mind 接入 G1ControlServer，RobotController 协调导航和动作，UnitreeSdkBridge 通过独立 Python Worker 隔离 SDK。动作按 snapshot、motion、script 分层，并对 navigation、manual、script 做互斥和取消。

问答部分使用共享 KnowledgeQaAgent/ChatClient 和每请求 QaTools。工具绑定 robotId、taskId、stepId、exhibitCode 和 knowledgeVersion；conversationId 以 TaskStep 隔离。模型按需选择 RAG、天气、联网或不调用工具，Java 校验本轮真实 evidenceId。Intent ChatClient 只做路由。对于 `VISIT A03` 这类业务 Step，没有临时要求时由 Step Executor 执行 `navigate_to → booth_show` 默认模板；出现“先挥手、暂时别讲”等现场要求时，动作 Agent 才结合 ExecutionContext 动态编排 bot_mind Tools。动作 Agent 不是我主责开发的模块，但我系统梳理了它与中央平台和 G1 执行层的协作边界。这样既保留模型的语义能力，也避免所有固定流程都依赖 LLM。

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
