# 多机器人中央调度平台 V2：校招自学与项目面试手册

> **定位**：围绕简历内容编写的 V2 目标实施方案。它说明系统应该怎样实现、为什么这样设计，以及面试时怎样讲清楚；不代表下文所有 V2 能力都已在原项目上线。
>
> **项目边界**：2 台机器人、单展厅、模块化单体、PostgreSQL、Spring Boot、Spring AI。bot_mind 与 g1_base 是已有机器人侧代码；本文重点设计 Java 中央平台和智能体，并解释它们如何接入机器人。

## 0. 先看这里：这份文档应该怎么学

### 0.1 一句话介绍与最简主线

接待员创建参观任务，中央规划 Agent 建议机器人和路线，工作人员审核后由 Java 平台逐步下发导航、讲解和动作命令，再根据机器人事件推进任务，形成可查询、可重试、可人工接管的闭环。

```text
创建接待任务
    ↓
中央规划 Agent → PlanDraft → Java Validator
    ↓
人工审核
    ↓
分配 Robot，生成 Plan / PlanStep
    ↓
下发 RobotCommand
    ↓
bot_mind / G1ControlServer
    ↓
导航 / 讲解 / 动作
    ↓
RobotEvent
    ↓
Java 更新步骤和任务进度
```

先记住三个边界：

1. **模型提出建议**，不直接改任务状态，也不直接控制硬件。
2. **Java 保存事实并作决定**，负责校验、事务、权限、幂等和状态推进。
3. **机器人执行并回报结果**，路径规划和硬件安全留在机器人侧。

### 0.2 简历与章节映射

| 简历内容 | 对应章节 | 掌握等级 |
|---|---|---|
| Spring Boot 多机器人中央调度平台 | 第一部分 | 必须 |
| 中央规划 Agent、结构化输出、工具调用 | 第二部分 | 必须 |
| 状态跟踪、命令去重、超时重试、人工接管 | 第 3～4 章 | 必须 |
| G1 动作编排与执行 | 第三部分 | 必须 |
| QA Agent、RAG、工具调用、多轮上下文 | 第四部分 | 重点 |
| 意图识别、自然语言机器人控制 | 第五部分 | 理解 |
| 展台候补、认证、安全、部署 | 第六部分与附录 | 了解 |

### 0.3 四级学习优先级

**第一优先级 ⭐⭐⭐**

- 中央调度基础平台：Robot / Task / Plan / PlanStep / RobotCommand / RobotEvent。
- 中央规划 Agent：PlanEvidence → PlanDraft → Validator → Reviser → 人工审核。
- G1 动作模块：Java → bot_mind → G1ControlServer → Python Worker → Unitree SDK。

**第二优先级 ⭐⭐**

- 知识问答 Agent：请求级工具、RAG、ChatMemory、证据校验和隔离。

**第三优先级 ⭐**

- 意图识别 ChatClient 和 Robot Control Agent，第一遍理解职责与调用链即可。

**第四优先级：第一次可跳过**

- 第六部分的扩展调度；
- 附录中的认证、设备安全、部署、完整表结构和完整状态机。

面试时先讲能用代码、测试或验收材料证明的内容，再用“如果继续深化，我的 V2 设计是……”引出增强项。本文的“目标”“建议”“V2”均表示设计方案。

---

# 第一部分：中央调度基础平台 ⭐⭐⭐

## 1. 项目到底解决什么问题

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

## 2. 最小业务模型

| 对象 | 一句话解释 | 典型字段 |
|---|---|---|
| Robot | 一台可被分配的机器人及其最新业务状态 | robotId, onlineStatus, workStatus, areaCode |
| Task | 一批访客的一次完整接待任务 | taskId, requirement, status, assignedRobotId |
| Plan | Task 经人工审核后的执行路线 | planId, taskId, version, status |
| PlanStep | 路线中的具体步骤，如“去 A03 并讲解” | stepId, type, targetCode, sequence, status |
| RobotCommand | Java 发给机器人的一次设备命令 | commandId, stepId, type, payload, status |
| RobotEvent | 机器人回传的执行事实 | eventId, commandId, type, occurredAt |

```text
Robot 1 ─ n Task
Task  1 ─ 1 Plan
Plan  1 ─ n PlanStep
PlanStep 1 ─ n RobotCommand
RobotCommand 1 ─ n RobotEvent
```

