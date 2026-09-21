# 多机器人中央调度平台项目文档

> 面向展厅讲解和政务接待场景，使用 Spring Boot、Spring AI 与机器人侧 ZeroClaw，完成自然语言任务规划、多机器人协同、任务执行跟踪、展台知识问答和宇树 G1 动作控制。

## 一、业务场景与固定资源

展厅原有系统需要工作人员在手机端逐项选择机器人、展台和讲解内容。机器人数量增加后，会出现三个问题：

1. 接待需求是自然语言，人工需要把它转换成具体路线和任务；
2. 多台机器人分布在不同楼层，需要统一判断谁空闲、谁适合执行；
3. 导航、讲解、动作和现场问答来自不同模块，缺少统一的任务状态和执行记录。

平台的目标不是让大模型直接控制机器人，而是把自然语言需求转换成一份经过校验的任务计划，再由确定性任务引擎和机器人侧执行器完成。

一个典型需求是：

> 下午三点接待领导参观一楼，重点介绍液冷机柜和具身智能，控制在十五分钟左右。每个展台讲完后等待提问，最后引导领导前往二楼，由二楼机器人继续接待。

系统最终生成的不是一段自由文本，而是类似下面的任务：

```text
总任务 T1001
├── 一楼子任务：G1-01
│   ├── 前往迎宾点并致欢迎词
│   ├── 前往液冷机柜，播放绑定文稿，等待提问
│   ├── 前往具身智能展台，播放文稿并执行绑定动作
│   └── 引导至一楼电梯口
├── 跨楼层交接
└── 二楼子任务：G1-02
    └── 从二楼电梯口继续讲解
```

**固定资源边界。** 为了让系统可控，下面的资源都由管理员提前配置：


- 展台及其业务编码 `exhibitCode`；
- 地图导航点 `waypointId`；
- 展台与导航点的对应关系；
- 展台讲解文稿；
- 讲解过程中使用的动作脚本；
- 机器人支持的能力、所属楼层和安全限制。

中央规划 Agent 可以根据接待需求从已有展台中选择、裁剪和排序，但不能创造新的展台、地图坐标、讲解内容或硬件动作。

例如，管理员提前配置：

```text
液冷机柜展台
├── exhibitCode: LIQUID_COOLING
├── waypointId: F1_WP_03
├── explainScript: EXPLAIN_LIQUID_COOLING_V1
├── actionScript: G1_LIQUID_COOLING_GESTURE
└── expectedDuration: 240秒
```

Agent 只决定本次是否选择这个展台以及它在路线中的位置。机器人到达后播放的文稿和动作仍来自配置，不由大模型现场生成。

## 二、总体架构与职责边界

项目采用“中央平台负责全局、ZeroClaw负责单机、控制层负责安全运动”的云边分层架构。

```text
手机端/工作人员 ────────────────┐
机器人麦克风 → bot_mind ASR     │
                    ↓          │
             ZeroClaw 意图识别   │
             （调用本地Ollama）  │
                    └──────────┤
                               ▼
┌────────────────────────────────────────────┐
│ Java中央平台                               │
│ Spring Boot                                │
│ ├── 接待任务与状态机                       │
│ ├── 中央规划Agent                          │
│ ├── 多机器人调度                           │
│ ├── 已识别意图的业务校验                   │
│ ├── 中央问答Agent、日常对话与RAG           │
│ └── 机器人连接、命令和事件中心             │
└────────────────────┬───────────────────────┘
                     │ REST + WebSocket JSON
           ┌─────────┴─────────┐
           ▼                   ▼
┌──────────────────┐  ┌──────────────────┐
│ G1-01 ZeroClaw   │  │ G1-02 ZeroClaw   │
│ 单机技能编排层    │  │ 单机技能编排层    │
└────────┬─────────┘  └────────┬─────────┘
         ▼                     ▼
 bot_mind / G1ControlServer / g1_base / Unitree SDK
```

### 谁负责什么

| 模块 | 负责 | 不负责 |
|---|---|---|
| Java中央平台 | 保存任务事实、步骤状态、机器人占用、命令和事件，负责调度、路线变更与统一问答 | 关节控制、导航算法 |
| 中央规划Agent | 理解接待需求，选择并排序已有展台 | 直接分配硬件资源、直接控制机器人 |
| Java调度器 | 根据在线状态、楼层、电量和占用选择机器人 | 生成讲解内容 |
| ZeroClaw语音路由 | 极少量精确短语直达，其余调用展厅服务器上的Ollama小模型，形成结构化意图 | 自行决定下一站目标点或修改全局任务 |
| 中央问答服务 | 专业问题做对话改写、RAG检索与证据回答；日常聊天不强制检索知识库 | 推进任务步骤 |
| ZeroClaw任务执行 | 接收平台命令、编排本机技能、回传事件和断线收尾 | 绕开Java直接执行模型给出的导航目标 |
| bot_mind | 唤醒、ASR、TTS及本机机器人能力适配 | 保存全局任务状态、决定下一站 |
| G1ControlServer | 对导航、动作、FSM和停止提供统一入口 | 多机器人业务调度 |
| g1_base | 定位、导航和避障 | 接待任务状态管理 |
| Unitree SDK worker | 实际调用宇树硬件SDK执行动作 | 业务语义理解 |

### ZeroClaw与Java的边界

Java平台不应该把每个ROS2调用和硬件细节都远程编排。ZeroClaw部署在单台机器人上，是**唯一的机器人语音意图入口**：对固定短语做严格精确匹配，其余通过展厅服务器的Ollama模型分类，再把结构化意图交给Java；不会先由ZeroClaw自己的LLM判断一遍，再由Java的ChatClient判断一遍。它同时把“前往展台、播放讲解、执行动作、停止”封装成本地技能，并负责：

