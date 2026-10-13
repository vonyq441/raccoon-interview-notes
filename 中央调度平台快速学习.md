---
title: 中央调度平台快速学习
description: 用一个接待任务理解规划、校验、落库和机器人执行。
---

# 中央调度平台快速学习

以“明天下午带初中生参观 AI 互动项目，必须经过 A03”为例，先走通主线，再按链接查 [V2 详细设计](/central-scheduling-v2-design)。

::: info 阅读边界
本页讲展厅 V2 目标方案；当前巡检仓库的拍卖分配和固定工单步骤是另一条实现。示例不代表所有功能已经上线。
:::

## 1. 先看懂系统分工

| 角色 | 负责什么 |
|---|---|
| 中央规划 Agent | 从真实候选中建议机器人、展台和接待重点 |
| Java 平台 | 查询事实、校验、落库、审核、预约和状态推进 |
| 动作 Agent | 围绕当前正式步骤选择机器人 Tools |
| bot_mind / g1_base | 执行导航、讲解和动作，返回结果 |
| QA Agent | 检索当前展台资料，回答访客问题 |

规划步骤是 `VISIT A03` 这样的业务目标。具体怎样导航和讲解，由动作 Agent 与机器人侧完成。

## 2. 六个对象，先分清再记关系

| 对象 | 含义 |
|---|---|
| Robot | 机器人台账、状态和当前占用 |
| TaskDraft | 模型输出的候选方案 DTO |
| Task | 一次完整接待 |
| TaskStep | 直接归属 Task 的有序业务步骤 |
| RobotCommand | 一次有副作用的 Tool 调用记录 |
| RobotEvent | 对某次 Command 的异步反馈 |

```text
Task T1
├─ S1：VISIT A01
├─ S2：VISIT A03
│  ├─ C1：navigate_to(A03) → 异步时可收到 Event
│  └─ C2：booth_show(...)
└─ S3：END
```

一个 Step 可以包含多次 Command。导航完成只是到站，接待完成后 Java 才推进下一 Step。