Step 和 Command 不能合并：Step 表达业务目标，一次“导航到 A03”可能因可重试错误产生两条 Command；Step 仍是同一个目标。

> **本章必须会**：解释六个对象，并说清 Step 是目标、Command 是调用、Event 是事实。

## 3. 一个 Task 是怎么执行的

```text
Task CREATED → 生成 PlanDraft → 人工审核 → Plan APPROVED
→ 事务内分配 Robot → Task RUNNING → 执行 Step 1
→ Command → Event → Java 更新状态 → 下一 Step
→ 全部成功 → Task COMPLETED
```

- LLM 只生成草案、意图或工具参数，不能把 Task 改成 RUNNING。
- 工作人员审核计划、确认下发、人工接管。
- Java 是业务事实中心，根据状态机改变 Task、Step、Command。
- 机器人回传 COMMAND_STARTED、NAVIGATION_SUCCEEDED 等事实事件。

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

数据库锁只保护短事务，不在网络请求期间持有。先提交 Command，再调用机器人，响应或异步 Event 用新事务更新。

## 4. 命令可靠性：幂等、超时与人工接管

Java 给每条命令唯一 commandId。机器人收到相同 commandId 时，不再次执行，而是返回保存的状态或结果。

```text
Java 发 C100 → 网络超时 → 不知道是否执行
Java 重发 C100 → 机器人查到 C100 已接收 → 不重复移动/挥手
```

只比较命令类型不够，因为连续两次合法挥手必须允许。机器人应保存 commandId、payloadHash 和结果：同 ID 同参数返回历史结果，同 ID 不同参数拒绝。

创建 RobotCommand 与 Outbox 待发送记录放在同一事务；后台发送器轮询 Outbox。Java 即使在提交后、发送前重启，命令仍可恢复发送，当前规模无需引入消息队列。

请求超时先进入 UNKNOWN，因为“没收到结果”不等于“没执行”：

1. 按 commandId 查询机器人侧状态；
2. 仅对明确幂等、业务允许的命令重发原 ID；
3. 仍不确定则暂停 Step 并人工接管；
4. 不能换新 ID 盲目重试移动或动作。

接管时 Task 进入 PAUSED_MANUAL，Java 停止产生新命令并请求机器人停止/取消。进程退出和网络断开都不能证明机器人已安全停止，必须等待设备状态或现场确认。

> **本章必须会**：解释 commandId 去重、同 ID 参数校验、UNKNOWN，以及哪些错误不能自动重试。

---

# 第二部分：中央规划 Agent ⭐⭐⭐

## 5. 为什么需要中央规划 Agent

用户可能说：“带一批学生参观，希望多看 AI 互动项目，必须经过 A03，最好少走回头路。”

Java 擅长在线、空闲、区域、能力、展台开放、mustVisit、avoid、maxStops 等硬事实；LLM 擅长理解“学生”“互动”“AI 主题”“少走回头路”等软偏好。边界是：**Java 管硬约束，模型处理语义偏好，Java 再验证结果。**

## 6. Planning Agent 总流程

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

## 7. PlanEvidence：模型允许使用的事实

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

## 8. Planning Tool 只补充语义资料

工具可查询展台主题、适合人群、互动特征和业务背景，不能判断机器人在线、空闲或占用。

```java
@Tool(description = "查询展台主题、受众与展示特点，用于路线偏好判断")
public PlanningSnippetResult searchPlanningKnowledge(String query) {
    return planningKnowledgeService.search(query);
}
```

工具返回 snippetId。模型若引用知识片段，PlanDraft 必须回传对应 ID，Java 才能检查来源。

## 9. PlanDraft 与结构化输出

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

JSON 是传输文本，DTO 是 Java 接收对象，Schema 描述字段和类型，Bean Validation 检查必填与基本结构。优先使用模型或框架的结构化输出约束，再严格解析；可清理外围 Markdown 围栏，但不能用“删逗号、猜字段”悄悄修业务内容。

## 10. Java Validator：能解析不等于能执行

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

## 11. Planner → Validator → Reviser

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

最多 3 次模型尝试：一次 Planner，加至多两次 Reviser。首次合法立即结束；候选为空、mustVisit 与 avoid 冲突等明确无解情况直接人工处理。