- 将平台步骤转换成本地技能调用；
- 识别语音意图并上传`taskId、stepId、planVersion`等上下文；
- 组合bot_mind、G1ControlServer和动作脚本；
- 在网络抖动时保证当前动作能够安全结束；
- 汇总本机执行状态并上报平台。

ZeroClaw不替代`g1_base`，也不直接计算导航路径。它是单机器人任务执行和技能编排层。

平台与ZeroClaw之间使用业务协议即可，不强制使用MCP。当前规模下使用REST与WebSocket JSON更容易实现可靠下发和状态同步；ZeroClaw内部的机器人能力可以按工具或MCP Skill方式封装，供本机Agent调用。接待模式下必须限制模型可直接调用的工具：它可以提交意图、请求播报或查询状态，但**不能凭模型判断直接调用本地“下一导航点”工具**。真正的目标`waypointId`仍由Java下发。

**最终决定权。** 需要把“任务决策”和“动作执行”分开：


- Java数据库中的任务、当前步骤和命令记录是业务事实来源；
- 规划Agent只生成路线草案，Java校验并保存后才成为正式计划；
- 手机和语音是输入入口；ZeroClaw的小模型只识别意图，不能自行决定目标点；
- ZeroClaw只执行Java明确下发的当前命令，不缓存并擅自推进整条路线；
- bot_mind和控制层提供本机能力，不能修改全局任务。

因此，“去下一站”不是让机器人按本地`waypoints.yaml`寻找下一个点，而是请求Java推进当前任务，由Java返回任务计划中的明确`waypointId`。

**简历主线。** 简历优先讲Java业务平台、规划Agent、多机器人分配、执行跟踪和G1动作编排。RAG问答、多轮记忆、路线临时调整和断线恢复属于可以继续追问的扩展能力。这样既能说明平台完整，又不会让主线被大量Agent术语淹没。

## 三、业务数据与平台通信

系统围绕“任务—步骤—命令—事件”四层模型运行。

```text
ReceptionTask
    └── TaskStep
            └── RobotCommand
                    └── ExecutionEvent
```

### 任务、步骤、命令与事件

| 表 | 关键字段 | 作用 |
|---|---|---|
| `robot` | robot_id、floor、status、battery、capabilities | 机器人台账 |
| `exhibit` | exhibit_code、name、floor、waypoint_id | 展台配置 |
| `explain_script` | script_code、exhibit_code、content | 固定讲解文稿 |
| `action_script` | action_code、resource_path、fsm_required | 动作脚本 |
| `reception_task` | task_id、status、plan_version、start_time | 总接待任务 |
| `task_step` | step_id、task_id、sequence、robot_id、type、snapshot | 本次任务步骤快照 |
| `robot_command` | command_id、step_id、type、status、idempotency_key | 平台下发命令 |
| `execution_event` | event_id、command_id、event_type、occurred_at | 机器人执行事件 |
| `qa_message` | conversation_id、role、content、step_id | 完整问答记录 |
| `knowledge_document` | doc_id、exhibit_code、source_file | 知识文档 |

**为什么保存步骤快照。** 任务创建后，应把当时使用的`waypointId`以及讲解、动作资源的不可变版本写入`task_step.snapshot`。如果脚本允许运行中修改，就要保存实际内容或引用不可变版本，不能只保存一个会指向新内容的`scriptCode`。这样管理员后来修改展台配置时，已经开始的任务仍按审核版本执行。

### Java平台与机器人如何通信

- REST：机器人注册、重连后查询当前任务、知识问答请求和状态对账；
- WebSocket：命令通知、进度事件、心跳和实时状态；
- MySQL：保存任务、命令和事件，作为最终事实来源；
- Redis：保存机器人最新状态、短期会话和连接映射。

WebSocket不是任务事实来源。平台先把命令写入数据库，再通过WebSocket通知ZeroClaw；机器人重连后根据任务、步骤和命令记录对账，而不是盲目重放所有待执行命令。

**“下一站”的完整调用链。** 手机按钮与机器人语音最终进入同一个任务推进接口，只是入口不同：

```text
手机点击“下一站” ─────────────┐
                              ├→ Java advance接口
bot_mind云端ASR → ZeroClaw精确短语或Ollama分类为NEXT → Java ┘
                                   ↓
校验taskId、expectedStepId、planVersion和任务状态
                                   ↓
从已审核计划中确定下一TaskStep及waypointId
                                   ↓
事务内推进步骤并创建RobotCommand
                                   ↓
WebSocket通知机器人侧ZeroClaw
                                   ↓
ZeroClaw调用bot_mind / G1ControlServer
                                   ↓
g1_base执行导航，ZeroClaw持续回传执行事件
                                   ↓
Java更新命令与步骤状态
```

明确的“下一站”不再调用规划Agent。只有“跳过液冷，先去具身智能”等改变既有计划的请求，才进入路线调整流程。

推进接口应携带调用方看到的任务上下文：

```text
advance(taskId, expectedStepId, planVersion, requestId)
```

`requestId`防止同一请求因网络重试被重复处理；`expectedStepId + planVersion + 当前状态`用于条件更新，防止手机点击和语音命令同时到达时连续跳过两个展台。

**命令结构。** 平台明确指定要执行的目标点，不让机器人从本地列表猜测：

```json
{
  "commandId": "CMD-20260919-001",
  "taskId": "T1001",
  "stepId": "T1001-S03",
  "robotId": "G1-01",
  "planVersion": 2,
  "type": "NAVIGATE",
  "payload": {
    "waypointId": "F1_WP_03"
  },
  "idempotencyKey": "T1001-S03-NAVIGATE"
}
```

`commandId`标识一次命令，`idempotencyKey`用于识别同一业务动作的重复下发，`planVersion`用于校验命令属于哪个计划版本。版本号本身不会自动同步：Java仍需完成版本通知和机器人确认，才能安全切换路线。

**命令状态与执行事件。** 下发成功、机器人接收和实际执行成功必须分开：