详见 [V2 §1.2 核心业务模型](/central-scheduling-v2-design#_1-2-核心业务模型)。

## 3. 模型怎样生成一个可信草案

Java 查询授权范围内的展台简述、主题/受众/体验标签、线路和机器人能力，形成精简 `PlanningEvidence` 直接放入 Prompt。模型据此选站；只有资料不足时才调用知识检索工具。

例如“适合小学生、科教性强”用于匹配展台标签；机器人能力是否满足展台要求，则由 Java 校验。

模型可以建议 R1，输出 A01 → A03 → END。**完整 TaskDraft 的字段和 JSON 示例见 V2 §2.5**，处理过程是：

```text
模型 JSON → 解析为 TaskDraft → 字段和业务校验
          ├─ 通过：保存待审核草案
          └─ 内容错误：原请求、台账、最新输出和错误 → 模型修订
```

最多初次生成加两次修订，沿用同一 ChatClient、SYSTEM 和 Schema；技术故障不进入内容修订。重传上下文仍消耗 token，用精简字段和有界检索控制成本。

模型不生成数据库 ID 或运行状态。格式合法也不能证明接待描述正确，仍需人工审核。

详见 [V2 §2.5 TaskDraft、§2.6 校验、§2.7 修订](/central-scheduling-v2-design#_2-5-taskdraft、taskstep-与默认接待描述)。

### 3.1 对草案不满意，怎样追加修改？

一次规划会话中，Java 短期保存有效需求、最新有效草案和少量对话。追加要求只更新明确修改的部分；新一轮重新查询台账、生成并校验，失败时保留上一份有效草案。会话结束或超时后清理，短期聊天不持久化。

选中历史计划或已保存草案，开启全新规划：仅参考旧内容，不继承旧聊天，重新确认要求并审核。

详见 [V2 §2.7.1 简单规划会话](/central-scheduling-v2-design#_2-7-1-一次规划内追加修改-简单会话-不继承历史聊天)。

## 4. 草案、审核和正式任务怎样落库

候选先存 `planning_draft`。审核通过后，在事务中创建 Task、TaskStep 和两小时预约，并将草案标记已应用；实际开始时再复查状态、延期检查和原子绑定机器人。

```text
task_step.task_id       → task.task_id
robot_command.step_id  → task_step.step_id
robot_event.command_id → robot_command.command_id
```

运行中改线只替换未下发步骤，保留执行历史。Task.version 用于防止并发覆盖，不保存整份方案版本。未来可预约不等于现在可执行，数据库保存成功也不等于机器人完成。

详见 [V2 §2.8 预约与占用](/central-scheduling-v2-design#_2-8-人工审核、两小时预约与执行占用)、[§2.10.9 落库和审核](/central-scheduling-v2-design#_2-10-9-repository-落库和审核衔接-不能省掉的实现契约)。

## 5. 一个步骤怎样真正执行

Java 选中 S2 = VISIT A03，构造 ExecutionContext，动作 Agent 选择 navigate_to，再选择 booth_show。Java 在受控调用边界校验参数、保存 Command，并调用机器人。

| 返回 | 下一步 |
|---|---|
| 同步最终结果 | 更新 Command，结果回到当前 Agent Tool Loop |
| ACCEPTED | 暂停 Agent，等待最终 RobotEvent；Java 更新记录后按需恢复 |

Java 按业务完成条件判断 S2 是否成功。用户说“到站先别讲”时，type 仍为 VISIT，可进入 WAITING_INTERACTION；它与业务类型 WAIT 不同。

详见 [V2 §1.3 执行链](/central-scheduling-v2-design#_1-3-一个-task-从创建到完成)、[§4.8 动作 Agent](/central-scheduling-v2-design#_4-8-1-动作-agent-负责什么)。

## 6. 访客问问题时，QA Agent 怎样参与

| 输入 | 处理方式 |
|---|---|
| “这个项目怎么工作？” | QA + 当前展台 RAG，保持任务不变 |
| “先别讲”“继续” | 意图识别，Java 校验后控制当前接待 |
| “后面先去 B，再去 D” | 运行中重规划，校验并人工审核 |

简单控制先走规则，复杂语义再交模型。问答会话按 TaskStep 隔离；QA 回答不能修改正式步骤。

详见 [V2 第四部分](/central-scheduling-v2-design)。

## 7. 正常流程懂了，再记四个异常边界

| 情况 | 处理原则 |
|---|---|
| 草案不合法 | 有限修订，失败转人工 |
| 两人预约同一机器人 | 数据库锁与短事务检查冲突 |
| Tool 超时、结果不确定 | UNKNOWN，对账后决定，不能盲目重发 |
| 改线或人工接管 | 检查修改边界，明确控制权 |

机器人状态来自带采样时间的快照；离线不等于任务结束，不能自动释放业务占用。

详见 [V2 §1.5 可靠执行](/central-scheduling-v2-design#_1-5-命令可靠执行)、[§2.4 运行中改线](/central-scheduling-v2-design#_2-4-线路与运行中重新规划)。

## 8. 用一分钟讲完整个系统

> Java 查询精简台账，中央规划 Agent 生成 TaskDraft，必要时检索详细知识。Java 解析、校验并有限修订，人工审核后保存 Task、TaskStep 和预约。开始时复查并绑定机器人；执行服务选中当前步骤，动作 Agent 调用 bot_mind Tools，Java 保存 Command，处理同步结果或异步 Event，判断完成后推进下一步。访客问答由 QA 和 RAG 处理，正式业务状态始终由 Java 管理。

面试时区分 V2 设计与本人实际实现、验收的内容。

## 9. 自测：能答出来再读详细实现

<details>
<summary>TaskDraft 是 Task(status=DRAFT) 吗？</summary>

不是。它是输出 DTO，先保存草案记录，审核后形成正式任务和步骤。

</details>

<details>
<summary>修订会换 ChatClient 吗？重传台账免费吗？</summary>

不换客户端或系统规则；重传仍有 token 成本。

</details>

<details>
<summary>修改历史计划，要找回旧聊天吗？</summary>

不用。以旧内容为蓝本开启全新规划。

</details>

<details>
<summary>运行中改线，能删掉全部步骤吗？</summary>

不能。保留已执行和已下发步骤，只修改未下发部分。

</details>

<details>
<summary>合法 JSON 为什么不能直接执行？</summary>

还需业务校验、人工审核和下发前状态复查。

</details>

<details>
<summary>导航成功，VISIT 就完成了吗？</summary>

未必。还需完成本站接待。

</details>

<details>
<summary>ACCEPTED 能推进下一步吗？</summary>

不能。等待实际完成结果，再判断业务步骤是否完成。

</details>

<details>
<summary>机器人当前离线，能生成明天的草案吗？</summary>

可以选择适用的登记机器人，真正执行前再检查状态。

</details>

下一步读 V2 §2.10 的 Java 示例，或进入 [模拟面试题](/central-scheduling-interview) 练习讲述。
