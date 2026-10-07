---
title: 中央调度平台快速学习
description: 用一个展厅接待任务理解规划草案、业务校验、数据库落盘、机器人执行与 RAG 问答。
---

# 中央调度平台快速学习

先用一个接待任务走通系统，再按需读 [V2 可实施详细设计](/central-scheduling-v2-design)。建议第一次用 15～20 分钟读完本页，重点回答：**谁生成方案、谁保存事实、谁执行动作、结果怎样回到任务。**

::: info 阅读边界
本页是 V2 目标设计的学习摘要，与 V2 保持职责和流程一致。示例 ID、状态和数据用于理解设计，不代表所有机制都已在原项目上线。这里讲展厅机器人接待；当前巡检仓库的拍卖分配、固定工单步骤和仿真机队分配属于另一条实现链。
:::

## 1. 先看懂系统分工

接待员提出：“明天下午带初中生参观，重点看 AI 互动项目，必须经过 A03。”页面确认时间、线路、必到点等结构化条件。

| 角色 | 负责什么 | 这个例子中做什么 |
|---|---|---|
| 中央规划 Agent | 从真实候选中生成可审核的业务草案 | 建议 R1，选择 A01 → A03，调整本站接待重点 |
| Java 平台 | 提供事实、校验、落库、审核、预约、状态推进 | 检查 A03 必到，审核后保存计划，下发时占用 R1 |
| 动作 Agent | 围绕当前正式步骤选择允许的机器人 Tools | 完成 A03 的导航、讲解和必要动作 |
| 机器人侧 bot_mind / g1_base | 实际执行能力、导航和硬件控制 | 导航到 A03，完成讲解，返回执行结果 |
| QA Agent | 检索当前展台资料并回答访客问题 | 回答“这个 AI 互动项目怎么工作？” |

规划 Agent 的“步骤”是 `VISIT A03` 这样的业务目标。它不会直接生成 ROS 指令，也不会把 Task 改成运行中。动作 Agent 可以受控调用 Tools，正式任务状态始终由 Java 更新。

## 2. 七个对象，先分清再记关系

| 对象 | 一句话理解 | 是否是持久化业务对象 |
|---|---|---|
| Robot | 一台机器人及其配置、当前快照和业务占用 | 是 |
| TaskDraft | 模型提出的候选方案 DTO | DTO 本身不是数据库实体；内容保存到草案记录 |
| Task | 一次完整接待，例如本次初中生参观 | 是 |
| Plan | 本次任务审核后的路线版本 | 是 |
| PlanStep | 路线中的一个业务阶段，例如参观 A03 | 是 |
| RobotCommand | 一次有副作用的机器人 Tool 调用记录 | 是 |
| RobotEvent | 机器人对某次 Command 的异步反馈 | 收到异步反馈时保存 |

```text
TaskDraft → 校验与审核 → Task / Plan / PlanStep

Task T1
└─ Plan P1（版本 1）
   ├─ Step S1：VISIT A01
   ├─ Step S2：VISIT A03
   │  ├─ Command C1：navigate_to("A03")
   │  │  └─ Event E1：SUCCEEDED（异步执行时）
   │  └─ Command C2：booth_show(...)
   └─ Step S3：END
```

一个 Step 可以有多次 Command。导航成功只证明一次调用完成；还要完成本站接待，Java 才能判定 `VISIT A03` 成功。同步完成的调用可以直接使用 Tool Result，不必额外等待 RobotEvent。