```text
CREATED → DISPATCHED → ACCEPTED → RUNNING → SUCCEEDED
                    └───────────────┬──────→ FAILED
                                    └──────→ UNKNOWN
```

- `DISPATCHED`：Java已经尝试发送，不能证明机器人收到；
- `ACCEPTED`：ZeroClaw接收并通过基础校验；
- `RUNNING`：底层能力已经开始执行；
- `SUCCEEDED / FAILED`：明确得到成功或失败结果；
- `UNKNOWN`：超时、断线等原因导致结果暂时无法确认。

`UNKNOWN`不能直接当成失败并生成新命令。平台先使用原`commandId`查询机器人侧记录；仍然无法判断时暂停任务并转人工确认，避免机器人已经执行却再次执行。

ZeroClaw回传的事件示例：

```json
{
  "eventId": "EVT-001",
  "commandId": "CMD-20260919-001",
  "taskId": "T1001",
  "stepId": "T1001-S03",
  "robotId": "G1-01",
  "eventType": "SUCCEEDED",
  "occurredAt": "2026-09-19T15:03:21+08:00",
  "detail": {
    "waypointId": "F1_WP_03"
  }
}
```

接口返回成功最多代表ZeroClaw接收了命令。Java只有收到合法的`SUCCEEDED`事件，才认为导航或动作真正完成并推进任务。命令表中的`commandId`唯一；事件表只要求`eventId`唯一，因为同一命令会产生`ACCEPTED、RUNNING、SUCCEEDED`等多个事件。事件还要通过状态机校验，迟到的`RUNNING`不能覆盖已经保存的`SUCCEEDED`。

### 心跳、在线状态与重连

Java平台不扫描局域网寻找机器人，而是由机器人侧ZeroClaw中的`platform_client`主动注册并持续发送心跳。它汇总bot_mind、导航和动作服务的就绪状态，携带`robotId`、所在楼层、软件版本和能力列表调用注册接口；平台验证机器人已登记且未被禁用后，允许它建立WebSocket连接。

机器人随后每隔数秒上报：

```json
{
  "type": "HEARTBEAT",
  "robotId": "G1-01",
  "battery": 78,
  "currentWaypointId": "F1_WP_03",
  "taskId": "T1001",
  "stepId": "T1001-S03",
  "executionState": "WAITING_COMMAND",
  "botMindReady": true,
  "navigationReady": true,
  "actionReady": true,
  "timestamp": 1789801401000
}
```

平台按服务器接收时间把最新运行状态写入Redis，并为`robot:online:{robotId}`设置短TTL；每次收到有效心跳就续期。连续多个心跳周期未上报或WebSocket断开时，平台先将机器人标记为疑似离线并停止分配新任务，超过容错时间后再标记为离线。业务数据库中的任务、命令和执行事件仍是恢复与审计的事实来源，Redis只保存易失的最新状态和连接映射。

需要区分“在线”和“可调度”：在线只说明机器人侧服务仍能与平台通信；只有同时满足机器人未禁用、bot_mind与导航服务就绪、当前空闲、电量达标且所在区域符合任务要求时，机器人才能进入调度候选集合。机器人可能在线但正在执行任务、电量过低或`g1_base`异常，此时都不能接收新任务。

机器人重连后重新注册，并上报当前`taskId、stepId、commandId`和`planVersion`。Java平台先与数据库中的任务状态对账，再决定继续等待、补发尚未执行的命令或转人工处理，不能因为重连就直接重放全部旧命令。

> 面试速记：机器人主动注册并建立WebSocket，定期发送业务心跳；Java用Redis TTL判断在线，用确定性条件判断是否可调度，重连后根据任务、步骤和命令编号完成状态对账。

## 四、路线规划与任务执行

### 规划、分配与改线

```text
自然语言接待需求
    ↓
规划Agent提取时间、楼层、重点展台和时长
    ↓
调用工具查询已有展台、标准路线和预计时长
    ↓
从已有展台中选择、裁剪和排序
    ↓
Java校验展台、waypoint和脚本真实存在
    ↓
Java调度器选择机器人
    ↓
生成任务及步骤快照
```

Agent负责路线语义，Java负责最终校验和机器人分配。这样既能处理自然语言，又不会让大模型决定并发占用和数据库事务。

**Spring AI结构化输出。** 规划结果使用Java类型承接，而不是解析自由文本：

```java
public record PlanDraft(
        LocalDateTime startTime,
        Integer expectedMinutes,
        List<PlannedExhibit> exhibits,
        String explanation) {}

public record PlannedExhibit(
        String exhibitCode,
        Integer sequence,
        Integer expectedSeconds) {}
```

```java
PlanDraft draft = planningChatClient.prompt()
        .system(PLANNING_SYSTEM_PROMPT)
        .user(requirement)
        .tools(exhibitQueryTools, routeTemplateTools)
        .call()
        .entity(PlanDraft.class, spec -> spec.validateSchema());
```

模型只能从工具返回的`exhibitCode`中选择。`entity()`解决输出格式问题，不能证明业务内容正确，因此Java仍要逐项查库校验。

**机器人选择。** Java调度器先过滤：

- 不在线的机器人；
- 已经被其他任务占用的机器人；
- 楼层不匹配的机器人；
- 电量低于任务安全阈值的机器人；
- 缺少任务要求能力的机器人。

再根据距离迎宾点、电量和当前负载评分。最终占用通过数据库事务或带版本号的条件更新完成，避免两个任务同时抢到同一台机器人。

**路线临时修改。** 工作人员可以通过手机或语音提出修改，规划Agent负责把自然语言转换成新的路线草案，但只能由Java校验、确认并创建新版本：

```text
planVersion=1：step3 → step4 → step5
planVersion=2：step3 → step5
```

一般改线在当前展台执行结束并进入`WAITING_COMMAND`后生效。Java暂停下发旧版本的后续命令，只修改尚未开始的步骤，保存新版本并通知ZeroClaw；ZeroClaw确认已经到达安全边界并接受新版本后，Java才下发新版本的下一条明确命令。