它可称“有限反思式修订”，但不是自由运行的 Reflection Agent：反馈来自确定性 Java Validator，次数有上限，输出不能越过人工审核。

## 12. 下发前再次检查并原子分配

草案生成后 R2 可能已被占用。点击下发时 Java 重新查询，并在事务中条件更新：

```sql
UPDATE robot
SET work_status = 'ASSIGNED', current_task_id = :taskId
WHERE robot_id = :robotId
  AND online_status = 'ONLINE'
  AND work_status = 'IDLE'
  AND area_code = :requiredArea;
```

影响 1 行才成功；0 行返回 ASSIGN_CONFLICT，重新规划或人工处理。不能静默换机器人，因为人工审核的是“机器人 + 路线”的整体。

> **本章必须会**：白板画出 PlanEvidence → PlanDraft → Validator → 至多两次 Reviser → 人工审核 → 最新状态校验 → 原子分配。

---

# 第三部分：G1 动作编排与执行 ⭐⭐⭐

## 13. G1 控制调用链

```text
Java 中央平台
  ↓ commandId + 业务命令
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

- Java 决定业务步骤并持久化命令；
- bot_mind 承接机器人本机语音、讲解与技能；
- G1ControlServer 是 ROS2 控制入口，提供导航 Action、动作/移动/停止 Service 并发布状态；
- RobotController 组合导航、运动和安全状态；
- UnitreeSdkBridge / Worker 隔离 SDK。

Robot Control Agent 是 Java 的自然语言技能选择层；本章是实际执行层。前者提出“调哪个技能及参数”，后者保证真正、安全、可取消地执行。

## 14. 为什么使用独立 Python Worker

现有 UnitreeSdkBridge 启动 Python 子进程，通过 stdin/stdout 逐行 JSON：

```json
{"id":41,"command":"loco_move","vx":0.2,"vy":0.0,"wz":0.0}
{"id":41,"ok":true,"result":{}}
```

这样可以隔离 SDK 依赖与崩溃，用 requestId 对齐响应，用 stdin 锁和请求锁避免并发串线，用独立线程消费 stderr 以免管道堵塞。底盘高频指令采用“只保留最新值 + 限频”，停止指令优先。

目标实现还要补充请求超时、取消和 Worker 健康检查。杀掉 Worker 只表示进程结束，不能证明机器人停稳。

## 15. snapshot / motion / script

- **snapshot**：单个关键姿态，如抬右手、指向左侧、恢复；从当前姿态平滑插值过去。
- **motion**：多帧带时间的连续轨迹，如完整挥手。
- **script**：把 snapshot、motion、等待、播报、移动编成完整表演。

```text
script：向前一步 → 播报欢迎语 → wave motion → 等待 1 秒 → 转身
```

三层让关键姿态可组成不同动作，动作又可复用到多段讲解脚本；关节数据与业务流程也能分别维护。

## 16. 动作互斥和导航协同

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

> **本章必须会**：解释五层调用链、Worker 隔离、三层动作模型，以及导航和动作为什么互斥。

---

# 第四部分：知识问答 Agent ⭐⭐

## 17. KnowledgeQaAgent 总流程

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

ChatModel 是底层模型连接；ChatClient 是组合 Prompt、Tool、Advisor 和输出契约的调用入口。ChatClient 构建时确定模型，不在每次请求里随意切换。

## 18. 请求级 QaTools

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

## 19. ChatMemory 与会话边界

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

## 20. RAG、容错与可信回答

```text
已审核文档 → Chunk → Embedding → pgvector
→ exhibitCode + knowledgeVersion 过滤
→ 相似度 TopK → Evidence → LLM
```

先做元数据过滤，再做向量检索。切分大小、TopK 和阈值应通过真实问答集评估。

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

> **本章必须会**：解释请求级工具、TaskStep 会话、RAG 过滤和 evidenceId 各解决什么问题。

---

# 第五部分：意图识别与 Robot Control Agent ⭐

## 21. 规则优先，复杂语义再分类

“停止”“下一站”等明确指令由 Java 规则直接处理；下一站仍需校验 Task、Robot 和目标展台。未命中规则的复杂文本才进入无工具、低温度、结构化输出的 Intent ChatClient：

```text
ROBOT_CONTROL / KNOWLEDGE_QA / CENTRAL_PLANNING / OTHER
```

分类失败或置信不足时澄清，不能猜测具有副作用的路由。

## 22. Robot Control Agent

“向前走一点，然后挥手”被映射为白名单技能：

```json
{"actions":[
  {"tool":"move_robot","args":{"distanceMeters":0.3}},
  {"tool":"play_named_action","args":{"name":"wave"}}
]}
```

```text
自然语言
→ Robot Control Agent 选择技能和参数
→ Java 校验权限、参数、状态、控制权
→ RobotCommand
→ bot_mind / G1ControlServer
→ G1 模块执行并回传
```

模型不能拥有任意 URL、Shell 或 SDK 权限。Robot Control Agent 负责理解并提出技能调用；G1 模块负责实际执行和硬件安全。

---

# 第六部分：外围能力和扩展（第一次可跳过）

## 23. 展台容量、候补与等待体验

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

## 24. 后续扩展

- 有限重规划：展台长期不可用时，用剩余 Step 和最新候选重新生成草案；
- 巡检复用：复用 Task/Plan/Step/Command 主干，巡检指标另建模；
- 跨楼层接力：增加换层点、能力和人工交接；
- 动态 ETA：有真实导航和排队数据后再建模，不能由 Agent 猜。

这些属于 P1/P2，不占用核心项目介绍时间。

---

# 第七部分：大厂校招面试题

## 25. 基础平台

### Q1：为什么同时设计 Step、Command、Event？

**推荐回答：** Step 表示业务目标，Command 表示一次设备调用，Event 是执行事实。一个 Step 可能产生多条重试 Command，一条 Command 又有开始、进度、结果事件，拆开才能审计和恢复。

**追问：** 延迟旧事件怎么处理？检查 commandId、当前状态和合法状态转换。

**一句话记忆：** Step 是目标，Command 是调用，Event 是事实。

### Q2：幂等是不是重复命令不再执行？

**推荐回答：** 对同一 commandId 是。机器人保存 payloadHash 和结果；同 ID 同参数返回历史结果，同 ID 不同参数拒绝。两次正常挥手使用不同 ID。

**追问：** 超时重发用什么 ID？必须用原 ID。

**一句话记忆：** 同一次不重做，不同次仍可执行。

### Q3：为什么超时是 UNKNOWN？

**推荐回答：** 平台没收到响应时，机器人可能已执行。先查询、必要时按原 ID 幂等重发，仍不确定就暂停并人工接管。

**追问：** 哪些不能自动重试？参数非法、资源冲突、安全拒绝和非幂等副作用。

**一句话记忆：** 没收到结果，不等于没有执行。

## 26. Planning Agent

### Q4：它为什么不是普通 Chatbot？

**推荐回答：** 它接收 Java 准备的事实，按需查询规划知识，输出结构化可执行草案，经业务 Validator 后有限修订并进入人工审核。模型做语义规划，Java 掌握状态和执行权。

**追问：** 为什么不让模型查机器人在线状态？强一致事实由 Java 直接查更可靠。

**一句话记忆：** Agent 规划，Java 决策和执行。

### Q5：JSON 正确但内容错误怎么办？

**推荐回答：** Schema 和 Bean Validation 保证能解析，业务 Validator 再检查候选、重复、必到和禁入。错误反馈 Reviser，至多两次；无解或持续失败转人工。

**追问：** Java 为什么不直接删重复展台？它知道哪里错，不一定知道怎样改仍符合偏好。

**一句话记忆：** 结构校验保证能读，业务校验保证能用。

### Q6：规划为什么不锁机器人？

**推荐回答：** 草案可能被拒绝，提前锁定会浪费资源。审核下发时重新查状态，再用条件更新原子完成 IDLE → ASSIGNED；冲突显式返回，不能静默换机器人。

**追问：** 为什么不能静默换？审核的是机器人和路线整体。

**一句话记忆：** 规划是建议，下发才占资源。

### Q7：修订算 Reflection Agent 吗？

**推荐回答：** 广义是反思式修订，严格说不是独立开放的 Reflection Agent。反馈来自确定性 Validator，总共最多三次模型尝试，持续失败转人工。

**追问：** 为什么不是固定三次？首次合法即结束，无解也立即停止。

**一句话记忆：** 有限校验反馈，不是无限自我反思。

## 27. G1 动作模块

### Q8：为什么 Unitree SDK 放独立 Worker？

**推荐回答：** 隔离 SDK 依赖、慢调用和崩溃。逐行 JSON 通信，requestId 对齐，锁保证串行，独立线程消费 stderr。

**追问：** 杀 Worker 是否等于机器人已停？不是，要靠停止指令和设备状态确认。

**一句话记忆：** Worker 隔离 SDK，安全停止仍需确认。

### Q9：snapshot、motion、script 为什么三层？

**推荐回答：** snapshot 是关键姿态，motion 是连续轨迹，script 是动作、等待、播报的业务编排。分层便于素材复用并隔离关节数据与业务流程。

**追问：** 为什么动作与导航互斥？两个控制源同时写底盘或姿态会不可预测。

**一句话记忆：** 姿态组成动作，动作组成表演。

### Q10：cancel 和 stop 有什么区别？

**推荐回答：** cancel 结束当前目标；stop 还要立即发送安全停止。取消后需发布状态、释放控制权，Java 再决定跳过、重试或人工处理。

**追问：** 结束线程够吗？不够，线程状态不是硬件状态。

**一句话记忆：** cancel 管任务，stop 管安全停止。

## 28. QA Agent

### Q11：RAG 为什么做成 Tool？

**推荐回答：** 展台问题需要 RAG，天气需要天气工具，寒暄不需要。模型决定是否查，Java 绑定展台和知识版本，控制能查什么。

**追问：** 模型内置联网为何不够？平台还要控制来源、超时、审计、结构和降级。

**一句话记忆：** 模型决定是否查，Java 决定能查什么。

### Q12：ChatMemory 和 QaTools 有什么区别？

**推荐回答：** ChatMemory 保存同一 TaskStep 对话，理解“它”；请求级 QaTools 绑定本轮机器人、任务、展台和知识版本，限制数据访问。

**追问：** 换展台为何换 conversationId？避免语义污染。

**一句话记忆：** Memory 管聊过什么，Tools 管允许查什么。

### Q13：如何防止伪造知识来源？

**推荐回答：** Java 记录本轮工具真实 evidenceId，模型结构化返回引用，播报前做集合校验；无证据不回答内部事实。

**追问：** Prompt 要求引用够吗？不够，Prompt 是软约束。

**一句话记忆：** 证据由工具产生，引用由 Java 验真。

## 29. 其他

### Q14：意图识别为什么不配工具？

**推荐回答：** 它只分类，目标是快和稳定。明确命令走规则，复杂文本才四分类；工具越多越慢，也扩大权限。

**追问：** 低置信度怎么办？澄清，不猜副作用意图。

**一句话记忆：** 路由器只路由，专业 Agent 才用工具。

### Q15：两台机器人为什么还做并发控制？

**推荐回答：** 人少也可能同时下发或争抢同一展台。数据库条件更新、唯一约束和短事务足以守住不变量，不需要分布式锁。

**追问：** 扩到十几台要重写吗？保留状态和约束，再按吞吐决定基础设施。

**一句话记忆：** 用最小机制守住并发不变量。

---

# 第八部分：附录

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
                              ├→ FAILED
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

建议顺序：核心实体与审核 → 命令/事件闭环 → Planning Agent → G1 真机接入 → QA Agent → 意图识别与 Robot Control Agent → 外围能力。

已有机器人代码核对入口：

- g1_base/g1_base/g1_control_server.py：ROS2 控制入口、Service/Action、状态与蹲下保护；
- g1_base/g1_base/unitree_sdk_bridge.py：Worker、逐行 JSON、requestId、串行保护、stderr pump；
- g1_teach_v2/snapshot_io.py：关键姿态；
- g1_teach_v2/motion_io.py：连续轨迹；
- g1_teach_v2/script_runner.py：复合脚本；
- g1_base/g1_base/navigation_manager.py：导航运行管理。

---

## 最后的面试表达边界

```text
我负责的业务问题
→ 六个核心对象和任务执行链
→ Planning Agent 中 Java 与 LLM 的边界
→ 命令可靠性和状态闭环
→ G1 动作执行链与互斥
→ QA Agent 作为 AI 增强
→ V2 仍计划完善的生产能力
```

不要用技术名词数量证明复杂。面试官更关心状态由谁维护、失败如何恢复、并发不变量怎样保证、模型为何不会越权，以及你能否区分真实实现与目标设计。