继续查阅：[V2 §1.2 核心业务模型、§1.4 命令与事件](/central-scheduling-v2-design#_1-2-核心业务模型)。

## 3. 模型怎样生成一个可信草案

Java 先读取机器人登记资料、带时间戳的状态快照、线路、展台及默认接待描述，构成本请求的 `PlanEvidence`。规划 Agent 通过只读工具查询这些事实，按需检索展台资料，再输出 JSON。

下面是 `TaskDraft` 的示意输出。A01、A03 和 R1 都必须来自本次允许的配置：

```json
{
  "operation": "CREATE",
  "title": "初中生 AI 主题接待",
  "suggestedRobotId": "R1",
  "scheduledAt": "2026-10-08T14:00:00+08:00",
  "routeId": "F1_FORWARD",
  "audience": "初中生",
  "steps": [
    {"sequence": 1, "type": "VISIT", "targetCode": "A01", "description": "介绍人工智能基础"},
    {"sequence": 2, "type": "VISIT", "targetCode": "A03", "description": "重点介绍 AI 互动项目"},
    {"sequence": 3, "type": "END", "targetCode": null, "description": "结束接待"}
  ],
  "knowledgeIds": []
}
```

```text
JSON 文本 → 严格解析为 TaskDraft DTO
         → 字段校验：类型、枚举、长度、必填
         → 业务校验：真实目标、必到、禁入、顺序、能力
         → 通过：保存待审核草案
         → 内容错误：反馈给模型，有限修订
```

| 模型输出 | Java 怎样绑定业务 |
|---|---|
| `suggestedRobotId = R1` | 查询登记机器人，验证区域、标签和指定机器人约束 |
| `targetCode = A03` | 验证真实展台及开放状态；执行时使用配置中的导航点映射 |
| `type = VISIT` | 对应预先定义的“到站并完成接待”业务语义 |
| `description` | 保存审核后的接待重点；不能授权换目标或额外能力 |
| `knowledgeIds` | 只能引用本请求工具实际返回过的资料 ID |

JSON 合法不代表方案正确。例如模型遗漏 A03，Validator 返回 `MUST_VISIT`；生成 A99，返回 `TARGET`。最多 **1 次初次生成 + 2 次修订**；仍失败就记录错误，转人工处理。网络或数据库故障走技术错误处理，不伪装成“草案内容错误”。

模型可以结合受众选择展台、调整表达。数据库 ID、状态、版本和预约结束时间由 Java / 数据库管理。自然语言描述是否符合资料还需要内容评测和人工审核，结构校验不能证明它句句正确。

继续查阅：[V2 §2.5 TaskDraft、§2.6 Validator、§2.7 Reviser](/central-scheduling-v2-design#_2-5-taskdraft、planstep-与默认接待描述)。

## 4. 草案、审核和正式任务怎样落库

**先保存候选，再保存正式计划。** 主示例先保存 `planning_draft`；若系统已有任务创建入口，也允许先建 `Task CREATED` 并关联草案。两条路径都不会在生成草案时占用机器人。

| 时点 | 输入 → 输出 | 保存什么 | 能否执行 |
|---|---|---|---|
| 生成与校验后 | 请求、Evidence、模型输出 → 草案记录 | `planning_draft` 中的请求、证据、DTO 内容、尝试记录；通过为 `PENDING_REVIEW`，耗尽为 `NEEDS_HUMAN_REVIEW` | 不能 |
| 人工审核确认 | 待审核草案 → 正式计划 | Task、Plan、PlanStep、两小时预约，并将草案标记已应用 | 已获批准，仍须下发复查 |
| 实际开始 | 正式计划、最新状态 → 活动任务 | 原子绑定 Robot 与 Task，更新运行状态和预约时间 | 门禁通过后可以 |
| 执行与反馈 | Tool 调用、返回结果／Event → 执行事实 | RobotCommand、异步 RobotEvent、Step 和 Task 状态 | 按正式计划推进 |

审核采用短事务：锁定资源、检查排期冲突、保存正式计划和预约、标记草案已应用，一起提交或回滚。模型网络调用在事务外。审核人修改内容后要重新校验；重复审核不能生成第二份正式任务。

**未来可安排，不等于现在可执行。** R1 当前离线仍可成为未来草案的候选，页面展示采样时间；实际下发时 Java 必须重新检查在线快照、控制层健康、业务占用、能力和已接入的电量门槛，并原子绑定机器人。

数据库落库成功只说明计划已保存。机器人是否接受并完成，必须看后续执行结果。

继续查阅：[V2 §2.8 预约与执行占用](/central-scheduling-v2-design#_2-8-人工审核、两小时预约与执行占用)、[§2.10.9 落库和审核衔接](/central-scheduling-v2-design#_2-10-9-repository-落库和审核衔接-不能省掉的实现契约)。

## 5. 一个步骤怎样真正执行

轮到 `S2 = VISIT A03` 时，Java 查询正式 PlanStep，组装只读 `ExecutionContext`：任务、步骤、机器人、目标、审核描述、当前阶段和临时要求。

```text
Java 选择 S2，目标固定为 A03
  → 动作 Agent 选择 navigate_to("A03")
  → Java Tool 门禁校验目标与参数，伴随保存 Command C1
  → MCP tools/call → bot_mind 执行
```

接下来分两种返回方式：

| 返回方式 | 代表什么 | 后续流程 |
|---|---|---|
| 同步最终 Tool Result | 这次能力调用已经完成 | Java 更新 Command；结果回到当前 Agent Tool Loop，Agent 可继续选择讲解 Tool |
| `ACCEPTED` | 已受理，实际执行尚未完成 | 当前 Agent 执行暂停；等待最终 Event，Java 更新 Command，再按需构造新上下文唤醒 Agent |

讲解等本站接待流程完成后，Java 根据执行结果判断 S2 是否成功，再推进 S3。**动作 Agent 选择当前 Step 内的 Tool；Java 决定正式计划的下一 Step。**

`END` 由 Java 收尾。计划中的 `WAIT` 是业务等待；`WAITING_INTERACTION` 是运行状态，两者不要混淆。比如 A03 讲解时访客说“先别讲”，S2 仍是 `VISIT`，可以进入等待交互状态。

继续查阅：[V2 §1.3 任务执行链](/central-scheduling-v2-design#_1-3-一个-task-从创建到完成)、[§4.8 动作 Agent](/central-scheduling-v2-design#_4-8-1-动作-agent-负责什么)。

## 6. 访客问问题时，QA Agent 怎样参与

访客在 A03 问：“这个项目怎么识别人的动作？”问答链以当前展台为范围，检索已发布资料，结合本轮问题和会话上下文生成回答。回答内容不能替代已审核计划，也不能自行把目标改成 A05。

| 输入 | 走哪条处理链 | 对任务有什么影响 |
|---|---|---|
| “这个项目怎么工作？” | QA Agent + 当前展台 RAG | 回答问题，保持当前任务上下文 |
| “先别讲”“继续” | 意图识别 + Java 状态判断 + 必要的动作 Tool | 暂停或继续当前接待流程 |
| “后面先去 B，再去 D” | 运行中重规划草案 + 校验 + 审核 | 在允许的暂停边界替换未执行后半段 |

简单控制先用规则识别，复杂语义再交模型分类；能否执行由 Java 检查。QA、意图识别和动作编排各有职责，不能因为用了多个 ChatClient，就默认拥有多个完全自主的 Agent。

继续查阅：[V2 第四部分：QA、RAG 与动作 Agent](/central-scheduling-v2-design)。

## 7. 正常流程懂了，再记四个异常边界

| 情况 | 必须记住的处理原则 |
|---|---|
| 草案无法解析或违反业务规则 | 有限修订；不把最后一份错误输出当成正式计划 |
| 两人预约同一机器人 | 通过数据库事务和资源锁检查冲突，不能只靠“先查询再保存” |
| Tool 超时，结果不确定 | 进入 UNKNOWN 并对账；导航、动作等有副作用调用不能盲目重发 |
| 运行中改线或人工接管 | 保留已完成事实；改线检查版本和暂停边界，接管明确控制权 |

Java 主动轮询得到的是带时间戳的状态快照；当前设计每台机器人约 2 秒查询一次，超时离线后需要明确重新连接。离线不等于任务已结束，也不能自动释放业务占用。

这些机制可以第二遍学习。详细过程见 [V2 §1.5 命令可靠执行](/central-scheduling-v2-design#_1-5-命令可靠执行)、[§2.4 运行中重新规划](/central-scheduling-v2-design#_2-4-线路与运行中重新规划)。

## 8. 用一分钟讲完整个系统

> 接待员输入需求后，Java 提供机器人和展台的真实上下文，中央规划 Agent 从允许的目标中生成 TaskDraft。Java 严格解析、校验，内容错误做有限修订，保存待审核记录。人工确认后，平台事务保存正式 Task、Plan、PlanStep 和预约；真正开始时重新检查状态并绑定机器人。执行服务选中当前 Step，动作 Agent 通过受控 MCP Tools 完成导航、讲解等能力，每次有副作用调用都留下 Command。同步结果直接返回 Agent Loop；异步受理则等待 Event，由 Java 更新事实并按需恢复执行。当前展台的访客问答交给 QA 和 RAG，正式任务状态与步骤推进始终由 Java 管理。

面试讲述时，把“V2 设计怎样工作”和“本人实际实现并验收了什么”分开。以上可用于解释方案，个人经历仍应结合代码和验收记录确认。

## 9. 自测：能答出来再读详细实现

<details>
<summary>TaskDraft 是 Task(status=DRAFT) 吗？</summary>

不是同一个对象。TaskDraft 是模型输出 DTO；主示例把内容保存到 planning_draft，再审核形成正式任务。已有 Task 入口时也可先保存 CREATED Task 并关联草案。

</details>

<details>
<summary>模型输出合法 JSON，为什么还不能直接执行？</summary>

格式合法不能保证目标存在、必到点覆盖或能力匹配。还需要业务校验、人工审核及下发时的最新状态检查。

</details>

<details>
<summary>导航 Command 成功，为什么 VISIT Step 可能没有完成？</summary>

Command 表示一次能力调用，VISIT 表示到站并完成接待。到达后可能还需要讲解、互动或其他已批准流程。

</details>

<details>
<summary>ACCEPTED 可以推进到下一步吗？</summary>

不能。它只表示受理，需要等待实际完成结果。异步结果由 Java 归并，判断当前 Step 是否完成或是否需要恢复动作 Agent。

</details>

<details>
<summary>当前机器人离线，能生成明天的草案吗？</summary>

可以，只要登记资料和配置适用，当前离线状态及采样时间应明确展示。实际执行前必须重新检查，不能把未来草案当成可立即执行的承诺。

</details>

下一步：打开 [V2 可实施详细设计](/central-scheduling-v2-design)，先读 §1.2、§2.5～2.8 和 §2.10 的代码链，再读 §4.8 的执行衔接。需要练习讲述时，进入 [大厂校招模拟面试题](/central-scheduling-interview)。