如果必须立即改线，要先取消或暂停当前命令并确认机器人已经停止。仅给命令增加`planVersion`并不能保证安全，因为新版本通知尚未到达时，机器人并不知道旧命令已经过期。影响较大的调整要求工作人员确认。

### 状态机与幂等

```text
CREATED → PLANNED → APPROVED → ASSIGNED → RUNNING
                                              ├── PAUSED
                                              ├── FAILED
                                              ├── CANCELLED
                                              └── COMPLETED
```

`PLANNED`表示Agent已经生成草案，`APPROVED`表示草案通过工作人员或业务规则审核；如果现场采用工作人员按时启动，就不额外设计自动定时状态。只有确认存在预约自动启动需求时，再增加`SCHEDULED`及到期检查机制。

**展台步骤状态。**

```text
PENDING
  ↓
NAVIGATING
  ↓
EXPLAINING
  ↓
WAITING_COMMAND
  ├── 知识问答：回答后继续等待
  ├── REPEAT：重新播放当前文稿
  ├── NEXT：完成当前步骤并进入下一展台
  ├── PAUSE：暂停任务
  └── FINISH：提前结束接待
```

展台讲完后不能自动前往下一站，因为领导可能提问、要求重讲或调整路线。

**幂等和超时。**

- Java先用`requestId`识别同一入口请求的网络重试，再通过`expectedStepId + planVersion + 状态条件`防止两个不同请求连续推进；
- 命令表对`commandId`建立唯一约束；事件表对`eventId`建立唯一约束，同一命令允许保存多条生命周期事件；
- ZeroClaw保存`idempotencyKey`及对应执行状态，收到重复命令时返回已有状态，而不是再次执行；
- 命令超时后标记为`UNKNOWN`并查询机器人当前状态，不能立即重复导航或动作；
- 机器人断线时停止启动新步骤，重连后通过`taskId + stepId + commandId`对账。

幂等机制只能减少重复执行，不能承诺物理动作“严格只执行一次”。如果机器人在动作完成、结果落盘前断电，平台可能无法自动判断结果，此时应暂停并让工作人员确认。

## 五、语音意图与展台知识问答

### 语音入口：ZeroClaw只判断一次，Java执行或回答

bot_mind采集麦克风音频并调用云端ASR，把识别文字交给机器人侧ZeroClaw。ZeroClaw先将唤醒词、首尾空格和句末标点清理掉；若**完整文本**等于极少量预设短语，直接映射为意图；否则由ZeroClaw调用展厅本地服务器上的Ollama小模型分类**一次**。它把`utteranceId、taskId、stepId、planVersion、robotId、意图、原话`送给Java。Java不再另接一个小模型重复分类，只校验意图是否适用于当前任务，并处理规划、任务推进或回答。

**ZeroClaw的智能在哪里？** 它是机器人侧承接语音、调用模型、组织本机技能的运行层；Ollama上的Qwen是它接入的意图模型，不是与ZeroClaw并排运行的第二个意图Agent。当前`bot_mind`代码默认把ASR文本发给本机Rust服务，这支持“机器人侧先接收语音”的边界；但尚未看到Rust/ZeroClaw本体配置，因此“由它调用展厅Ollama并上报结构化意图”应作为本方案的接口设计，在联调中验证，不应冒充已有源码事实。

| 输入 | ZeroClaw的判断 | Java后续处理 |
|---|---|---|
| “去下一个站台” | 精确白名单：`CONTROL / NEXT` | 跳过小模型；Java仍校验任务状态，再从已审核计划确定下一`waypointId` |
| “下一站我们去哪里？” | 非精确匹配，进入小模型 | 当作提问或澄清，不能推进 |
| “为什么下一站是液冷？” | `KNOWLEDGE_QA`或`UNKNOWN` | 回答或澄清，绝不凭“下一站”三个字推进 |
| “液冷机柜怎样散热？” | `KNOWLEDGE_QA` | 进入RAG与中央问答Agent |
| “先不看液冷，去具身智能” | `PLAN_CHANGE` | 大模型提出改线草案，工作人员确认、Java校验后才生效 |
| “谢谢你” | `SMALL_TALK` | 日常对话服务生成简短回复，不做展台RAG，保持当前步骤 |

模型调用次数也由此清晰：精确“下一站”是零次模型调用；非精确流程指令只由ZeroClaw调用一次小模型；专业问题和日常聊天各调用一次小模型做分类，再由Java按需调用一次大模型生成内容。这里没有“ZeroClaw先找自己的另一个LLM想一遍，Java再找Ollama判断一遍”的重复路径。

**停止指令单独处理。** 云端ASR若返回与“停下”等预设停止短语完全相等的文本，ZeroClaw优先触发本机停止能力并向Java上报，不等待Ollama或远端模型；手机停止按钮也直接走控制接口。由于语音识别依赖云端，这不是物理急停的替代品，还要保留机器人原有安全机制。其余未精确命中的语音才进入小模型；即便白名单命中`NEXT`，Java仍须检查任务是否运行、当前步骤是否处于`WAITING_COMMAND`，以及`expectedStepId`和`planVersion`是否匹配。

本项目没有面向访客的多用户登录和角色权限体系，不把“识别出谁说的”作为推进任务的前提。展厅接待模式下，语音“下一站”被定义为可用的现场交互入口；这意味着访客也可能触发推进，应在交互规则中明确这一点。若某场接待只允许工作人员控制，可在手机端确认后再推进，但那是另一种可选流程，不是当前方案里每条语音都做用户权限校验。

ZeroClaw调用的意图模型建议使用Ollama中的`qwen3:4b-instruct-2507-q4_K_M`，它是非思考版约4B参数的模型，Ollama模型文件约2.5GB；这只是下载体积，运行内存还取决于上下文长度、并发和推理后端，不能据此声称一定能在低配服务器稳定低延迟运行。先在实际服务器上压测，再定超时和并发。模型与版本见[Ollama标签页](https://ollama.com/library/qwen3/tags)和[Qwen模型卡](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507)。

运维上先在展厅服务器执行`ollama pull qwen3:4b-instruct-2507-q4_K_M`，让ZeroClaw通过受限的展厅内网接口访问该模型；不要把Ollama推理端口直接暴露到公网或手机端。若Ollama只监听`127.0.0.1`，机器人无法跨机器访问，须经内网代理或受控网络地址提供服务。生产配置还要限制输入长度与并发、设置较短超时和低温度，并记录模型标签及提示词版本，以便复现误判。是否满足现场交互速度，应以“云端ASR + 局域网传输 + Ollama分类”的端到端P95时延衡量，而不是只测模型推理时间。

ZeroClaw侧是唯一的模型意图路由，Spring AI只在Java侧负责规划、专业问答与日常对话。以下是**接口伪代码**，用于讲清职责，不代表已看到ZeroClaw的Rust实现：

```text
ZeroClaw.onAsr(text, context):
  if exactStop(text): localStop(); reportStopToJava(); return
  if exactNext(text): decision = CONTROL/NEXT
  else: decision = ollamaClassify(text, context)  # 唯一一次意图模型调用
  POST Java /robot/utterances {utteranceId, taskId, stepId, planVersion,
                               robotId, text, decision}

Java.onUtterance(event):
  checkCurrentTaskAndStep(event)   # 不重新分类
  CONTROL/NEXT  -> advanceFromApprovedPlan(event)
  KNOWLEDGE_QA -> ragQaAndReturnSpeech(event)
  PLAN_CHANGE  -> planningAgentDraftThenConfirm(event)
  SMALL_TALK   -> generalChatWithoutRag(event)
  UNKNOWN      -> askForClarification(event)
```

机器人上传结构化意图时仍须校验JSON枚举值、文本长度和`taskId/stepId/planVersion`是否有效，`targetExhibitCode`只能用于生成改线草案，不能直接变成导航命令。白名单或模型输出的`CONTROL`都只表示“用户想做什么”；Java依据任务状态、当前步骤、计划版本和机器人安全条件决定“此刻能不能做”，不需要额外查询用户角色。“不要去下个站台”“为什么去下个站台”即使含有白名单短语，也因全文不相等而进入小模型，绝不能直接推进。模型输出的`confidence`不应当作可靠概率，歧义、互相矛盾或连续改线的请求应追问或让工作人员确认。Ollama异常或超时，只允许极少量精确白名单按同样业务校验执行；其余语音提示改用手机按钮，不扩大规则范围猜测用户意图。

为了证明路由可靠，准备带标签的现场语音样本：白名单原句、只差一个否定词的句子、疑问句、口音/ASR错误、跨展台追问、同时包含命令与问题的句子。分别统计白名单误命中率、小模型各类召回率、`NEXT`误触发率、澄清率和端到端P95时延；控制类以低误触发优先，不达标就限制语音控制范围。未命中白名单的语音由ZeroClaw使用小模型分类，Java不会再分类一次；只有规划、知识问答或日常对话才按需调用移动API生成内容。

### 问答调用链与多轮记忆

```text
bot_mind完成ASR
    ↓
ZeroClaw用本地Ollama模型识别KNOWLEDGE_QA，并上传意图、文字与任务上下文
    ↓
Java校验当前任务和步骤
    ↓
读取当前展台最近几轮对话
    ↓
把“它有什么优势”改写成完整检索问题
    ↓
按exhibitCode过滤并执行向量检索
    ↓
中央问答Agent依据证据生成答案和引用
    ↓
再次校验任务状态、stepId和planVersion，避免旧回答串到下一展台
    ↓
ZeroClaw在实际播报前再次校验上下文，再调用bot_mind进行TTS
    ↓
任务继续保持WAITING_COMMAND
```

这里的任务上下文必须在本次语音开始采集时绑定，不能等ASR结果返回后再读取“当前步骤”，否则机器人已经换站时，旧问题会被错误绑定到新展台。取消或人工接管也可能不改变stepId，因此只比较stepId还不够。

**ChatMemory怎样使用。** 会话编号按步骤隔离：

```text
conversationId = taskId + ":" + stepId + ":" + robotId
```

```java
ChatClient qaChatClient = ChatClient.builder(mobileApiChatModel)
        .defaultAdvisors(MessageChatMemoryAdvisor.builder(chatMemory).build())
        .build();

String answer = qaChatClient.prompt()
        .user(prompt)
        .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, conversationId))
        .call()
        .content();
```

- `MessageWindowChatMemory`只保留最近6～10条消息；
- `RedisChatMemoryRepository`保存短期记忆并设置TTL；
- MySQL的`qa_message`保存完整问答记录；
- 任务状态仍保存在任务表，不能用ChatMemory代替状态机。

进入下一展台后`stepId`改变，会自动切换会话，避免把上一展台的代词和主题带过来。

### RAG入库与检索

通用模型不了解展厅最新资料，也可能编造产品参数。RAG先检索经过整理的讲解稿、FAQ、产品说明和公开白皮书，再让模型依据证据组织回答，并返回来源。

当前只有十几个展台、二三十份资料，没有必要同时部署Milvus、Elasticsearch和Neo4j。PostgreSQL + pgvector已经能满足按展台过滤后的语义检索。

**文档入库。**

```text
读取PDF/Word/Markdown
    ↓
清洗页眉页脚、乱码和重复内容
    ↓
按标题、段落和语义切块
    ↓
添加确定性元信息和AI辅助关键词
    ↓
M3E生成768维向量
    ↓
写入PostgreSQL + pgvector
```

确定性元信息由管理员和解析程序提供：

```text
chunkId、docId、exhibitCode、documentTitle、sectionTitle、
pageNumber、sourceFile、content、embedding
```

`exhibitCode`决定检索范围，必须由上传页面选择，不能让大模型猜。AI只离线补充关键词：

```java
KeywordMetadataEnricher enricher = KeywordMetadataEnricher.builder(mobileApiChatModel)
        .keywordCount(5)
        .build();

List<Document> enrichedChunks = enricher.apply(chunks);
```

关键词被写入`excerpt_keywords`，用于辅助搜索和后台展示，不作为安全或任务路由依据。

**M3E、ONNX和768维。**

项目使用本地部署的`moka-ai/m3e-base`：

- 中文语义检索效果适合讲解稿和FAQ；
- 模型可以部署在内网，资料不需要发送到公网Embedding服务；
- 导出为ONNX后，可由Java进程通过ONNX Runtime直接推理；
- `m3e-base`输出768维向量，因此pgvector字段也必须为768维。

这里的“本地”只描述Embedding计算。最终回答仍调用移动提供的大模型API，问题和检索片段是否离开展厅取决于该API使用公网、专网还是内网，不能据此宣称整个问答链路完全离线。

Spring AI的`TransformersEmbeddingModel`负责加载本地模型：

```java
@Bean
EmbeddingModel m3eEmbeddingModel() {
    TransformersEmbeddingModel model = new TransformersEmbeddingModel();
    model.setModelResource("file:/opt/models/m3e-base/model.onnx");
    model.setTokenizerResource("file:/opt/models/m3e-base/tokenizer.json");
    model.setTokenizerOptions(Map.of("padding", "true"));
    return model;
}
```

业务层依赖统一的`EmbeddingModel`接口，而不是直接依赖具体实现。注册为Spring Bean后，容器负责执行初始化生命周期；只有脱离Spring容器手动创建对象时，才需要显式调用`afterPropertiesSet()`。

这里的M3E ONNX并非Spring AI开箱即自动下载的默认模型：需要自行导出、准备配套tokenizer，并用中文测试句验证输出确实为768维、归一化/池化方式与入库和查询两端一致。模型换版后不能把新旧向量混入同一索引，应该重建向量数据。

pgvector的核心配置：

```yaml
spring:
  ai:
    vectorstore:
      pgvector:
        dimensions: 768
        initialize-schema: true
```

向量维度由模型决定，不能为了节省空间把M3E结果写成384维。384维通常对应`all-MiniLM-L6-v2`等其他模型。

**在线检索。**

```java
SearchRequest request = SearchRequest.builder()
        .query(rewrittenQuestion)
        .topK(5)
        .filterExpression("exhibitCode == '" + exhibitCode + "'")
        .build();

List<Document> evidence = vectorStore.similaritySearch(request);
```

真实实现中应通过过滤表达式构造器或参数校验避免直接拼接不可信输入。`exhibitCode`来自当前任务步骤，不直接采用用户文本。

检索流程：

1. 根据`taskId + stepId`取得当前`exhibitCode`；
2. 利用短期对话把省略主语的追问改写成完整问题；
3. 按`exhibitCode`过滤，再召回TopK候选；
4. 去重后保留3～5个相关片段；
5. 证据不足时拒答，不让模型依靠参数记忆补全；
6. 生成答案和`chunkId`引用；
7. Java校验引用必须属于本次召回结果。

TopK从5开始，通过真实问题集比较Recall@K、答案忠实度和延迟再调整，不存在对所有数据都最优的固定值。

**问答Prompt。**

```text
角色：你是展厅专业讲解助手。
输入：当前展台、最近必要对话、原问题、改写问题和证据片段。
要求：
1. 只使用证据中的事实；
2. 证据不足时明确说明，不猜测；
3. 使用适合现场播报的简短中文；
4. 返回answer、citations和evidenceSufficient；
5. 不输出NEXT、STOP等机器人控制指令。
```

RAG只负责回答问题，永远返回`taskAction=KEEP_WAITING`，不能通过答案推进任务。

## 六、机器人执行与安全边界

### 本地技能、ROS2与动作编排

ZeroClaw可以向本机任务执行器注册以下能力：

```text
navigate_to(waypointId)
play_explanation(scriptCode)
execute_action(actionCode)
stop_current_operation(reason)
get_robot_state()
```

这些能力底层调用bot_mind或G1ControlServer。是否使用MCP是实现选择，不影响Java平台与机器人之间的业务协议。

**G1ControlServer。**

- 导航使用ROS2 Action：任务时间长，需要反馈、取消和最终结果；
- 动作和FSM切换使用Service：请求较短，需要明确返回；
- 机器人状态使用Topic：持续发布位置、姿态和运行状态。

导航和避障由团队已有的`g1_base`提供。项目负责接入导航结果，并协调导航、讲解和动作流程，不把导航算法作为个人实现。

**Unitree SDK隔离。**

硬件SDK运行在独立Python worker中，主ROS2进程通过stdin/stdout JSON通信：

```text
ZeroClaw → G1ControlServer → Python worker → Unitree SDK
```

这样可以隔离SDK运行环境、进程崩溃和多实例初始化冲突，降低SDK异常对主控制进程的直接影响。但进程隔离不等于调用一定不会等待，仍需为IPC设置超时、进程存活检查和重启后的状态核对；也不能把“杀掉worker”直接等同于机器人已经安全停止。

**三层动作体系。**

```text
snapshot：单个静态姿态
motion：由多个姿态构成的连续轨迹
script：语音、动作、等待等步骤的复合流程
```

通过`runtime_lock、action_lock、pause/resume、FSM校验和停止优先`协调导航、底盘、手臂和脚本资源。大模型只能选择已注册的动作编码，不能生成关节角度直接控制机器人。

### 异常处理

| 异常 | 处理 |
|---|---|
| Agent无法解析需求 | 回退标准路线或让工作人员补充信息 |
| 没有空闲机器人 | 任务保持待分配，提示人工选择或稍后重试 |
| WebSocket断开 | 不启动新步骤，重连后通过REST对账 |
| 两个入口同时下一站 | Java通过expectedStepId、planVersion和状态条件更新，只允许一次推进 |
| 命令重复 | ZeroClaw按idempotencyKey返回已有执行状态 |
| 导航或动作超时 | 标记UNKNOWN，先查询机器人状态，再决定恢复或人工接管 |
| 旧问答返回 | 校验任务状态、stepId和planVersion，过期结果不再播报 |
| 计划版本过期 | 停止旧版本后续下发，机器人确认新版本后再执行新命令 |
| 知识库无可靠证据 | 明确拒答并提示咨询工作人员 |
| 停止指令 | 识别后不经过LLM，机器人侧优先调用停止能力并上报平台 |

安全原则：

- 停止不依赖LLM；
- 机器人端保留最终运动安全校验；
- 模型输出先成为计划或意图，不能直接成为硬件命令；
- 所有展台、waypoint和动作编码必须来自已配置资源；
- 平台无法确认结果时标记为待核对，不能直接认为执行成功；
- 现场工作人员始终可以暂停和接管。

## 七、工程组织、部署与验证

### 代码结构（逻辑示意）

```text
com.example.robot.platform
├── robot
│   ├── RobotController
│   ├── RobotStateService
│   └── RobotConnectionManager
├── reception
│   ├── ReceptionTaskController
│   ├── ReceptionTaskService
│   ├── TaskStateMachine
│   └── CommandDispatcher
├── planning
│   ├── PlanningAgentService
│   ├── PlanningTools
│   ├── PlanValidator
│   └── RobotScheduler
├── interaction
│   ├── InteractionController
│   ├── RobotUtteranceHandler
│   └── GeneralChatService
├── knowledge
│   ├── KnowledgeIngestService
│   ├── QuestionRewriteService
│   ├── RagRetrievalService
│   └── QaAgentService
└── gateway
    ├── RobotWebSocketHandler
    └── RobotEventController
```

**机器人侧。**

```text
zeroclaw
├── platform_client       # Java平台通信
├── intent_router         # 精确短语 + 调用展厅Ollama小模型
├── task_runner           # 当前步骤执行
├── skill_registry        # 本地能力注册
├── skills
│   ├── navigation
│   ├── explanation
│   ├── action
│   └── emergency_stop
└── adapters
    ├── bot_mind_client
    └── g1_control_client
```

这是逻辑结构，不要求现有源码目录完全同名。面试时应说明实际模块名称与设计职责的对应关系。

### 测试与可观测性

- 意图路由：先测精确白名单是否只命中整句（尤其是“不要去下个站台”等否定句），再用标注语料测试小模型对暂停、寒暄、知识追问、改线、ASR错误和歧义输入的分类；重点统计控制命令误触发率与端到端P95时延；
- 规划校验：模型输出不存在的展台、超时路线和重复展台时必须拒绝；
- 调度并发：两个任务不能占用同一机器人；
- 推进并发：手机和语音同时发出下一站请求时只能推进一次；
- 命令幂等：同一命令重复下发时不能重复执行，事件重复和乱序不能回退状态；
- 超时对账：覆盖已执行但结果丢失、未执行和无法确认三种情况；
- 路线改版：旧版本在安全边界停止，新版本确认后再继续；
- RAG评测：标准问法、同义问法、跨展台问题和无答案问题；
- 机器人仿真：导航成功、失败、取消、断线重连和人工接管；
- 联调：从自然语言创建任务直到机器人回传完成事件。

**可观测性。** 日志统一携带：

```text
traceId、taskId、stepId、commandId、robotId、planVersion
```

重点指标：

- 任务完成率、平均接待时长；
- 机器人在线率和命令成功率；
- 命令下发到ACK、完成事件的P95延迟；
- 精确白名单误命中率、小模型分类准确率、控制命令误触发率、澄清率和P95时延；
- RAG Recall@K、引用正确率、无答案拒答率；
- 模型调用耗时、Token和失败率。

### 部署与模型边界

```text
中央服务器
├── Spring Boot中央平台
├── MySQL
├── Redis
├── PostgreSQL + pgvector
├── 本地M3E-base ONNX模型（768维Embedding）
└── Ollama + Qwen3-4B-Instruct-2507（语音意图分类）

移动提供的模型API
└── DeepSeek-V4-Flash（规划草案、改线草案与RAG答案生成）

每台机器人
├── ZeroClaw
├── bot_mind
├── G1ControlServer
├── g1_base
└── Unitree SDK worker
```

Java平台、业务数据、知识库、M3E和Ollama部署在展厅本地服务器，所有机器人共享同一份任务与知识数据。这里有**三个不同的模型角色**：ZeroClaw通过展厅内网调用Ollama中的Qwen完成一次语音意图分类；Java调用本地M3E生成检索向量，它不生成文字回答；Java通过移动API调用DeepSeek-V4-Flash生成路线草案、改线草案、专业知识答案或日常聊天回复。日常聊天不默认检索展台RAG；只有`KNOWLEDGE_QA`才检索。Spring AI在Java侧配置M3E `EmbeddingModel`和移动API的`ChatModel/ChatClient`即可，**不再额外配置一个Java侧Ollama意图分类器**。Ollama的具体接入方式取决于机器人侧ZeroClaw配置能否使用该模型服务，应在实际联调时验证。[Spring AI模型接口文档](https://docs.spring.io/spring-ai/reference/api/chat/ollama-chat.html)。

DeepSeek-V4-Flash于2026年4月24日发布，项目若描述2026年2月至6月的历程，应表述为**后期选型/接入**，不能说从项目启动就使用；而“移动提供的API支持该模型”属于当前项目设定，是否真实开放、网关的`modelId`、鉴权与网络路径须以实际分配为准。[DeepSeek官方发布说明](https://deepseek.com/en/news/v4-preview/)。ASR走云端，意图路由与Embedding在本地，规划/问答请求及检索片段会发送至移动API；这不是全链路离线部署，资料出域范围需按实际网关与保密要求核验。Ollama与M3E同机部署还要测CPU/GPU内存占用和高峰并发，不能只根据模型文件大小估计容量。

## 八、面试时怎么讲

### 九十秒项目介绍

> 这个项目面向展厅讲解和政务接待场景。展台导航点、讲解文稿和动作脚本提前配置，工作人员可以通过手机或机器人语音输入接待需求。Java中央平台使用Spring AI规划Agent，从已有展台中选择并排序路线，再由确定性调度器根据机器人楼层、在线状态、电量和占用情况完成分配，创建任务步骤并持续跟踪执行状态。
>
> 每台机器人部署ZeroClaw作为单机智能交互与技能编排层，通过REST和WebSocket接收平台下发的当前命令，调用bot_mind、G1ControlServer、g1_base和Unitree SDK完成导航、讲解及动作，并把执行事件回传平台。手机按钮直接进入Java业务接口；机器人语音先经云端ASR，ZeroClaw对极少量精确短语直接映射意图，其余调用展厅本地Ollama小模型分类一次，再把结构化意图交给Java。Java不重复分类：“下一站”由任务服务依据已审核路线推进；专业问题进入RAG问答，日常聊天由通用对话服务回答，改线才交给规划Agent生成草案。
>
> 我还负责G1动作编排和SDK隔离，使用Python worker封装Unitree SDK，设计snapshot、motion、script三层动作体系以及控制互斥和停止优先机制。项目最终打通了需求解析、任务规划、多机器人分配、单机执行、知识问答和状态反馈闭环。

### 高频追问速记

**1. 为什么Java和ZeroClaw不合并？**

Java负责全局业务一致性、多机器人调度与问答内容；ZeroClaw靠近机器人，负责单次语音意图判断、本机技能执行和断线收尾。分层后业务状态不会散落在每台机器人上，控制细节也不会侵入中央平台。

**2. 怎样区分知识问题和控制命令？**

精确匹配的停止短语由ZeroClaw优先处理，不等待LLM；极少量完整匹配的“去下一个站台”等短语可直接映射`NEXT`，其余语音由ZeroClaw调用展厅服务器上的Ollama小模型，结合当前展台、状态和短对话做**唯一一次**结构化分类。Java不再调用另一个意图模型，但仍检查任务状态、当前步骤和计划版本；有歧义时追问澄清。手机按钮直接进入业务接口。

**为什么已有ZeroClaw，还要部署Ollama小模型？**

ZeroClaw是机器人侧智能体运行与技能编排层，不等于模型本身；本方案让它使用Ollama提供的Qwen做意图识别。若ZeroClaw已经接入另一模型并能可靠完成相同分类，就不应再加第二个Ollama分类器。Java只接收结构化意图，不重复判断。

**3. 为什么问答不会误触发机器人动作？**

问答Agent与任务状态机隔离，只返回答案、引用和`KEEP_WAITING`；真正的动作只能由正式任务命令触发。

**4. 如何理解“它有什么优势”？**

使用`taskId:stepId:robotId`隔离短期对话记忆，结合当前展台和上一轮消息把代词补全，再执行RAG检索。

**5. 为什么用M3E和768维？**

M3E适合中文语义检索并可内网部署；`m3e-base`模型输出就是768维，数据库字段必须匹配，不能自行改成384维。

**6. 为什么使用pgvector而不是Milvus？**

当前只有二三十份资料，查询还需要按展台过滤。pgvector可以复用PostgreSQL运维体系，复杂度更低；规模和并发显著增长后再考虑专用向量数据库。

**7. 怎么防止两个任务分到同一台机器人？**

调度器先过滤候选，再在数据库事务中通过条件更新占用机器人；只有一个事务能把状态从IDLE改为BUSY。

**8. 超时为什么不能立即重发？**

可能只是ACK或完成事件丢失，机器人实际已经执行。平台先把命令标记为UNKNOWN，再按commandId查询状态；确认未执行才恢复执行，仍无法判断则暂停并转人工确认。

**9. 路线中途变化怎么办？**

Agent生成路线草案，Java校验后创建新的planVersion并停止旧版本后续下发；ZeroClaw到达安全边界并确认新版本后，Java才下发新版本命令。

**10. 手机和语音同时触发下一站怎么办？**

两个入口统一调用Java推进接口。`requestId`处理同一请求的重试，Java再使用`expectedStepId + planVersion + 当前状态`做事务条件更新，所以两个不同请求同时到达也只能有一个推进成功。

**11. ZeroClaw和bot_mind有什么区别？**

ZeroClaw负责单机器人语音意图判断、技能编排和平台命令执行；bot_mind提供ASR、TTS及本机能力适配。Java保存全局任务事实并决定下一站，三者不能互相越权。

**12. 是否实现了导航和避障算法？**

没有。导航和避障来自团队已有的g1_base；项目负责ROS2 Action接入、流程协同、动作控制和状态反馈。

### 一页速记

```text
规划Agent：理解需求，组合已有展台
精确白名单：只让少量完整匹配的短指令跳过模型，不跳过业务校验
ZeroClaw + 本地Ollama：对其余普通语音只分类一次，不直接控制导航目标
M3E ONNX：生成768维检索向量
移动API：生成规划草案、专业问答与不走RAG的日常聊天
Java平台：校验、调度、状态、问答和审计
ZeroClaw：单机器人技能编排、平台命令执行与事件回传
bot_mind：语音输入输出与本机能力适配
G1ControlServer：统一机器人控制入口
g1_base：导航与避障
Unitree worker：硬件动作执行
```

整个项目最重要的原则是：

> ZeroClaw用少量精确短语或本地小模型完成唯一一次语音意图判断；Java负责全局任务决策、规划与问答内容；ZeroClaw执行Java下发的明确命令，机器人控制层负责最终运动安全。
