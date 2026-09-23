# 多机器人中央调度平台：设计、执行与面试

> 场景：甘肃 5G 联合创新中心展厅接待。本文把中央调度平台作为项目设计来讲；机器人侧能力以现有 bot_mind、g1_base 源码为依据。文中的 Java 控制器、数据库表和机器人平台适配器是设计示例，不冒充现有源码。

> 2026-09-23 补充：面向**大厂校招**。用户确认：项目已上线验收，本人负责的中央规划 Agent、RAG 知识问答 Agent 均在验收范围内；实际两台机器人，一楼十几个展台，二楼约十个，需要按可扩展到多机器人的方式设计。机器人接入展厅 Wi-Fi；开发时电脑也接入该 Wi-Fi，并通过 SSH 登录机器人联调。**实际 Java—机器人业务对接协议待核实**。本文新增的事务、端侧账本、控制权、恢复和验收用例属于改进建议，不据此声称上线系统已经具备。代码片段用于解释边界，不是完整工程；十台机器人、二三十份资料为示例规模。

这份文档的已确认项目主线是：**管理员预配展台与讲解资源 → 中央 Agent 规划接待路线 → Java 校验和人工审核 → 机器人逐站执行 → 事件触发剩余路线重规划**。第四节补充“同类规划框架扩展到巡检”的设计，供架构与面试讨论；不能因此推断展厅已验收的 Agent 也在巡检项目上线。大模型不生成关节轨迹，也不负责实时避障。

**怎么学这篇文档。**先用第一、二节记住“谁决定路线、谁实际移动”；再用第三至六节跟着 T1001 走完一次接待和一次改线；最后用第七、八节准备问答与面试。读完应能不用术语复述：**提前配置什么、Agent 生成什么、人审核什么、Java 何时发什么、机器人回什么、两台机器人冲突时谁处理**。本文给出的 Java 类、表和通信协议是可落地的设计示例；它们与已在机器人源码中存在的能力会明确区分。

配套的 [大厂校招模拟面试题与答案解析](/central-scheduling-interview) 将项目深挖、系统设计、编码思路和行为追问整理为题单，答题时仍以本文的事实边界和本人代码证据为准。

**工程实施以 [V2 实施设计](/central-scheduling-v2-design) 为准。**本篇重在解释业务与面试推导；原先分散的“扩展设计/示意代码”在 V2 文档中被收敛为明确范围、开工门槛、数据约束、接口、事务、失败矩阵与验收定义。V2 是拟实施目标，不代表本项目已验收版本自动拥有这些能力。

**V2 相对本篇早期示例的关键升级。**规划 ChatClient 按任务调用只读工具查询候选机器人（当前楼层、心跳新鲜度、占用、能力）与已发布展台，输出「建议机器人 + 路线」；Java 把可修正的校验错误反馈给模型作一次有限修订，人工审核，点击下发时再核实并原子占用机器人。语音则由 Java **严格规则优先**：“下一地点”等完整、明确短句直接形成意图并进入业务校验；复杂、含否定或改线条件的表达才交意图 ChatClient；知识问题才进入当前展台 RAG。Java 从 bot_mind/Adapter 的心跳和执行事件维护状态快照，控制意图统一由 Java 查状态、权限和展台容量，过期时通过设备拉取通道 STATE_PROBE。以下保留的“只生成展台顺序”代码是较小的解释示例，**不再代表 V2 的完整设计**；V2 的工具调用也不能倒推为原上线版本的已证实能力。

### 先固定设计前提与事实边界

| 项目 | 本文采用的前提或边界 |
|---|---|
| 调度对象 | 展厅接待任务、机器人和展台容量；不承诺全局最优路径、厘米级会车或硬实时控制 |
| 业务流程 | 路线人工审核、访客到场后人工启动、讲完等待下一站；“十五分钟左右”是接待目标，不是平台能保证的结束时间，导航与开放问答可能使其超时 |
| 已确认规模 | 两台机器人；一楼十几个展台、二楼约十个。两台可分别接待或分楼层接力，实际部署分工需按现场情况描述 |
| 建议部署 | 单 Java 应用按模块组织、每台机器人最多一个活跃业务命令；实际已部署的服务拓扑另行核实 |
| 已有代码证据 | 本次可读取的 bot_mind/g1_base 中存在导航接入、讲解、动作适配与资源导入；没有据此验证真机表现或代码归属 |
| 用户确认事实 | 中央规划 Agent 和 RAG 由本人负责且已上线验收；本次未重新执行验收，不因缺少本地完整工程而否认项目经历 |
| 现场网络与开发方式 | 机器人接入展厅 Wi-Fi；开发电脑接入同一 Wi-Fi，通过 SSH 登录机器人联调；这只确认了开发访问路径 |
| 尚需技术核实 | 实际通信协议、中央工程位置、实际 RAG 模型/存储版本、端侧持久化及本文新增机制是否已经实现 |
| 巡检扩展定位 | 仅为同类规划框架的场景化设计；当前不声称展厅 Agent 已复用于巡检或巡检扩展已上线验收 |
| 交付判定 | “设计过”“实现过”“真机联调过”“上线验收过”分别举证；后文所有新增机制不能自动升格为已交付成果 |

**个人讲述边界：**重点讲自己负责的中央规划 Agent 和 RAG，包括需求输入、模型输出约束、业务校验、检索与引用、异常降级及效果评测。Java 任务状态机、审核与通信中哪些也由本人实现，应进一步列明；机器人适配器是“接收平台命令→调用机器人能力→回传结果”的端侧对接层，不能因为自己负责 Java 平台就默认也是本人实现。导航、动作控制与 ASR/TTS 按实际团队分工说明。

资深面试官的经验不等于候选人必须展示 Staff 级履历。实习/校招重在个人实现和完整链路；高级岗位还需解释取舍、故障恢复与验证；Staff 岗位需要真实的跨团队决策、推广和长期影响，不能靠补充架构术语获得。

## 一、先认识展厅里已经有什么

原来的手机平台能由工作人员逐项选机器人、点展台和开始讲解。增加中央平台，不是为了取代导航算法，而是解决三件跨设备的事：**自然语言接待要求怎样变成可审核的路线；多组访客怎样避免抢同一机器人或展台；讲解、问答、改线和异常怎样在一份任务记录中接续。**只有一台机器人、固定路线的小演示可以继续人工操作；多组接待和现场变化才让中央调度有明显价值。

管理员提前维护展台、导航点、讲稿和机器人。讲稿携带预配置动作标记，机器人按播放进度触发预设动作；中央 Agent 不现场生成讲稿或动作。现有 bot_mind 的讲解工具按当前点位名称读取本地 Markdown 文稿；本次核查的播放主链路通过 TTS 字幕元信息识别 VHML 动作，再异步触发动作服务。

| 已配置资源 | 示例 | 由谁维护 |
|---|---|---|
| 展台 | 液冷机柜，exhibitCode=LIQUID_COOLING | 管理员 |
| 导航点 | F1_WP_03，对应机器人本机的点位名称 | 管理员与导航团队 |
| 讲稿 | 液冷展台讲稿 V1，含预设动作标记 | 内容与机器人团队 |
| 机器人 | G1-01，可服务一楼，当前空闲 | 台账由平台维护；状态由机器人上报 |
| 知识资料 | 液冷 FAQ、产品说明 | 管理员审核后入库 |

例如工作人员说：“下午三点接待一组访客，一楼重点介绍液冷和具身智能，十五分钟左右。”工作人员确认具体日期和“十五分钟左右”是期望目标后，Agent 输出的是**从已有展台中选哪些、按什么顺序**，不负责给每段导航报时或给 G1 生成运动代码。固定路线仍可作为模板；只有接待重点、目标时长或现场条件变化时才需要重新规划。

这里的“讲稿内嵌动作”不能仅凭函数名推断实现。源码虽有将 `${...}` 转为 `<mark .../>` 的 `extract_actions_from_text`，本次在 `src` 中只找到其定义，未找到调用；实际检查到的 `VoiceService` 路径是注册字幕元信息回调，再由 `_on_new_subtitles` 解析 VHML 动作。面试应以实际资源格式和运行链路说明，不能断言占位符转换一定发生。[播放与动作回调](D:/Code/bot_mind/bot_mind/src/service/voice_service.py:315) 展台配置通过 `exhibitCode` 关联机器人认识的 `waypointName`；前者是 Java 业务标识，后者是机器人本机导航和查讲稿使用的名称，两者不是同一个字段。

一个完整接待还可能从一楼延伸到二楼：G1-01 在一楼迎宾并讲液冷、具身智能，参观者到电梯口后由工作人员确认交接，二楼的 G1-02 再接续对应展台。机器人不能自主乘电梯时，计划中把“跨楼层交接”作为人工确认节点，而不是假装一台机器人直接导航上楼。具身智能展台若有机器人与机器狗互动，互动脚本也由管理员预先配置，讲稿播放到对应标记时才触发；中央 Agent 只选中这个展台，不临时编造机器狗动作。

讲稿和点位在接待前批量导入机器人，不因每个任务而重复上传。现有 bot_mind 提供 POST /data/import 上传 ZIP、GET /data/import/{jobId} 查询异步结果；导入成功不自动切换当前激活展厅。平台必须核对机器人的点位与讲稿资源已经就绪。严格的“审核后不变”要求讲稿版本不可变或有内容校验值；若机器人端总是读取被覆盖的同名文件，只在 Java 保存 V1 字样并不能保证执行的真是 V1。

旧版文档中的资源导入接口例子值得保留，关键是**区分上传成功与真正可执行**：Java 对相关机器人发送 `POST http://<机器人内网地址>/data/import`，以 multipart 传 ZIP；接口返回 `202` 和 `job_id` 后，再查询 `GET /data/import/{job_id}` 直到成功。随后核对当前激活展厅、点位名称和讲稿文件是否一致。这里的 `/data/import` 是 bot_mind 已有接口；“Java 统一检查各机器人资源版本”仍是平台设计。不能在每次接待开始时重新上传整套 ZIP，也不能仅凭 HTTP 202 就开始任务。

## 二、架构与职责：中央决策，本机执行

~~~text
手机操作或机器人麦克风
         │ 语音由 bot_mind 接入 ASR 并转文字
         ▼
Java 中央平台（实际服务器位置待核实）
├─ 规划 ChatClient：展厅接待的初次路线与事件触发的剩余路线草案
├─ 意图 ChatClient：把开放式语音转换为受限意图候选
├─ 业务服务：展台配置、人工审核、任务状态、机器人和展台占用
├─ 问答 ChatClient：按当前展台检索资料并生成回答
└─ 通信服务：向指定机器人下发当前命令，接收心跳和执行事件
         │ 业务接口与状态通道（下文以 REST + WebSocket 举例，实际协议待核实）
         ▼
每台机器人：平台适配器（需要新增）→ bot_mind → g1_base
                                      │
                                      ├─ G1ControlServer：统一控制入口
                                      ├─ NavigationManager：定位/Nav2运行管理
                                      ├─ 导航栈：路径规划、避障
                                      └─ SDK 桥接/worker：动作硬件调用
~~~

**Java 平台不是几段提示词。**三个 ChatClient 分别做规划、意图分类和问答，可以共用同一个 ChatModel；它们是调用配置与职责隔离，不是三个独立部署的智能体。任务状态、资源占用、审核、下发和异常对账由普通 Spring Boot 业务服务负责。规划模型只提出建议，Java 查库和状态机决定能否执行。

**机器人侧不必强行加入 ZeroClaw。**现有 bot_mind 已有 navigate_to、booth_show、停止及 G1ControlClient 等本机能力。若采用“Java 统一识别与调度”的主方案，只需新增一个确定性的机器人平台适配器：收命令、调用已有工具、按命令编号回报进度。本机避障和安全停止仍由导航/控制层负责。ZeroClaw 可作为以后确有离线自治或复杂本机技能编排需求时的可选层，而不是本项目的必经层；不能把未实现的适配器说成现有 bot_mind 接口。

**g1_base 的包含关系。**g1_base 是 ROS 2 功能包，G1ControlServer 与 NavigationManager 是其中的节点，不是三个并列系统。导航算法由导航栈处理；本文的中央平台只选择业务目标展台，不计算机器人局部绕障轨迹。G1 动作侧的 snapshot（静态姿态）、motion（连续轨迹）、script（复合脚本）及 SDK Python worker 仍属于机器人控制实现，中央 Agent 只引用已经配置好的讲稿。

若面试官顺着简历追问机器人控制：导航是耗时且需要进度、取消和最终结果的操作，所以由 G1ControlServer 通过 ROS 2 Action 接入；动作触发、FSM 切换等较短的控制走 Service，持续运行状态通过 Topic 发布。NavigationManager 管理定位/Nav2 等进程的就绪与健康，不是“中央 Agent 算的路径”；真实路径规划和局部避障仍在导航栈。动作侧以 snapshot 表示姿态、motion 表示连续轨迹、script 组合多个动作/等待；讲稿标记只调用**已经登记**的动作资源。SDK 桥接把硬件调用隔离到独立 Python worker，经 stdin/stdout JSON 通信，降低阻塞和异常对主 ROS 进程的影响，但仍需 IPC 超时、互斥与安全停止；不能把“worker 进程退出”当作机器人已安全停住。

**可核对的机器人侧依据。**`bot_mind/src/mcp/tools/navigate_to.py` 接收 `waypoint_name` 并调用导航服务；`bot_mind/src/mcp/tools/booth_show.py` 根据当前点位读取对应的 `.md` 文稿；`bot_mind/src/service/voice_service.py` 处理播放及字幕动作回调；`bot_mind/src/api/data.py` 提供 ZIP 导入接口；`g1_base/g1_base/g1_control_server.py` 和 `navigation_manager.py` 是本机控制与导航节点。本次所核查代码不足以重建已验收中央平台的完整链路；下文适配器和 Java 协议仍按设计示例理解，不能据此否认另有真实对接实现。

**中央模式必须拥有唯一控制入口。**已有手机网页会直接调用 `navigate_to_next_waypoint`，它依据本地点位列表选下一点；中央计划 A→C 不会自动改变本地 A→B→C。新增接待模式必须让手机和被授权的语音请求统一进入 Java，由 Java 下发明确的 `waypointName`，同时在机器人控制入口禁止普通调用绕过平台。维护模式要先冻结中央下发、核对当前命令已结束或停止，再切换控制权；恢复接待前重新对账。本地停止始终保留优先级。只隐藏旧按钮不足以实现控制权隔离。[已有手机下一站调用](D:/Code/bot_mind/bot_mind/src/web/boothshow.html:3034)

**网络现场事实与业务协议分开讲。**机器人通过展厅 Wi-Fi 接入网络；开发联调时，开发电脑也接入展厅 Wi-Fi，并用 SSH 登录机器人。SSH 是开发人员进入机器人系统的远程登录方式，这个事实不能推出 Java 下发命令也走 SSH，更不能推出已实现 WebSocket 心跳、事件回传或端侧持久化。它说明当时的开发电脑可以通过网络到达机器人的 SSH 服务；Java 服务部署在哪台机器、从 Java 到机器人的实际请求方向、端口和协议，仍要看代码、配置和调用日志。机器人与平台间即使在展厅 Wi-Fi 内也要做设备身份校验，不能把“连上同一个 Wi-Fi”当成业务授权。

## 三、一张接待计划在系统里是什么

这里有三个容易混淆的概念：

~~~text
Task：整场接待，例如今天 15:00 的领导参观
  └─ Step：一个展台的访问，例如“第 1 站参观液冷”
       └─ Command：执行到该站时发给一台机器人的本次命令
            └─ Event：机器人收到、导航中、到站、讲解中、完成或失败的反馈
~~~

**生成计划时就有完整的 Step。**例如 T1001 包含 S1=液冷、S2=具身智能，两站的导航点和讲稿版本都已从配置中确定。此时尚未给机器人发命令，也不需要在早上九点就占用下午三点要使用的 G1-01。工作人员确认访客到场、分配机器人并执行到 S1 时，Java 才创建本次 Command C101 并发送。Command 是带状态的业务命令记录，不是切面自动生成的访问日志。

用一场任务把四层关系具体化：

| 时间 | MySQL 中新增或变化的内容 | 机器人看到什么 |
|---|---|---|
| 09:00 创建接待草案 | T1001=PENDING_REVIEW；S1=液冷、S2=具身智能，均带已配置资源快照 | 暂时什么都不知道 |
| 09:05 审核通过 | T1001=SCHEDULED、planVersion=1；步骤顺序确定 | 仍未收到整条路线 |
| 15:00 工作人员确认到场 | T1001=RUNNING；G1-01 被本任务占用 | 收到当前 S1 对应的 C101 |
| 15:03 到站并讲解 | C101 的各阶段事件写入 execution_event；S1=IN_PROGRESS | 导航、播讲稿、执行讲稿中预配的动作 |
| 15:05 讲解及必需动作完成 | C101=SUCCEEDED；S1=WAITING_COMMAND | 停留，允许问答并等待工作人员推进 |
| 15:06 手机点击“下一站” | S1=COMPLETED；针对 S2 创建 C102 | 只收到下一站 S2，不知道未来完整路线 |

这样区分了两个常见误解：**Step 是审核后的计划，Command 是一次实际下发，Event 是执行反馈。**一条 Step 因取消、重试或恢复，可能关联不止一条 Command；一条 Command 会有多条 Event。不能用“命令已发送”替代“机器人执行完成”。

**为什么需要四层，而不是一张任务表保存当前状态？**四层分别回答“哪场接待、计划去哪些站、本次实际发了什么、机器人实际上发生了什么”。例如 S1 计划访问液冷展台，第一次下发 C101 后网络中断，工作人员确认旧命令已终结后又创建 C102 恢复执行；若只有 Step 的一个 `status`，就无法同时保留两次尝试及其反馈，也难以判断超时后能否安全重试。Command 不是 AOP 自动生成的访问日志，而是参与去重、超时和恢复的业务对象；Event 是不可随意覆盖的过程事实。四层是逻辑边界，不意味着必须为每个导航坐标、心跳或日志都增加事件。

**这套设计是否过度，要看承诺的可靠性，而不只看机器人数量。**两台机器人只要允许并行接待、手机与语音同时推进、运行中改线或断线恢复，Task/Step/Command/Event 仍有实际意义；但一期不需要一次实现后文所有增强能力。可按下面的范围落地：

| 阶段 | 保留能力 | 暂缓能力 |
|---|---|---|
| 最小闭环 | Task/Step、当前 Command、成功/失败关键 Event；Java 顺序调用已有 `navigate_to` 与 `booth_show`；异常转人工 | 实时导航轨迹、复杂自动恢复、多实例、消息中间件 |
| 可靠执行 | `commandId` 去重、端侧接收记录、关键阶段回报、取消确认、断线重连对账 | 全量遥测入库、跨机房高可用 |
| 多机器人增强 | 展台容量事务、计划版本、共享资源冲突和事件触发改线 | 没有真实规模依据的复杂调度算法 |

因此，更合适的实现路线是**轻量四层模型，复用 bot_mind 已有工具，再按验收需要补可靠性**。若只要求一次现场演示，Java 直接 HTTP/MCP 调用机器人工具就能跑通正常链路；若要求重复下发不重复执行、掉线后知道进行到哪里，就必须新增机器人平台适配器和命令对账，单靠 WebSocket 或多建表都不能自动获得这些能力。

| 数据 | 存储与生成时机 | 用途 |
|---|---|---|
| robot、exhibit、explain_script | MySQL；管理员提前配置 | 机器人台账、展台—点位、讲稿版本 |
| reception_task、task_step | MySQL；草案保存、审核后成为正式计划 | 接待时间、当前计划版本、有序展台及资源快照 |
| robot_command、execution_event | MySQL；实际下发与回报时产生 | 去重、执行状态、断线对账与审计 |
| route_revision、incident | MySQL；现场事件与改线时产生 | 记录触发原因、旧新版本和审核结果 |
| exhibit_reservation | MySQL；安排下一站前占用 | 避免两个接待组同时抢占容量有限的展台 |
| 机器人最新位置、电量、心跳 | Redis；机器人持续上报并设置过期时间 | 实时展示与调度，不把每个坐标点写入任务表 |
| knowledge_document | MySQL；资料上传时登记 | 原文件、所属展台、导入状态 |
| 知识片段、元数据、embedding | PostgreSQL + pgvector；离线入库 | RAG 按展台过滤和语义检索 |

pgvector 是 PostgreSQL 的扩展，不是另一个独立数据库。知识片段表的一行可以同时保存 chunkId、docId、exhibitCode、content 和 768 维 embedding；docId 关联 MySQL 中的文档管理记录。原始 PDF 可以放在文件存储中。

**为什么不是所有信息都进一张库？**MySQL 保存需要事务和版本控制的接待事实；Redis 放会不断变化、允许过期的机器人最近状态；PostgreSQL+pgvector 保存适合向量检索的知识片段。Redis 里的在线状态消失，不会把 MySQL 的任务历史删掉；pgvector 找到的是问答证据，不决定机器人下一站。

这是**沿用已有 MySQL/Redis 平台时**可解释的选择，不是三套存储的必要性证明。若从零建设一期，业务数据与向量可以统一放 PostgreSQL，少量遥测也可先保存在进程内并在重启后重建；是否引入 Redis 由多实例共享与访问负载决定。本文保留 MySQL 事务示例以便对接既有 Java 技术栈，不能把当前巡检仓库的部署配置直接当成本展厅项目配置。若保留两套关系库，文档入库需要任务状态、幂等 chunk 标识和失败重试；两库没有跨库外键或天然事务一致性，只有已发布知识版本可供检索。

**步骤快照为什么必要？**S1 保存审核时的 waypointId、讲稿版本或内容校验值。管理员后来改默认讲稿，已审核任务不会无声切换；中途改线只更新未执行的步骤版本，历史步骤和事件保留。机器人端也必须能找到并校验该版本，否则 Java 的快照无法约束真实播放内容。

## 四、初次规划：一句话到审核后的路线

**先看 V2 的完整目标。**模型不凭一句话猜哪台机器人可用：Java 给本次规划暴露 findCandidateRobots、listReachableExhibits 两个受限只读工具；模型依据真实候选输出 suggestedRobotId 和有序 exhibitCode。工具读取机器人台账与由心跳/事件维护的状态快照，楼层未知或状态过期的机器人不得作为“可用”。Java 校验机器人、必经展台、楼层和版本，把可修正错误反馈给模型修订；工作人员审核后，下发时重新读取状态并占用建议机器人。原项目这条工具调用链是否已上线，仍须以中央 Java 工程和运行记录核实。

以“两台机器人、一楼两组访客”为例，先看其中一组：

~~~text
工作人员输入需求
  → Java 查可选展台/模板/讲稿配置，记录人工确认的接待时间与目标时长
  → 规划 Agent 产出有序 exhibitCode 草案
  → Java 校验存在性、楼层、资源版本；独立评估时间目标的可达程度
  → 工作人员查看路线并审核
  → MySQL 保存 T1001 与全部 Step，状态 SCHEDULED
  → 到场前检查就绪；访客到场后才分配机器人并开始
~~~

规划结果的最小结构如下。开始时间和“十五分钟左右”的目标由请求侧记录并经工作人员确认，不由模型生成；Agent 不需要输出 NAVIGATE/EXPLAIN 活动列表或每站耗时：每个展台的本机执行流程已由机器人侧固定配置。

~~~json
{
  "exhibits": [
    {"exhibitCode": "LIQUID_COOLING"},
    {"exhibitCode": "EMBODIED_AI"}
  ],
  "reason": "先介绍液冷设施，再介绍具身智能演示"
}
~~~

**Agent 为什么能规划，又为什么不能直接下发？**Java 先把启用中的展台列表、楼层、讲稿配置和可用时段作为受控上下文交给规划 ChatClient。模型根据“重点讲液冷和具身智能”选择编码并排序。模型输出的是候选路线；Java 再逐项检查：编码是否真的存在、是否重复、是否有对应点位与讲稿、两台机器人是否存在明显的同站冲突。时间目标由 Java 独立评估并向审核人说明不确定性，不能因为模型声称“十五分钟可完成”就批准。若模型输出一个不存在的 `EXHIBIT_X`，即使 JSON 完全合法，也要拒绝或请人修改。审核页面把这些判断和冲突原因展示给工作人员，点击通过后才进入 `SCHEDULED`。

例如两段讲稿配置分别为 4 分钟和 5 分钟，仅讲稿就占 9 分钟；剩下的 6 分钟还需覆盖迎宾、机器人导航、开放问答和可能的等待，因此**不能据此断言整条路线能在 15 分钟内完成**。机器人本地 Nav2 执行导航，Java/Agent 不决定实际路径、速度或避障耗时。若连已配置的讲稿时长都超过目标，Java 可明确提示目标冲突；若导航尚无可靠耗时数据，就展示“移动时间未知、整体时长无法保证”，由工作人员删减展台、调整目标或接受超时风险，而不是编造一个精确总时长。

**Spring Boot 分层示例（设计代码）。**Controller 接收请求；PlanningService 调用 Spring AI；TaskService 在事务中校验并保存；Mapper 负责 SQL。代码只展示关键边界，不代表原项目仓库已有这些类。

~~~java
// DTO：开始时间和目标时长由人确认；模型只输出已配置的展台编码与顺序
record RequirementRequest(String text, OffsetDateTime plannedStartAt,
                          Integer targetMinutes) {}
record VisitChoice(String exhibitCode) {}
record PlanDraft(List<VisitChoice> exhibits, String reason) {}

@RestController
@RequestMapping("/api/reception-tasks")
class ReceptionController {
    private final PlanningService planning;
    private final TaskService tasks;

    @PostMapping("/drafts")
    PlanView create(@RequestBody RequirementRequest request) {
        return planning.createDraft(request);
    }

    @PostMapping("/{taskId}/approve")
    void approve(@PathVariable String taskId,
                 @RequestBody ApproveRequest request) {
        tasks.approve(taskId, request.expectedPlanVersion());
    }
}

@Service
class PlanningService {
    private final ChatClient planningChatClient;
    private final ExhibitMapper exhibitMapper;
    private final TaskService tasks;

    PlanView createDraft(RequirementRequest request) {
        List<ExhibitOption> allowed = exhibitMapper.listEnabled();
        PlanDraft draft = planningChatClient.prompt()
            .system("只从给定展台中选择并排序；不得编造展台、导航点、讲稿、动作或耗时。")
            .user("需求：" + request.text() + "；目标分钟数：" + request.targetMinutes()
                + "（仅作选站偏好，不得承诺完成时间）；可选展台：" + allowed)
            .call().entity(PlanDraft.class);
        return tasks.saveDraft(request, draft); // 模型调用不占用数据库事务
    }
}

@Service
class TaskService {
    private final ExhibitMapper exhibits;
    private final ReceptionTaskMapper tasks;
    private final TaskStepMapper steps;

    @Transactional
    PlanView saveDraft(RequirementRequest request, PlanDraft draft) {
        requireConfirmedStartPositiveTargetAndUniqueCodes(request, draft);
        String taskId = newTaskId();
        tasks.insert(taskId, request.text(), request.plannedStartAt(),
                     request.targetMinutes(), "PENDING_REVIEW", 1);
        int order = 1;
        for (VisitChoice choice : draft.exhibits()) {
            ExhibitConfig config = exhibits.findEnabled(choice.exhibitCode());
            requireUsableWaypointAndImmutableScript(config);
            steps.insert(newStepId(), taskId, order++,
                         snapshotOf(config, configuredDuration(config)),
                         "PENDING");
        }
        return tasks.loadPlan(taskId);
    }

    @Transactional
    void approve(String taskId, int expectedVersion) {
        requireReviewerConfirmed(taskId); // 从已认证会话取得审核人，并校验展厅权限
        revalidateDraftResourcesAndExplainTimeRisk(taskId, expectedVersion);
        if (tasks.markScheduled(taskId, expectedVersion) != 1)
            throw new ConflictException("计划已经变化，请重新查看");
    }
}

@Mapper
interface ExhibitMapper {
    List<ExhibitOption> listEnabled();
    ExhibitConfig findEnabled(String exhibitCode);
}
@Mapper
interface ReceptionTaskMapper {
    void insert(String id, String requirement, OffsetDateTime when,
                Integer targetMinutes, String status, int version);
    int markScheduled(String id, int expectedVersion);
    PlanView loadPlan(String id);
}
@Mapper
interface TaskStepMapper {
    void insert(String id, String taskId, int sequence,
                StepSnapshot snapshot, String status);
}
~~~

Mapper 的关键审核 SQL 是条件更新：只有页面看到的版本仍是当前版本时才通过，避免两个工作人员覆盖彼此的修改。

~~~sql
UPDATE reception_task
SET status = 'SCHEDULED'
WHERE task_id = :taskId
  AND status = 'PENDING_REVIEW'
  AND plan_version = :expectedVersion;
~~~

结构化输出只保证容易解析，不能保证展台真实存在。Java 仍要逐项查配置，并让人确认自然语言中的“下午三点”究竟是哪一天。模型失败时可以回退标准路线或要求手动选择，不应凭空生成一条路线。

### 4.1 为什么需要模型，路线怎样才算可行

模型负责把“重点看算力、希望十五分钟左右”映射到已有展台和偏好；“十五分钟”是请求侧的目标，不是模型计算出的完工承诺。固定路线直接选模板。若需求已经是明确展台集合和顺序，就不再调用规划模型。没有做多轮自主工具执行时，可称“受约束的规划 Agent/LLM 工作流”，不夸大为自主多 Agent 系统。

Java 的校验分两层：**硬约束**包括展厅/楼层、设备能力、开放时间、资源包版本、必经展台、已配置点位的可达关系与交接条件；**软偏好**包括重点覆盖、少走路、少等待和目标接待时长。硬约束不满足就返回具体原因；模型写一段理由或人工点击通过都不能让不可行方案变可行。人工要改变需求或配置后重新审核。若业务要求的是绝对截止时间，未知的导航和问答耗时使平台无法保证准点结束，必须把该限制交给工作人员确认或调整，不把软目标伪装为已验证的硬约束。

**时间怎样判断？**平台先读取讲稿配置的播放时长或实测讲解时长，得到可解释的讲解基线；它也只是估计，TTS、动作、打断都会改变实际值。点位间移动时间只有在导航侧提供历史出发/到达事件、现场人工计时或双方确认的估计值时才纳入区间估算，并标明来源、样本量和适用条件。仅知道点位连通，不等于知道走多久；没有依据的路段标记为“未知”，不能拿地图直线距离或模型猜测填空。迎宾、自由提问、排队和楼层交接同样可能变化，计划界面应分别显示已知基线、可用估计、未知项和超时风险，不能只给一个“预计 14 分 32 秒”的数字。

执行时，Java 只根据机器人回报的出发、到站、讲解完成等事件计算**已耗时**，结合当前剩余站点重新评估目标；导航超时由机器人侧上报，本地导航栈处理路径和避障。若已超目标或剩余时间明显不足，平台提示工作人员删减可选站、延长接待或结束，不擅自提高机器人速度、缩短固定讲稿或自动跳过必经站。这个时间评估是调度辅助信息，不能替代机器人导航侧的 ETA 和安全控制。

二十多个展台的起步方案可用人工模板、确定性校验和小范围候选排序，不需要先上强化学习、全局多机器人路径算法。对同一批需求比较“人工模板”与“模型草案”：看有效路线比例、必须展台覆盖、工作人员修改幅度和从提出需求到最终审核的总耗时。只有模型调用快，不等于接待准备更快。

**预约不是每张任务写一条 @Scheduled。**任务的计划开始时间存 MySQL；固定频率扫描器查即将开始的 SCHEDULED 任务，条件更新为 PREPARING，完成资源就绪检查后设 READY。工作人员确认访客到场后，再次校验并占用机器人，才开始下发。进程重启后扫描仍可从数据库恢复预约；到点本身不代表机器人自动出发。

旧版中的动态预约解释可以再落到一行关键条件：扫描器可以每十秒查询“未来五分钟内要开始”的任务，但只有 `UPDATE reception_task SET status='PREPARING' WHERE task_id=? AND status='SCHEDULED'` 更新到一行的执行者才负责准备。这样即使重复扫描或两个 Java 实例同时扫描，也不会各自启动一遍。若准备过程中进程崩溃，要按超时的 `PREPARING` 记录恢复或转人工，而不是让任务永久卡住。工作人员尚未确认到场时，`READY` 只表示资源就绪，不等于导航命令已经发出。

**机器人怎么选？**预约时可以展示候选名单，但不提前锁定下午三点要用的机器。开始前重新读取在线心跳和台账，过滤禁用、离线、导航服务未就绪、电量不足、楼层不符或正在带其他访客的机器人，再按距迎宾点和余量选一台。真正分配时用事务或条件更新抢占，例如仅当 `robot_id='G1-01' AND occupancy='IDLE'` 才改为 `BUSY`；更新不到一行就换候选或让工作人员处理。二楼接力的 G1-02 也应在交接前再确认，而不是预约当天早上一直占用。在线只是能联系到，**不等于可调度**。

### 4.2 扩展设计：同一规划框架面向巡检

**这里是方案设计，不是展厅项目的新增验收事实。**当前仓库另有巡检规划链路，例如 `raccoon-cloud-drone` 中的 `PlanningEndToEndService` 和 `TaskGenerateService`；其存在不能证明它与已验收的展厅规划 Agent 是同一个 Java 类、同一套部署或共享过同一模型配置。面试时可以说“我把展厅规划的约束和审核思路抽象为可复用框架，设计了巡检场景适配”；只有实际代码、部署和验收记录齐备，才说“一个 Agent 已同时服务两个场景”。

两种业务可以共用**受控输入 → 候选计划 → Java 校验 → 人工审核 → 执行事件 → 剩余任务重规划**的骨架，以及模型调用、结构化解析、审计和失败降级的基础能力；它们不能共用一份展厅专用 Prompt、`exhibitCode` 输出结构或 `reception_task` 业务表。`sceneType` 应由已认证的业务入口确定，再选择对应场景适配器，不让模型根据一句模糊指令猜当前要控制接待还是巡检。

| 边界 | 展厅接待 | 设备巡检扩展 |
|---|---|---|
| 规划输入 | 访客关注点、可选展台、讲稿与目标接待时长 | 设备台账、待检点位、巡检规程、任务窗口、终端能力及现场限制 |
| 模型候选 | 已配置 `exhibitCode` 的有序列表与理由 | 已登记设备/检查点编码的候选集合、顺序建议与理由；不编造传感器和作业动作 |
| Java 硬校验 | 展台/楼层/点位/讲稿可用，机器人和展台容量可取得 | 设备与点位存在、必检项覆盖、终端传感器和电量满足要求、禁入区/安全规则与资源冲突通过检查 |
| 业务结果 | 待审核的接待路线与逐站讲解步骤 | 待审核的巡检任务/工单，检查项和采集要求由已发布规程与配置生成 |
| 执行与改线 | 机器人到站讲解，访客改线或导航受阻时重排未执行展台 | 终端执行检查并回传采集结果；异常复检或漏检只作用于未完成/待补检点位 |

例如“今天检查 A 区 1—3 号设备的温度，异常时复查”，巡检适配器先查设备和点位清单、已发布规程以及可用终端，再让模型在**允许的检查点编码**中提出草案。Java 根据规程确定是否必须使用测温传感器、哪些点位必检，检查终端能力和安全限制，再生成待审核工单。模型输出合法 JSON 仍可能漏掉 2 号设备，必须由覆盖校验拒绝；后续若匹配的终端没有测温能力，也由能力校验拒绝或重新分配。巡检点位之间的真实移动或飞行由对应导航/飞控链路负责，中央规划不能凭模型给出的分钟数保证截止前完成；涉及无人机时还需独立的航线、禁飞和飞前安全检查，不能把展厅机器人的点位规则直接套用。

实现上可以保留一个 `PlanningOrchestrator`，按场景选择 `ReceptionPlanningPolicy` 或 `InspectionPlanningPolicy`；每个 Policy 拥有自己的受控候选数据、Prompt/输出 Schema、Java 校验器、审核与任务持久化适配。共用同一个底层 `ChatModel` 也只是基础设施复用，**不等于一个 Prompt 就能处理两类业务**，更不代表两个自主协作的 Agent。巡检规程需要知识检索时，检索结果作为有版本和来源的参考，安全硬约束仍须由已发布规则与 Java 校验；展厅接待规划不因共用框架就必须接 RAG。

### 4.3 只有“生成计划”一个功能，怎样证明智能规划价值

功能数量不是判据。若当前已交付能力只有一次路线草案生成，就如实称为**受约束的接待计划生成**；不能把本节的动态优化、自动改线或多机全局最优说成已实现。它仍可以体现价值，但必须证明对同一批自然语言需求，模型比固定模板更好地理解接待重点，并且经过 Java 校验后形成更少人工修改的可审路线。仅展示一句话生成 JSON、模型解释得很流畅，证明不了规划质量。

可做一组对照用例：同一句“重点看液冷与具身智能，约十五分钟”分别交给人工模板和模型辅助；再改变一个真实前提，例如其中一个展台暂停开放、另一组访客已占用某站或机器人只支持一楼。记录**候选输入快照、模型原始草案、Java 拒绝/通过原因、工作人员最终路线**。展台不可用时是否不再选它、必经展台是否保留、冲突是否被提示、工作人员改动是否减少，比“输出了几个展台”更能说明效果。若上线版本尚未把实时资源交给规划调用，就不能用后续设计的动态场景作为已验收效果。

增强时先加三项有业务意义的能力：①将接待重点、必经/可选展台与楼层等需求解析为可核对约束；②从已配置展台生成少量候选顺序，用确定性规则过滤硬约束，并把取舍原因展示给人；③访客改线或导航受阻后只针对未执行步骤提出新草案，保留已完成事实并再次审核。两台机器人、二十多个展台不需要先移植巡检系统的 TSP、RRT* 或“PPO”名词。若没有可靠移动时长，就比较可达性、楼层切换次数和已知资源冲突，不虚构最短耗时。量化时至少比较有效草案率、必经点覆盖、人工修改次数和需求提出到审核完成时间，并标明样本数和对照条件。

**巡检项目为何看起来更复杂？**本仓库的巡检 `PlanningEndToEndService` 将自然语言解析与 `TaskGenerateService` 串成链路；后者依次读终端状态、查询规程与拓扑、计算优先级、按传感器/电量等条件筛终端并做贪心分配，再生成访问顺序和路线，向 CMMS 提交待审核工单；故障复巡也会构造新任务再走这条链。这是多个确定性服务加 LLM 解析构成的规划流水线，不意味着大模型独自推导所有决策。代码中的 `PpoSimulationModel` 明确是启发式奖励代理，不是真实训练的 PPO 推理；端到端入口每次给预演传入单个任务，不能据此宣称已验证多机冲突预演；`TaskDispatchService.dispatchToEdge` 目前仅写日志，也不能据此声称该入口已完成真实边缘下发。巡检的复杂度主要来自设备、传感器、优先级和航线等业务维度，展厅应借鉴“事实输入、约束检查、可解释选择、失败回退”，不照搬整套链路或把另一项目的实现当成展厅验收证据。

## 五、下发一个展台：Java 与 bot_mind 怎么衔接

本文采用**一站一个 VISIT_EXHIBIT 业务命令**，机器人端新增的确定性适配器把它拆成本机已有工具调用：

~~~text
Java 读当前已审核 Step，创建并提交 Command C101
  → 给 G1-01 发送 VISIT_EXHIBIT(waypointName, scriptVersion)
  → 机器人适配器调用 bot_mind.navigate_to
  → 本地导航栈执行路径规划与避障，回报到站
  → 适配器核对当前点位，再调用 bot_mind.booth_show
  → bot_mind 播放已配置讲稿，按讲稿动作标记执行动作
  → 回报讲解完成，Java 将 Step 设为 WAITING_COMMAND
  → 访客提问或要求“下一站”；不会自动越过等待点
~~~

现有 navigate_to **只负责导航**，booth_show **另行读取当前点位对应讲稿并播放**；所核查的工具本身不提供本文的中央命令闭环，组合与回报方式需核对实际适配实现。Java 的一条业务命令下可以有 RECEIVED、NAVIGATING、ARRIVED、EXPLAINING、EXPLAINED 等多条事件；EXPLAINED 使 Command 成功、Step 进入 WAITING_COMMAND，导航到达不等于讲解完成。

适配器内部的两个现有工具调用可以记成：

~~~text
navigate_to({"waypoint_name":"液冷机柜"})
  → 确认成功且当前点位匹配
booth_show({"user_text":"开始讲解展台"})
  → 播报本机已经导入的“液冷机柜.md”，期间触发讲稿内动作标记
~~~

这里的组合、命令去重和事件回传是**新增适配逻辑**；不是让规划 Agent 再调用一次大模型来决定“现在该不该讲解”。

**完成信号必须补齐。**当前 `booth_show` 调用 `speak(..., publish_tts_events=False)`；语音提供者有等待播放结束的逻辑，但工具返回值没有完整区分自然结束、打断和所有动作结果。`ActionService.execute_action_async` 启动后台线程，不能据 `booth_show.success=true` 推断动作全部成功。新增适配器应为播放分配 `playbackId`、为必需动作关联 `actionRunId`，分别记录成功/失败/取消；只有音频正常结束、必需动作确认完成且运动模式恢复成功，才能发 `EXPLAINED` 并使 Command 成功。若底层只能报告“已接受动作”，必须补结果接口或人工确认，不能伪造完成事件。停止时还需取消未触发的动作标记，防止播报已停而延迟动作继续执行。[讲解工具](D:/Code/bot_mind/bot_mind/src/mcp/tools/booth_show.py:126)、[异步动作](D:/Code/bot_mind/bot_mind/src/service/action_service.py:20)、[播放结束处理](D:/Code/bot_mind/bot_mind/src/voice/providers/tts/aliyun_tts.py:376)

发送示例（设计报文，不是现有接口）：

~~~json
{
  "commandId": "C101",
  "taskId": "T1001",
  "stepId": "S1",
  "robotId": "G1-01",
  "planVersion": 1,
  "assignmentEpoch": 7,
  "commandSeq": 1,
  "type": "VISIT_EXHIBIT",
  "payload": {
    "hallId": "HALL_F1",
    "mapVersion": "F1-MAP-001",
    "exhibitCode": "LIQUID_COOLING",
    "waypointName": "液冷机柜",
    "resourceBundleVersion": "F1-BUNDLE-001",
    "actionBundleVersion": "G1-ACTIONS-001",
    "scriptVersion": "V1",
    "scriptSha256": "<实际讲稿内容的SHA-256，示例占位>"
  }
}
~~~

在本文的增强方案中，命令先落 MySQL，再在事务提交后通过业务通道通知指定机器人；WebSocket 只是其中一种设计选项，不能由已知的 SSH 联调方式推定为实际上线协议。不要在数据库事务里等待导航或讲解完成。通信失败时命令状态为待确认，机器人重连后按 commandId 对账，不能盲目生成一条新命令重做。平台只下发**当前展台**，未来路线留在 Java；计划改版不要求机器人维护整条路线。

**一次交互设计怎么串起来（不是本次抓取的真实日志）。**15:00，工作人员在手机点“开始”，请求 `POST /api/reception-tasks/T1001/start`。Java 校验计划已审核、机器人空闲且资源就绪，锁定 G1-01，取得目标展台名额并创建 C101；事务提交、机器人归属握手确认后，发送器才投递命令。机器人适配器持久接收 C101 后回 `RECEIVED`，调用 `navigate_to`；成功到站回 `ARRIVED`，再启动讲解并回 `EXPLAINING`，全部完成条件满足后回 `EXPLAINED`。Java 将 Command 置 SUCCEEDED、S1 置 `WAITING_COMMAND`，前端显示“液冷讲解完毕，等待下一站”。游客提问不推进 S1；工作人员点击下一站，Java 才查 S2 并创建 C102。

下一站的两个入口统一成一个业务请求，例如手机按钮或语音分类结果最终都请求：

~~~http
POST /api/reception-tasks/T1001/advance
Content-Type: application/json

{"requestId":"REQ-02","expectedStepId":"S1","expectedPlanVersion":1,"expectedTaskVersion":8,"robotId":"G1-01","source":"PHONE"}
~~~

`requestId` 识别**同一请求重发**；`expectedStepId` 防止不同请求连续跳站；`expectedPlanVersion` 防止按旧路线推进；`expectedTaskVersion` 防止在同一站暂停又恢复后执行迟到的旧操作。Task 的业务控制变更递增 `taskVersion`，遥测刷新不递增。请求来源字段不能证明操作人身份，权限从登录会话或已授权控制会话取得。只有当前仍为 S1、任务允许推进且 S1 为 `WAITING_COMMAND` 时才能推进；下站资源不可用则维持当前站，返回等待原因，不提前完成 S1。

推进、改线、暂停和取消必须先锁**同一条任务行**，统一串行化业务变更；只对 Step 做 CAS，挡不住另一事务同时修改计划。以下是事务伪代码，省略 Mapper 与异常定义：

~~~text
校验已认证操作人权限与输入上限
BEGIN
  SELECT reception_task WHERE task_id = ? FOR UPDATE
  查询 UNIQUE(task_id, request_id) 的操作记录：
    已存在且请求摘要一致 → 返回原结果；同编号不同内容 → 拒绝
  核对 status=RUNNING、current_step_id、plan_version、task_version、机器人归属
  核对当前 Step=WAITING_COMMAND，当前 Command 确定结束
  读取本版本下一 Step；锁机器人占用行和目标展台资源行
  获取目标名额失败 → 不改变步骤，不创建命令；若启用 6.3 节候补策略，则登记 WAITING 候补并返回等待原因
  成功 → S1=COMPLETED；S2=IN_PROGRESS；更新 current_step_id、task_version
  写目标预约、唯一 robot_command、command_outbox、操作结果
COMMIT
发送器在提交后投递同一 commandId
~~~

同一任务的锁顺序统一为任务行→机器人行→按编号排序的展台行，所有写入口遵守。不可在持锁期间调用模型或等待机器人。数据库死锁可有限重试**整笔数据库事务**，不是重新执行物理动作。成功操作结果与状态同事务保存，客户端丢响应后重试才能得到原 `commandId`；普通 `RESOURCE_BUSY` 不自动承诺将来出发。只有显式进入 6.3 节的候补策略，才登记可取消的排队记录；轮到该任务后也要再次校验，不能凭旧请求直接开动。最后一站没有下一 Step 时提供明确的“结束接待”，逻辑结束与机器人/访客离场分别确认。

机器人回报可以用统一事件格式（仍是设计报文）：

~~~json
{"eventId":"E101-3","commandId":"C101","taskId":"T1001",
 "stepId":"S1","robotId":"G1-01","assignmentEpoch":7,"eventSeq":3,"eventType":"ARRIVED",
 "occurredAt":"2026-09-23T15:03:20+08:00"}
~~~

同一 C101 可先后回 `RECEIVED、NAVIGATING、ARRIVED、EXPLAINING、EXPLAINED`。`eventId` 用唯一约束去掉重复事件；`commandId` 关联命令，但不能在事件表上设成唯一，因为一条命令有多个阶段。状态转换还要检查先后：晚到的 `NAVIGATING` 不能把已保存的 `EXPLAINED` 覆盖回去。机器人端也应按 `commandId` 记住是否已执行过同一业务命令；网络重投原编号是询问/恢复同一动作，不是让机器人再导航一次。物理动作遇到断电后“执行了但没持久化结果”的情况，无法保证绝对只执行一次，平台应转人工核实。

**“先落库后发送”解决什么？**如果 Java 把 WebSocket 消息发出后才写库，而数据库此时失败，机器人可能已经动了，平台却不认识这次操作。先提交 C101 可以让平台知道“我准备下发过什么”；但提交成功后进程立刻崩溃，也可能没真正发送，所以 C101 会停在 `PENDING/SENT` 等待恢复。稳妥做法是事务中保存命令和待发送记录，提交后由发送器投递，机器人以 `commandId` 去重并回执；超时先查状态和对账，不因没收到回执就另造 C102。这里的状态/待发送记录是设计方案，不是 bot_mind 已有功能。

面试时可以用下面的最小状态表解释“下发不等于完成”：

| 对象 | 关键状态 | 何时转移 |
|---|---|---|
| Task | PENDING_REVIEW → SCHEDULED → PREPARING → READY → RUNNING → COMPLETED | 资源检查、人工到场确认、逐站执行与结束接待 |
| Task 异常分支 | RUNNING → PAUSING → PAUSED；CANCELLING → CANCELLED | 暂停/取消请求先冻结下发，核对当前执行结束或停止后再确认；不明时保持处理中并告警 |
| Step | PENDING → IN_PROGRESS → WAITING_COMMAND → COMPLETED | 当前站开始、讲解结束、收到合法 NEXT |
| Command | PENDING → SENT → RECEIVED → EXECUTING → SUCCEEDED/FAILED/CANCELLED；不明时 UNKNOWN | UNKNOWN 是待对账状态，不是可释放资源的终态；SENT 仅为发送尝试记录 |

不必记住每个英文状态名；必须记住三条规则：**未审核不能执行，收到命令不等于执行成功，结果不明先对账而不是盲重试。**

若选机器人主动连接 Java 的设计，连接时应携带固定 robotId 与独立设备凭据，由 Java 验证凭据与台账的绑定。心跳提供在线状态，位置可按 1～2 Hz 上报给平台 Redis，业务事件即时上报。名称可改，不能用显示名称充当身份。现有 bot_mind 有可查询状态、位置的 HTTP 接口，但主动上报/WebSocket 适配器仍是扩展设计；开发时 SSH 能登录机器人，并不能证明这些业务能力已经上线。

**心跳不是执行事件。**平台可把有效心跳的最后接收时间、电量、楼层、当前点位、导航/动作服务就绪状态写入带短 TTL 的 Redis 键；心跳超时先判疑似离线并停止分配新任务。一次到站、讲解完成或失败则必须按 `commandId` 作为事件记录进 MySQL，不依赖下一次位置心跳来猜。机器人重连时上报 `taskId、stepId、commandId` 和本机实际阶段，Java 对照命令记录决定继续等待、恢复还是人工介入。Redis 键过期不会抹掉任务历史；WebSocket 恢复也不意味着旧命令应全部重发。

机器人断线但本地已到站时，Java 不能把它误判为“仍在上站”或“已经成功”。当前命令置 UNKNOWN，暂停后续下发；机器人重连时补报 commandId、实际阶段和位置，核对后再推进。断线期间能否继续当前导航由现场安全策略决定；无论如何不能在断线时自动开始新的展台。

### 5.1 端到端协议的必要条件（增强设计，实际传输协议待核实）

HTTP、WebSocket 或其他传输都不能替代下面的业务约束。实际项目用哪一种需查客户端、服务端和调用日志；本节不把示例协议写成验收事实。

| 环节 | 设计约束 | 解决的故障窗口 |
|---|---|---|
| Java 提交 | Task/Step、资源预约、Command 与 outbox 在同一事务写入 | 防止有命令无任务，或占了资源却没有可恢复的发送记录 |
| 发送器 | 短事务领取 outbox，提交后发送；失败退避，限次数/截止时间并告警；同一 Command 不换编号 | 发送成功但发送记录未更新时，允许重复投递 |
| 机器人接收 | 先按 commandId 将 payloadHash、归属代次与状态持久化，再 ACK；同 ID 不同内容拒绝 | 进程重启后仍能去重；ACK 的含义是持久接收，尚非执行成功 |
| 本机执行 | 校验资源包、控制权与前置状态；单机器人普通业务命令串行，停止/取消不堵在导航等待队列后 | 避免导航、讲解、维护入口同时占用硬件 |
| 结果回传 | 端侧结果与待上报事件一起持久化；事件未被平台确认前可重投 | 完成后断网仍可恢复结果，避免只保存在内存里 |
| Java 消费 | 校验设备身份与命令归属；锁同一任务行，事件去重、状态迁移和必要业务更新同事务提交后再 ACK | 防止事件“已去重”却没推进状态；丢 ACK 可安全重放 |

端侧可用小型本地数据库实现 inbox/outbox，不要求为了两台机器人引入消息中间件。表名不重要，**先落盘再确认、重复不重复执行**才是关键。物理动作和数据库提交无法组成原子事务：若重启时只知动作已开始而不知是否完成，就返回 UNKNOWN，核对下层执行状态或转人工，不能声称严格 exactly-once。

最小约束包括：操作记录 `UNIQUE(taskId, requestId)`、命令主键 `commandId` 与 `UNIQUE(robotId, assignmentEpoch, commandSeq)`、事件 `UNIQUE(robotId, eventId)`。普通下发时预约可用 `UNIQUE(commandId, exhibitCode)` 去重；若采用 6.3 节“候补转短时预约”，预约在创建时尚无 Command，应另有 `reservationId` 主键和唯一 `waitClaimId`，`commandId` 在正式下发时再绑定，不能靠可空的 commandId 识别这段预约。机器人占用行保存 `ownerTaskId、activeCommandId、assignmentEpoch`，受锁保护，不能只存一个 BUSY 字符串。业务明确重试可创建新的执行尝试，但必须先确认旧命令终结；传输重投始终使用原 commandId。发送队列按状态/下次重试时间、预约按展台/状态、事件按命令/序号建查询索引，保存期限覆盖重连补报与审计窗口。

事件包含 `eventSeq` 辅助发现重复/缺口，排序不依赖不同机器的墙上时钟。终态先到、进度后到时，可用经过校验的完整终态收敛，再补齐审计；不得因缺少一条中间事件永远卡死。旧事件保留历史，不允许把终态回退。终态属于哪个 Command，要与该命令创建时的计划版本对应；只修改未来路线后，仍应接纳当前旧版本命令的合法完成事件。

### 5.2 为什么只有 planVersion 还不够

`planVersion` 管任务路线，`taskVersion` 管操作前提；两者都不代表机器人已经知道平台撤销了旧命令。`assignmentEpoch` 是一台机器人控制权的代次，`commandSeq` 是该代次内的命令序号。

新任务接管机器人前，Java 先确认上一命令结束或停止，再通过握手把新归属代次与任务写入端侧，收到端侧持久化确认后才发送业务命令。端侧拒绝旧代次和旧序号；同序号只允许同一个 commandId 返回已有结果。机器人本地账本丢失时禁止自动接管，进入重新核对流程。代次不是模型产生的字段，也不能仅在 Java 自增就假定端侧生效。

对尚未确定收到的 C101 发取消，端侧即使尚未见过 C101，也要持久化它的撤销记录，防止延迟到达后执行；如果 C101 已开始，则等待底层取消结果和静止/可继续状态。取消接收 ACK 不等于已停。**网络分区时平台不能保证瞬时远程撤销**，因此当前执行不明时不派第二条命令、不把机器人重新分给另一组。租约或心跳过期不能替代这一步。

计划改线与 NEXT 竞争时共用任务行锁：NEXT 先提交则该目标已成为当前执行，修改它必须走取消流程；改线先提交则旧版本 NEXT 被拒绝，工作人员刷新后重新确认。草案保存 `basePlanVersion、baseTaskVersion、currentStepId`，审核时复核，防止模型生成期间接待已经推进。

### 5.3 暂停、继续与结束不能只改数据库状态

普通暂停先冻结后续下发，再请求停止当前导航/播放/关联动作；收到可验证结果后才展示“已暂停”。恢复不等于重播整条 VISIT_EXHIBIT：若本机保存了有效讲解断点、动作状态和资源版本，可在确认后续播；否则让工作人员选择重讲、跳过或结束。已执行动作不能跟随文本断点盲目重放。

最后一站讲完仍允许问答。工作人员点击“结束接待”后，核对命令结束、停止播放、确认访客离场，再分别释放机器人与展台。若还需返程，返程也是受跟踪的操作，不能在返程中标为空闲并承接另一任务。取消、离线和 Task 逻辑完成都不自动证明现场已经空出来。

## 六、运行中变化：事件驱动重规划与共享资源

现在加入真正需要中央决策的场景。G1-01 和 G1-02 分别带两组访客：

~~~text
G1-01：液冷（正在讲） → 具身智能 → AI 应用
G1-02：AI 应用（正在讲） → 具身智能 → 液冷
~~~

**事件 A：访客临时要求换顺序。**工作人员从手机提出“G1-01 先去 AI 应用，具身智能留到最后”。明确拖动列表可由 Java 直接校验；自然语言要求由规划 Agent 根据**剩余步骤、当前任务版本、另一台机器人的预计占用**提出草案。模型不能替换已完成的液冷讲解，也不能创造新展台。

**事件 B：前方人群挡住通道。**先让 G1-01 的本地导航栈处理避障、短暂等待或可行的局部绕行。只有导航端在规定时间内仍无法到达，才上报 NAVIGATION_BLOCKED。这个事件只证明“导航受阻”；若没有人流感知或工作人员确认，平台不能断言原因就是“游客人墙”。Java 暂停当前受影响命令，记录事件，并可请求 Agent 提议“等待、先参观另一空闲展台或结束这一段”。若通道阻断所有候选目标，换展台顺序也无用，只能等待或人工接管。模型不能生成关节动作或指挥机器人穿越人群。

两类事件进入同一条**重规划门控**，但触发后不一定都要调用模型：

~~~text
访客改线或导航持续受阻
    ↓
Java 固化事件和当前事实：已完成站、当前命令、剩余时长、
机器人位置/在线状态、两组任务及展台占用
    ↓
明确拖动顺序 → 直接业务校验
模糊自然语言或需权衡的受阻 → Agent 提出候选剩余路线
    ↓
Java 校验展台存在、楼层/能力和共享资源容量，并说明时间目标风险
    ↓
工作人员审核；通过后 planVersion 加一，仅替换未执行步骤
    ↓
当前命令若不受影响：下次 NEXT 才使用新路线
当前命令若受影响：先取消/确认停止或到达，再下发新目标
~~~

**共享资源不只是一台机器人。**一台机器人一次只能带一组客人；同一时间，一个容量有限的展台也不能接待超过配置数量的组。预计到达时间可用于规划时预判冲突，现场是否放行仍需下发前复核。系统记录的是已安排的接待组占用，若没有人流传感器，就不能把它说成真实人数。

例子：G1-02 正在 AI 应用展台，容量只允许一组。G1-01 的新路线不能立刻也派往 AI 应用；Agent 可以建议先等待或先去其他可达展台。Java 给出冲突原因，工作人员决定。对同一展台若允许两组同时参观，就把容量配置为 2，而不是代码写死互斥。两台机器人在不同展台并行讲解并不冲突。

把事件 A 走完整：G1-01 的 S1 液冷讲完，正等待下一站；原 V1 剩余路线是“具身智能 → AI 应用”。工作人员提出“先讲 AI 应用”。Java 发现 G1-02 还在 AI 应用，于是不能把 Agent 的“AI 应用 → 具身智能”直接执行。平台可以给出“等 G1-02 离开后再去 AI 应用”或“维持原顺序”的候选方案，并展示新增等待时间。工作人员确认其中一个方案时，Java 重新读取 G1-02 状态和资源占用，若仍可行才保存 V2。已完成的液冷 S1 与 C101、执行事件都不修改；只替换尚未执行的步骤。G1-01 不需接收 V2 整条路线，下一次合法 NEXT 才由 Java 从 V2 取目标并下发。

若工作人员在页面**直接拖动**顺序，路线已经明确，不必再调用 Agent；若他说“剩下十分钟，先看人少的地方”，才让规划 Agent 结合时间和已记录的接待组占用提出草案，没有传感器时不能宣称知道实时人数。提交变更例如 `POST /api/reception-tasks/T1001/route-revisions`，请求体为 `{"expectedPlanVersion":1,"expectedTaskVersion":8,"currentStepId":"S1","instruction":"先去AI应用"}`。Java 返回待审核草案和冲突说明；审核时版本与前提仍匹配才保存 V2，实际出发再次取得目标名额。占用变化可以导致等待，不等于一份允许等待的路线就必须被拒绝。

事件 B 的差别在于：若 G1-01 **正在导航**去具身智能，不能仅把数据库里的下一站改成 AI 应用就认为机器人改道成功。先把本地导航取消请求发给机器人，并等待取消确认或实际到达结果；状态仍不明时暂停新目标下发。导航系统只回报受阻并不代表通道一定被人挡住，工作人员可以通过现场观察确认原因。若两站都必须经过同一堵塞通道，Agent 调换顺序并不能解决问题，人工暂停才是正确结果。

**共享资源约束怎么落地？**每个展台配置允许同时接待的组数，例如 AI 应用 `capacity=1`。目标名额只在准备本次出发时取得；6.3 节的候补在前一组实际清场后，可短暂预约给下一顺位以便当前回答收尾，绝不提前锁住整条路线。讲完、点击下一站或取消任务都不能直接释放当前展台，必须确认接待组和机器人已离开讲解区域。预约区分 `RESERVED`（已保留、可能在途）、`OCCUPIED`（已到站）、`UNKNOWN`（是否仍使用不明）、`RELEASED`；前三种都占容量。已下发命令或物理状态不明时，TTL 到期只触发核对，不能让失联机器人或仍在场的访客被当成消失。

建议在 `exhibit` 保存 `capacity、occupied_slots`，与预约明细同事务维护：

~~~sql
UPDATE exhibit
SET occupied_slots = occupied_slots + 1
WHERE exhibit_code = :code AND occupied_slots < capacity;
-- 影响 1 行才在同一事务插入唯一 reservation 和 Command/outbox；否则不派发。
-- 释放时先锁展台行，再将指定 reservation 从占用态条件更新为 RELEASED；
-- 只有成功改变一次状态才减 occupied_slots，两个操作同事务提交。
~~~

计数是同步维护的约束字段，预约明细保留责任对象；定期校验二者一致，异常先冻结该展台新分配再核对，不能在线盲改。数据库约束要求 `0 <= occupied_slots <= capacity`，降低容量也须检查已有占用。所有写路径和人工释放都走同一服务。另一种实现可锁展台父行后做明细**当前读**；但不能把 `FOR UPDATE` 父行与任意普通 `count(*)` 混用，后者可能仍读到 REPEATABLE READ 的旧快照。锁定读和普通一致性读的语义不同。[MySQL 锁定读说明](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)

### 6.1 两组互等展台，数据库没死锁，接待仍会卡住

T1 在 A 等 B，T2 在 B 等 A，两处容量均为 1；即使 SQL 都正确，也会出现业务循环等待。数据库事务早已提交，数据库死锁检测解决不了现场互等。

两台机器人的起步方案采用同优先级按等待时间排队、对循环等待和超时提示人工处理。工作人员可让一组到**预先配置、容量可用且路径可达的等待区**，确认该组离开原展台后释放名额，另一组再通行；也可审核后改线或结束一段接待。等待区的移动同样使用受跟踪命令，并与普通导航互斥。没有可用等待区或可行通路时保持暂停，不通过提前释放 A/B 的数据库记录伪造解锁。优先级只决定候选次序，不强行抢走正在使用的展台。

机器人本地避障能避免部分碰撞，但不保证两机在窄通道中不会互堵。一期可用人工放行/经过验证的单向动线；若现场确有共享瓶颈，再把通道段建成独立的可预约资源，定义入口、出口和异常清场规则。没有联合轨迹规划与验证时，只称“任务及展台容量调度”，不宣称已经实现全局无冲突运动规划。

### 6.2 跨楼层接力与资源版本

增加 `HANDOFF` 步骤表达楼层交接：一楼到指定交接点→工作人员确认本段结束及访客移交→二楼机器人就绪并取得控制权/目标名额→工作人员确认访客到达后继续。二楼不可用就等待或结束，不因时间到了自动开始二楼讲解。任一时刻平台记录当前由哪台机器人负责，楼层切换不能只修改 `robotId` 字段。

Step 快照须包含 `hallId、mapVersion、waypointName、resourceBundleVersion、scriptHash` 及所引用动作包版本。相同点位名称在不同楼层可能指向不同位置；只冻结讲稿 V1 不能冻结地图和动作。活动任务期间禁止覆盖其所用资源包/切换激活展厅；新包用独立版本导入、校验并在安全边界激活。该能力需要机器人侧配合，现有 ZIP 上传接口本身不等于版本隔离已经实现。

**人工审核不是让人逐条审批机器人动作。**初次路线及中途变更的**业务路线**需要人确认；已审核路线里从 S1 到 S2 的正常推进，可以由工作人员点“下一站”触发，Java 校验状态后执行，不必再让 Agent 规划或让管理员审核一遍。停止、避障仍由本机安全链路优先处理。

审核通过时保存 route_revision：触发事件、旧/新计划版本、建议理由、审核人和未执行步骤快照。提交使用 expectedPlanVersion 条件更新；若审核期间另一位工作人员已改线，就提示刷新，不能覆盖。**安全优先级是：本地停止/避障 > 当前命令状态核对 > Java 资源约束 > Agent 的路线建议。**

路线采用三道检查：生成草案时校验，**审核时再次校验**，实际出发前取得目标资源名额。审核只确认业务方案，不提前长时间占用整条路线的所有展台，也不承诺未来容量始终不变；出发时资源变化允许等待或再次申请改线。下面的 SQL 在已锁任务行的事务中执行，并检查草案对应的任务状态；实际容量抢占属于第五节的下发事务。

~~~sql
UPDATE reception_task
SET plan_version = plan_version + 1,
    task_version = task_version + 1
WHERE task_id = :taskId
  AND plan_version = :expectedPlanVersion
  AND task_version = :expectedTaskVersion
  AND status IN ('RUNNING', 'PAUSED');
-- 新版未来步骤和 route_revision 同事务保存，旧版标记 SUPERSEDED 并保留；
-- 更新行数不是 1 则说明页面版本过期，整笔事务回滚。
~~~

### 6.3 两场接待错峰开始，却在同一展台追尾：候补、短时预约与等待体验（扩展设计）

假设 14:00 和 14:20 各开始一场接待，分别由 G1-01、G1-02 带队。G1-01 在 B 展台开放问答很久；G1-02 已到 A，下一站也是容量为 1 的 B。二十分钟错峰只能用于排程预警，不能保证开放问答的结束时间。G1-02 对 B 的预约失败时，**不能先导航过去排队**，也不能把 G1-01 的讲解强制标为完成。

这里不借用真正的“读锁/写锁”：标准读写锁中，B 的写占用与另一台的读锁互斥，而且不能让数据库事务锁跨越整场讲解。设计为两种持久业务记录：`OCCUPIED/RESERVED/UNKNOWN` 的**展台占用预约**计入容量；`WAITING` 的**候补请求**只表示排队顺位，不占容量、不授权导航。容量为 1 时可以是 `B=OCCUPIED(G1-01)` 且 `候补首位=G1-02`；其他任务可以排在后面，但不能越过首位直接取得 B。若 B 容量大于 1，则按空余名额逐个兑现候补，不把展台写死为互斥资源。

| 时刻 | B 的容量记录 | G1-02 在 A 的行为 | Java 平台动作 |
|---|---|---|---|
| B 仍在讲解 | G1-01 `OCCUPIED` | 当前讲解结束后可开放 A 的问答或播放已审核补充讲稿 | G1-02 登记 `WAITING`；保持当前 A 步骤，不创建去 B 的命令 |
| G1-01 与访客确认离开 B | 释放 G1-01；将首位候补原子转为 G1-02 `RESERVED` | 完成当前回答、不再接新问题，播报准备去 B | 发出带预约版本的“准备收尾”业务通知；短时预约计入 B 容量 |
| G1-02 准备出发 | G1-02 `RESERVED` 且仍在有效窗口 | 确认当前播报已结束、路线和控制权仍有效 | 绑定 Command/outbox；提交后才下发去 B，实际清场后释放 A |
| G1-02 到达 B | G1-02 `OCCUPIED` | 开始 B 的讲解 | 消费到站事件并更新预约阶段 |

G1-02 在 A 的等待内容必须属于 A：开放问答走当前展台的 RAG，补充讲稿只能选已发布资源；**不能让模型临时编一段控制动作或未审核讲稿**。若 A 需要让位、访客不愿继续听，或 B 长时间未释放，则去预设安全等待点、提出换序草案或交工作人员。机器人到 A 讲完正文不等于 A 的占用结束；第二组仍在问答时仍占 A。机器人 1 在 B 提前收尾可以作为工作人员授权的选择，但先要确认它下一站或等待点可用；本场景的默认做法不依赖打断第一组。

**关键操作分为三个短事务，中间没有长时间数据库锁。**下面的服务层代码用于阅读调用顺序；字段、SQL、接口合同、清场权限、竞态处理和验收条件以 [V2 实施设计](/central-scheduling-v2-design) 为准。Repository、事件认证和端侧适配器名称不是已验收 Java 工程中的现成类：

~~~java
// 第一次：G1-02 在 A 请求去 B。事务只保护当前状态与排队顺位，不等待模型或机器人。
@Transactional
public AdvanceResult requestNext(AdvanceRequest req) {
    ReceptionTask task = tasks.lockById(req.taskId()); // 同一任务的 NEXT/改线/取消共用入口
    requireExpectedVersion(task, req);
    requireCurrentStepReady(task, req.fromStepId());
    if (operations.exists(req.taskId(), req.requestId())) {
        return operations.replayOrRejectDifferentPayload(req); // 网络重试不插入第二条候补
    }

    String target = steps.nextExhibit(task); // 只从已审核的剩余路线取 B
    robots.lockAssignment(task.robotId());
    exhibits.lockByCode(target);             // 本次尝试和其他占用写入串行化
    if (exhibits.tryTakeSlot(target) == 1) {
        // 普通路径：预约、Command、outbox、操作结果同事务；提交后才发送。
        return dispatchCurrentStep(task, target, req.requestId());
    }

    WaitClaim claim = claims.insertOrReuseWaiting(task, target, req.requestId());
    operations.saveWaiting(req, claim.id());
    // 不推进 A 的 Step，也不创建“去 B”的命令；前端显示 B 正被占用。
    return AdvanceResult.waiting(claim.id(), target);
}

// 第二次：消费经验证的 B 清场事件。先释放原占用，再把候补首位转为短时预约。
@Transactional
public void onBoothCleared(ClearedEvent event) {
    ReceptionTask owner = tasks.lockById(event.taskId());
    Exhibit booth = exhibits.lockByCode(event.exhibitCode());
    Reservation old = reservations.lockById(event.reservationId());
    requireAuthenticCurrentEvent(owner, old, event); // 重复、旧命令、仅“讲完”均不能清场
    if (old.isReleased()) return;                    // 清场事件重投只释放一次

    old.markReleased();
    booth.releaseOneSlot();
    WaitClaim first = claims.lockFirstWaiting(booth.code()); // 同优先级 FIFO
    if (first == null || !booth.isOpen()) return;

    booth.takeOneSlot(); // 同事务扣回刚释放的容量；第三台不能插队
    Reservation hold = reservations.createForClaim(first.id(), booth.code(),
            handoffDeadline()); // 尚未下发 Command，短时窗口用于 A 的当前回答收尾
    first.markPromoted(hold.id());
    notifications.saveOutbox(first.taskId(), "BOOTH_RESERVED", hold.id());
}

// G1-02 收到“当前回答已结束”后再进入此短事务，不能拿着旧排队结果直接出发。
@Transactional
public DispatchResult finishAnswerAndDispatch(long claimId, String answerDoneEventId) {
    WaitClaim snapshot = claims.find(claimId);
    ReceptionTask task = tasks.lockById(snapshot.taskId());
    robots.lockAssignment(task.robotId());
    Exhibit booth = exhibits.lockByCode(snapshot.exhibitCode());
    WaitClaim claim = claims.lockById(claimId);
    Reservation hold = reservations.lockById(claim.reservationId());
    requirePromotedAndUnexpired(claim, hold);
    requireAnswerDoneForHold(task, hold, answerDoneEventId); // 关联本次收尾，拒绝旧播报事件
    requireRouteAndRobotStillValid(task, claim, booth); // 取消、改线、离线时拒绝

    Command command = commands.createVisit(task, claim.targetStepId(), booth.code());
    hold.bindCommand(command.id());         // 此后超时不能自动释放 B，须核对物理状态
    claim.markClaimed();                     // PROMOTED → CLAIMED，不再占活跃候补位
    task.advanceTo(claim.targetStepId());   // 仅此时推进 Step/任务版本
    outbox.save(command);                   // 提交后发送器投递同一 commandId
    return DispatchResult.queued(command.id());
}
~~~

`exhibit_wait_claim` 至少保存 `claimId、exhibitCode、taskId、targetStepId、queueNo、status、reservationId、创建时间`，按 `(exhibitCode,status,queueNo)` 查首位；同一任务的活跃 `claimId` 由任务行或唯一约束限制，重复 NEXT 不能插出多个顺位。取消/改线也要在任务事务中撤销候补或释放**尚未下发**的短时预约；所有释放容量的路径都要尝试兑现下一顺位，不能只在机器人正常离场时处理。清场事务只锁原任务、B 展台及候补行，不在持有 B 锁时反向锁候补任务，避免和 NEXT 的“任务→展台”顺序形成锁环。候补任务在真正下发前再次校验任务版本；若已取消，释放短时预约并通知下一顺位。B 关闭时不兑现候补，而是通知等待中的工作人员改线或暂停。

短时预约的期限是**可配置的收尾窗口**，不是对导航耗时的预测。只在 `RESERVED` 且尚无 Command/outbox、确认机器人未出发时，超时处理器才能撤销预约并兑现下一顺位；已有命令或执行状态不明则标 `UNKNOWN` 并对账，绝不能靠 TTL 把 B 重新分配。G1-02 从 A 出发后，只有确认接待组和机器人离开 A，才释放 A；短暂同时占用 A 与 B 的容量是为了避免两个展台都误判为空闲。

最后，播报用语也要与实际位置一致：G1-02 准备离开 A 时可以说“当前问题回答完，我们前往 B”；**不能说留在 A 继续向 G1-02 提问**，因为它正在离开。若确实允许游客留在 A 自行参观，需要另行定义工作人员接管和 A 的容量释放条件。以上队列、收尾通知及代码均为扩展设计，面试中不能说成现有机器人侧已实现的回执或上线验收指标。

## 七、语音问答与多机器人并发

**V2 对“下一地点”的语音路由与状态来源。**机器人侧 Adapter 上传 ASR 文字、机器人身份与执行事件；Java 接收心跳、导航和真实播报完成事件，在 robot_runtime_state 中维护带版本和时间戳的快照。明确的完整短句“下一地点”由严格规则直接识别，无须调用意图 ChatClient；复杂表达由意图 ChatClient 分类，知识问答才进入 RAG。两个入口的 NEXT 都由 Java 查运行状态和业务事实：快照过期就经机器人主动拉取通道请求 STATE_PROBE；即便状态新鲜，还须验证说话者权限、当前 Step、播报结束和目标展台名额，先预约再导航。若下一展台被占用，登记去重候补并留在当前安全位置，可继续当前展台问答；明确要求跳过则生成待人工审核的改线草案，不自动去下下站。下文代码展示规则优先的简化边界，完整流程与回执协议见 V2。

手机上的“下一站”由已登录且有当前任务操作权限的工作人员调用 Java 任务接口，不需要模型。机器人语音由 bot_mind 采集并经云端 ASR 转成文字：本机对极少量**整句相等**的“停止”短语优先停机并上报；其他文字连同 `robotId、taskId、stepId、planVersion、taskVersion、utteranceId` 送到 Java。Java 先对 ASR 文字做小范围完整语句规则匹配；明确的“下一地点”“去下一站”直达业务控制门禁，带目标站名、否定、疑问或附加条件的不匹配。规则未命中才调用意图 ChatClient，将复杂语义分类为 `NEXT、PAUSE、ROUTE_CHANGE、KNOWLEDGE_QA、CHAT、UNKNOWN`。模型只返回意图，不直接下发硬件命令。设备认证只证明哪台机器人发来请求，不能证明说话者是获授权工作人员；普通访客的 NEXT 在建议方案中先提示工作人员确认，只有明确授权的控制会话才允许直接推进。

**模型时间线与切换边界。**按 2026 年 2—6 月的项目时间，开发阶段可在个人电脑通过 Ollama 运行 `qwen3:4b-instruct-2507-q4_K_M` 做中文意图分类原型；它只验证语音路由，不能代替路线规划和 RAG 答案生成。移动网关所列 `DeepSeek-V32` 如果确指 V3.2，也属于 2 月前已发布的模型，可作为早期规划与问答的候选；DeepSeek 官方 API 到 **2026 年 4 月 24 日**才提供 V4-Flash，因此项目叙述中只能将 `DeepSeek-V4-Flash` 放在后期接入阶段，不能写成 2 月启动时使用。**公开发布时间只能证明时间上可能，不能证明移动网关当时已开放、项目实际调用过或具体延迟。**真实运行记录应以网关的 `modelId`、调用日志和配置变更为准。[Qwen3-4B 模型卡](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507)、[DeepSeek-V3.2 更新记录](https://api-docs.deepseek.com/updates/)、[DeepSeek-V4-Flash 更新记录](https://api-docs.deepseek.com/updates/)。

路线规划、复杂语音分类和问答可以是**共享同一远端 ChatModel 的三个 ChatClient**：分别使用工具增强规划、受限意图分类、依据检索证据回答的提示词。前置规则路由是 Java 代码，不是第四个 ChatClient；明确指令不消耗分类模型调用。换模型或调整规则时保持意图枚举和业务接口不变，并重跑否定句、疑问句、口音 ASR 文本及多轮问题测试。移动网关是否兼容 Spring AI 所用协议、实际 `modelId` 和鉴权方式须以提供的 API 文档核实，不能把公开 DeepSeek 地址直接写成移动网关地址。

例如机器人在 S1 液冷展台听到“下一站能不能改成具身智能？”，bot_mind 上传：

~~~json
{"robotId":"G1-01","taskId":"T1001","stepId":"S1","planVersion":1,"taskVersion":8,"utteranceId":"U102","text":"下一站能不能改成具身智能？"}
~~~

规则路由不应命中这句话，意图模型应返回 `ROUTE_CHANGE`，而非因为含“下一站”就返回 `NEXT`。Java 校验 S1 仍是当前步骤，再让规划 Agent 基于**未执行步骤**提出改线草案；工作人员审核后才更新 `planVersion`，不会直接导航。若识别为 `KNOWLEDGE_QA`，才进入当前展台的 RAG 检索并调用问答 ChatClient 生成回答；因此一条开放式专业问题可能有“规则未命中、分类、检索、生成回答”四个阶段。分类超时或结果为 `UNKNOWN` 时询问澄清，不猜测执行控制命令。这个请求与返回是接口设计样例，不是已有 bot_mind 源码中的接口。

Spring Boot 中可把“分类”和“能否执行”分开，避免给模型一个可直接导航的工具。下面只展示核心边界，省略请求校验、异常映射和持久化代码：

~~~java
@RestController
@RequiredArgsConstructor
class VoiceController {
    private final VoiceService voiceService;

    @PostMapping("/api/robots/{robotId}/utterances")
    VoiceReply receive(@PathVariable String robotId, @RequestBody VoiceInput input) {
        return voiceService.route(robotId, input);
    }
}

@Service
@RequiredArgsConstructor
class VoiceService {
    private final ChatClient intentChatClient;
    private final VoiceRuleRouter voiceRuleRouter;
    private final TaskService taskService;
    private final RouteService routeService;
    private final QaService qaService;
    private final ChatService chatService;
    private final VoiceControlPolicy controlPolicy;

    VoiceReply route(String robotId, VoiceInput input) {
        verifyAuthenticatedDeviceAndBoundContext(robotId, input);
        // 仅匹配完整、无否定或附加条件的短句；未命中才调用模型。
        IntentResult intent = voiceRuleRouter.matchExact(input.text())
            .orElseGet(() -> intentChatClient.prompt()
                .system("仅从 NEXT、PAUSE、ROUTE_CHANGE、KNOWLEDGE_QA、CHAT、UNKNOWN 中选一类；否定、疑问或歧义不得输出 NEXT")
                .user(input.text())
                .call().entity(IntentResult.class));

        return switch (intent.type()) {
            case NEXT -> controlPolicy.advanceOrAskStaffConfirmation(robotId, input);
            case ROUTE_CHANGE -> routeService.createReviewDraft(input, intent);
            case KNOWLEDGE_QA -> qaService.answerForCurrentStep(input);
            case PAUSE -> taskService.requestPause(input.taskId(), input.stepId());
            case CHAT -> chatService.replyWithoutTaskChange(input);
            case UNKNOWN -> VoiceReply.askForClarification();
        };
    }
}
~~~

`VoiceRuleRouter` 要用完整语句白名单并审计匹配原因，不能以包含“下一站”的子串放行。`entity()`提供类型映射，但输出仍可能解析失败或分类错误；应限制输出长度，检查非空、合法枚举，捕获超时/解析失败并澄清。`advanceOrAskStaffConfirmation` 对规则和模型来源执行同一权限/状态检查：目标展台满则 WAITING，回复可继续本地问答或申请跳过；跳过是改线申请，必须按路线约束重新审核。若移动网关不支持所需结构化输出形式，就在接入适配层解析并校验，不能信任模型自由文本或模型自报置信度。

专业问题不改变任务步骤。例如 G1-01 在液冷展台问“它怎么散热”：Java 根据 taskId + stepId 取得 exhibitCode=LIQUID_COOLING，先按展台过滤知识片段，再用 m3e-base 的本地 768 维向量做相似检索；证据足够时把片段与问题送给移动提供的大模型 API，生成短回答和引用，由 bot_mind TTS 播放。没有证据就说明不知道。日常寒暄无需强制 RAG；统一问答服务与规划服务是不同的 ChatClient/提示词，不让问答模型发 NEXT 命令。

知识入库流程保持轻量：二三十份展厅 PDF 先读、清洗与去重，按语义切块，由管理员确定所属 exhibitCode；m3e-base 导出 ONNX 后作为 Spring AI 的 EmbeddingModel Bean，写入 PostgreSQL + pgvector。问答检索时先过滤展台，TopK 从 5 起，用真实问题集调整召回、无答案拒答与延迟。这里的“本地”指展厅服务器上的 Embedding 和业务数据库，不包括经移动 API 完成的语音分类、规划和答案生成；不能宣称所有问题和资料完全不离开展厅。

Spring AI 接入示意：业务代码依赖 EmbeddingModel 接口；这里的 ONNX 模型文件和 tokenizer 要由项目自己准备，**不是 Spring AI 自动下载的 M3E**。入库与查询必须使用同一模型版本和池化/归一化方式。

~~~java
@Bean
EmbeddingModel exhibitEmbeddingModel() {
    TransformersEmbeddingModel model = new TransformersEmbeddingModel();
    model.setModelResource("file:/opt/models/m3e-base/model.onnx");
    model.setTokenizerResource("file:/opt/models/m3e-base/tokenizer.json");
    model.setModelOutputName("last_hidden_state"); // 须与实际导出节点一致，见第九节
    model.setTokenizerOptions(Map.of("padding", "true"));
    return model; // 交给 Spring 容器初始化
}

// 问答时先由当前 taskId + stepId 查出 exhibitCode，
// 再以 exhibitCode 过滤知识片段，而不是让用户问题自行决定过滤条件。
SearchRequest request = SearchRequest.builder()
    .query(rewrittenQuestion)
    .topK(5)
    .filterExpression(filterBuiltFromTrustedExhibitCode)
    .build();
List<Document> evidence = vectorStore.similaritySearch(request);
~~~

例如 G1-01 在液冷站问“它怎么散热”，G1-02 同时在 AI 应用站问“这个模型怎么训练”：请求分别进入 `/api/robots/{robotId}/utterances`，路由到同一个 QaService，携带各自的任务、步骤和语音上下文。Java 从可信步骤取得 `exhibitCode`，并行检索和调用模型；上下文按任务、步骤、机器人隔离。**不是一个 Agent 实例永久绑定一台机器人，也不是十台机器人就得十个 Java 服务或十条常驻线程。**真正需要压测的是模型 API 的并发限制、响应时延和语音播放的等待体验。

同一机器人则要处理顺序：U1“怎么散热”耗时五秒，晚一秒发出的 U2“尺寸是多少”耗时两秒，U2 可能先返回。`utteranceId` 只是标识，不会自动排队；可以让同一机器人按接收顺序问答、播报，或在访客明确打断时宣布 U1 失效、只播 U2。若 U2 是“它有什么优势”这样的追问，需按顺序维护上下文。答案返回和实际 TTS 播放前都检查当前 `stepId` 及该机器人有效的 `utteranceId`；过期答案不能在下一展台播放。不同机器人并行、同一机器人有序，两者并不冲突。

意图分类也要有失败兜底。明确的手机按钮不走模型；语音里的“停下”之类安全短语先在机器人本地处理，但云端 ASR 不能替代物理急停。Java 对少量完整且明确的 ASR 短句先规则路由；未命中的复杂语音才由移动 API 返回受限枚举，遇到“下一站是哪里？”不能因含有“下一站”就执行 NEXT；分类不确定时询问确认，不能默认移动。`NEXT` 即使命中，Java 仍检查任务是否运行、机器人是否正在等待指令、请求的 `stepId` 是否还是当前步骤。这属于业务状态判断，不是再让模型判一次。远端 API 超时不影响手机按钮、明确规则语音与本地停止，但开放式语音操作应暂时不可用。

旧版意图路由的反例仍值得练习：“去下一个展台”可以是 NEXT；“为什么下一站是液冷”是问题；“先不要去下一个展台”是否定；“先去具身智能，再去液冷”是路线变更。不要靠 `contains("下一站")` 判断。早期本机小模型和后期移动 API 使用同一组标注的现场 ASR 语句回归，重点看 **NEXT 误触发率**、歧义句澄清率和从语音结束到路由结果的 P95 时延；模型给出的置信度不等于真实概率。线上模型变更后必须重新测，而不能用开发电脑上的耗时替代移动网关实测。

**多轮追问怎样不串展台？**“它有什么优势？”需要结合最近一轮“液冷机柜如何散热”改写为“液冷机柜散热方案有什么优势”后再检索。短期会话可以按 `taskId:stepId:robotId` 编号，仅保留最近几轮；完整问答写 `qa_message` 供复盘。进入新 Step 就换会话，任务状态仍由 Task/Step 表管理，不能存在 ChatMemory 里。语音开始采集时就应绑定当时的 `stepId`；若等 ASR 数秒后才读取当前 Step，访客刚好换站，会把旧站问题误判成新站问题。取消、打断也可能没有改变 Step，所以播放前还需核对 `utteranceId` 的有效性。

**RAG 的元信息与效果验证。**`exhibitCode` 由管理员上传资料时指定，不能让模型凭文档标题猜；切块保留 `docId、标题、页码或段落、exhibitCode`，这样回答可以回溯原文。AI 可辅助清洗、去重和补关键词，但不负责决定展台归属。先在当前展台范围内取 TopK=5 候选，去重并剔除明显无关片段；证据不足就明确说不知道，返回的引用也必须属于本次检索结果。用“原话、同义问法、跨展台问题、资料里没有答案的问题”组成小评测集，看正确证据能否召回、回答是否忠于证据、拒答是否恰当，再调 TopK 和阈值；不能仅凭向量相似度高就宣称问答准确。

**部署边界。**MySQL、Redis、PostgreSQL/pgvector 和 m3e-base 可以部署在展厅服务器，十台机器人共用平台及知识库；早期开发电脑上的 Ollama 模型不需要作为线上服务复制到每台机器人。m3e-base 只把文本变成向量，不负责生成回答；分类、规划和回答经移动提供的模型 API 时，需求文字、问题及检索片段可能经该网关传输，是否仍在受控网络内须按实际部署核实，不能把“Embedding 本地化”讲成“全链路完全离线”。多机器人同时提问时，先测该 API 的并发限额和延迟，再决定是否给调用层设置有界队列；盲目增加 Java 线程不会让模型更快。

### 7.1 RAG 要能回答“没有证据时怎么办”

当前展台过滤适合“它怎么散热”之类指代问题；明确询问别的展台时，先把目标映射到经过校验的展台编码，必要时让访客确认，再检索允许访问的目标资料。跨展台对比可检索两个已确认范围，但不改当前 Task/Step，也不放开到全库。过滤至少包含展厅、展台、已发布资料版本和资料访问范围，不能只靠名称相似。

小知识库先比较关键词检索与向量检索，产品型号、缩写可加词表或关键词候选；无需直接堆重排模型。pgvector 可先用精确检索，只有实测确有瓶颈再考虑 HNSW；近似索引与过滤结合时需检查返回数量和召回损失。[pgvector 官方说明](https://github.com/pgvector/pgvector)

切块长度按实际 tokenizer 的 token 上限设置，不能把“几百字”直接当成“几百 token”；保留标题、表头、页码与版本。图片/扫描 PDF 提取失败应进入待处理，不把空文本标为成功入库。更新资料先生成新版本全部 chunks 并校验，再发布检索版本；删除/停用资料立即从可检索范围排除，旧向量后续清理。MySQL 登记与 pgvector 入库分开时，使用可重试入库任务和幂等 chunkId，发布前核验版本完整性，避免查到半份新文档。

问答模型只拿检索证据与受限上下文，引用必须属于本次证据集合；“有引用”仍不证明内容被证据支持，需评测关键结论能否逐条找到依据。无答案、资料冲突、检索故障分别返回对应提示。检索文本按资料对待，不能执行其中的指令。**生成答案只允许普通文本进入 TTS，不进入讲稿动作解析通道**；在入口移除/拒绝动作占位符、SSML 控制标记等，并由播放层限制能力。不能因为问答 Agent 没有工具，就忽略 TTS 解析动作标记这条间接控制路径。

### 7.2 播放并发与容量估算

每台机器人有一个统一的语音播放仲裁器：固定讲解、问答、导航提示、欢迎语都受它控制。讲解中插问先确认讲解暂停，再播放回答，结束后由工作人员继续；不能让两个业务线程同时调用共享 VoiceService。换站、暂停、取消或打断时递增 `speechEpoch` 并清除旧播放队列，服务端与端侧播放前共同校验，补上“服务端检查通过后、真正播出前又切站”的竞争窗口。语音上下文在采集开始时绑定。

实际两台设备先验证双机同时问答与双入口推进；向 N 台扩展先测瓶颈，不默认需要 N 个服务。估算模型并发可用 `平均在途请求 ≈ 每秒问题数 × 平均端到端服务时间`；例如假设十台设备合计每秒一个问题、平均占用调用链四秒，约四个问题在途，**这只是容量示例**。分类与生成各有调用成本，若还有问题改写应另算；按真实网关限额设置总并发、单机器人配额、有界队列与超时预算，避免一台设备占满所有额度。排队过久就提示稍后重试，不积压过期答案。

### 7.3 断哪一段链路，降级结果不同

| 故障 | 允许继续 | 必须暂停或降级 |
|---|---|---|
| 外部模型 API 不可用 | 已审核路线的人工按钮控制、本地导航/停止 | 新的自然语言规划和生成问答；可展示已配置内容或让工作人员接管 |
| 云 ASR/TTS 不可用 | 手机操作、经验证的本地控制 | 开放语音输入/合成；本地有 Markdown 不等于能离线发声，缓存音频需单独实现 |
| Java 或展厅局域网中断 | 当前动作按经验证的端侧策略处理，本地停止可用 | 新站点派发、自动接力；端侧保存结果等待恢复 |
| MySQL 不可用 | 端侧既有命令按既定策略处理 | 新任务变更和新命令下发；不从 Redis 重建一个“假空闲”任务 |
| Redis 不可用 | 查询持久任务历史 | 停止基于缓存的分配，或显式启用经过验证的实时状态查询方案 |
| 向量库/Embedding 故障 | 固定讲稿和已审核任务 | 专业问答检索；说明暂不可用，不让模型编造资料答案 |

一期单 Java 实例是合理取舍，但不是高可用承诺。恢复先重建连接、核对活跃命令与资源，再解除下发冻结；备份恢复可能丢失最近命令，因此不能一启动就重放所有 PENDING。扩为多实例时补充 WebSocket 连接归属/路由与原子领取发送任务，幂等及端侧控制权校验仍需保留。

## 八、落地验证与面试说法

建议 Java 侧按普通 Spring Boot 分层组织：Controller 接收任务/事件，Service 包含规划、审核、任务状态机、资源预约与问答，Mapper 读写 MySQL；通信适配层处理机器人连接与下发。bot_mind 平台适配器新增命令接收、navigate_to → booth_show 的顺序调用及事件回报；g1_base 继续负责本地运动。ZeroClaw 如未承担独立能力，不列入主链路。前述 Java 类名与 API 都是设计示例，已有机器人侧接口和新增适配职责必须分别说明。

联调要覆盖：

1. 模型输出不存在的展台、重复展台、超时路线时被 Java 拒绝；审核前不能下发。
2. 两个任务同时申请同一机器人或容量为 1 的展台，只有一个成功。
3. 讲解稿中的动作按预配置触发；导航成功不被误记为讲解完成。
4. 手机和语音同时说 NEXT，只推进一次；改线只变更未来步骤。
5. 导航短暂受阻由本机处理，持续受阻才触发平台事件；无可达目标时暂停人工处理。
6. 已执行但反馈丢失时保持 UNKNOWN 并对账，不盲目重发；断线重连不会让机器人跳过展台。
7. 两台机器人同时问答互不串话，过期答案不在下一展台播报。

日志至少关联 taskId、stepId、commandId、robotId、planVersion 和 incidentId。要衡量价值，可统计计划生成后人工改动率、审核耗时、站台冲突次数、任务完成率及导航受阻后的恢复时间；没有实测就不要套用巡检项目的“100 台、780ms、99.5%”等数字。

**九十秒介绍（按已确认职责收敛，具体机制须与实际代码一致）。**

> 项目面向甘肃 5G 联合创新中心的展厅接待，实际部署两台机器人，一楼十几个展台，二楼约十个。我主要负责 Java 平台中的中央规划 Agent 和 RAG 知识问答 Agent，这两部分已经包含在上线验收范围内。机器人接入展厅 Wi-Fi；开发联调时我们也接入该 Wi-Fi，通过 SSH 登录机器人排查问题。
>
> 规划部分把接待重点和目标时长转换成已有展台的路线草案，Java 再校验展台与资源，用讲稿配置及有来源的移动数据提示时间风险，由工作人员确认。执行层负责把确定的目标交给机器人导航与讲解，导航和运动算法由机器人团队负责。我不会声称中央 Agent 可以准确预测导航耗时或保证十五分钟结束。
>
> 问答部分围绕当前展台检索知识资料，组织回答并提供依据，同时处理无答案、上下文切换和模型异常。准备项目复盘时，我会分别说明实际完成的实现、验收结果，以及进一步补强并发和断线恢复的方案。具体效果用真实测试记录说明，不能用设计目标替代实测。

介绍后最有价值的展开是：选一条本人处理过的规划失败或问答失败样本，展示输入、错误、定位依据、修改和回归结果。本次没有获得这类实测记录，因此不编造故障经历，也不把下面的建议机制全部说成本人已实现。

**容易被追问的边界。**

| 问题 | 简答 |
|---|---|
| Agent 规划动作吗？ | 不规划。它选已有展台并排序；讲稿和动作由管理员预配。 |
| 两台机器人都想去同一展台？ | 检查展台配置容量与实际业务占用，下发前事务复核；冲突则等待或重排。 |
| 人群堵住导航路线怎么办？ | 本地导航先避障；持续受阻上报事件，中央只调整业务顺序或请求人工接管，不控制局部路径。 |
| 为什么还要人工审核？ | 自然语言可能有歧义，模型也不了解全部现场变化；审核是新路线生效前的边界。 |
| bot_mind 已有功能，为什么加 ZeroClaw？ | 若只是导航与播稿，不需要。主方案用确定性平台适配器；确有离线智能编排需求再评估 ZeroClaw。 |
| Java 平台只是一层 ChatClient 吗？ | 不是。ChatClient 给出草案与回答；任务、资源并发、版本、命令和事件由确定性业务服务管理。 |
| 做过导航算法吗？ | 中央平台没有；团队的 g1_base/Nav2 执行导航与避障，个人工作应按真实分工表述。 |

**再往下一层追问，回答思路如下。**

| 面试官追问 | 应说清的实现思路 |
|---|---|
| “Agent 生成的路线怎么保证可执行？” | 提供受控展台清单；用结构化输出拿编码和顺序；Java 查展台、点位、讲稿与容量；讲稿时长和有来源的移动估计只用于提示目标风险，导航未知时不保证结束时间；冲突展示给人审核。结构化 JSON 不是正确性保证。 |
| “这个中央规划 Agent 也做巡检吗？” | 已验收事实是展厅接待规划；巡检是复用规划骨架的扩展设计。巡检已有独立代码链路，尚无证据证明两者是同一套部署。可共用模型调用和审计基础能力，但候选资源、输出 Schema、业务校验、工单和执行适配必须按场景分开。 |
| “只有生成一条计划，智能体现在哪里？” | 先承认已交付功能边界；展示同批需求下模型辅助与固定模板的对照，以及输入变化时展台选择、必经点覆盖、无效草案和人工修改如何变化。没有这组证据就只称受约束计划生成，不声称多机自主优化。 |
| “为什么机器人不直接拿完整计划？” | 当前机器人只需安全执行当前站；完整路线和跨机器人资源事实由 Java 保持。改线只更新未执行步骤，下一个目标仍由 Java 决定。 |
| “两台机器人同时抢容量为 1 的展台怎么办？” | 计划时预判，出发前在事务中锁资源并复核占用；先抢到的预约，另一台等待或调整，确认访客离开展台后释放。不要只依赖模型建议或缓存读数。 |
| “已经下发导航，却发现改线，怎么处理？” | 先判当前命令能否继续；若必须改目标，发取消并等确定结果，状态不明则暂停；审核通过后只变更未完成路线，不能靠改数据库让机器人瞬间转向。 |
| “反馈丢了，能否重试？” | 先按 commandId 查询机器人实际阶段并对账。同一命令重投需机器人端去重；不确定是否已动作时不能换个新编号盲发。 |
| “知识问答为何不直接让机器人模型回答？” | 按 taskId/stepId 取得可信展台范围后检索统一知识库，可维护同一套资料和引用；回答只进入 TTS，不得直接推进任务或生成导航目标。 |
| “用了 DeepSeek-V4-Flash，为什么还要意图识别？” | 明确完整短句先由 Java 规则路由；开放式语音仍要区分控制、改线、专业问答和闲聊，不必另维护一个生产环境小模型。远端模型只返回受限意图，Java 校验状态并决定动作；手机按钮和本地安全停止不等它。 |
| “早期本机模型与后期移动 API 如何切换？” | 保持意图枚举、请求字段和 Java 状态机不变，替换 ChatModel 接入配置并回归控制误触发、歧义澄清和 P95 时延。V4-Flash 的发布时间是 2026 年 4 月，移动网关实际上线时间须用配置或日志证明。 |

**自测：能否从头到尾讲出来？**不看上文，按下面七句话复述一遍：①管理员先配置展台、点位、讲稿和动作；②规划 Agent 只选已有展台并排序；③Java 校验并让工作人员审核，保存 Task 和全部 Step；④到场后选择空闲机器人，逐站创建 Command，机器人导航、播稿并回 Event；⑤讲解完等待手机或语音“下一站”，问答不会推进；⑥两台机器人共享展台容量由 Java 事务约束；⑦访客改线或持续受阻触发剩余路线建议，经复核和人工审核后成为新版计划。若其中一句说不清，回到对应章节看例子，而不是死背类名。

**记住一句话：Agent 规划可审核的剩余业务路线，Java 保证多机器人共享资源和任务事实一致，bot_mind 与 g1_base 执行已配置讲解和本地安全控制。**

## 九、补充面试题：M3E 是怎么导出和部署的？

**面试官问：你说用了本地 m3e-base，模型怎么导出、部署并接入 Spring AI？**

**方案回答（仅当实际选型已核对后改成个人经历）：**“方案选 `moka-ai/m3e-base` 做中文向量化，先固定模型 revision 和导出依赖，把 ONNX 模型及对应 tokenizer 部署在服务器。Java 侧通过 EmbeddingModel 接口供入库和查询共用，向量维度为 768。要验证的不只是能启动，而是 Java 与 Python 的分词、池化和相似度结果一致。模型、预处理或池化变化时建新索引版本、重新向量化，验证后切换，不混用新旧向量。”

本次核对 **Spring AI v1.0.0 源码**：它读取三维 token 输出并用 attention mask 做 mean pooling，不是“默认 CLS”。因此要导出兼容的 token 表示，不能把二维 `sentence_embedding` 直接当同一种输出。接口节点名以实际产物为准；下列命令强制使用 transformers 导出路线，仍需在锁定依赖环境实跑。该版本结论不自动覆盖其他版本。[v1.0.0 源码](https://github.com/spring-projects/spring-ai/blob/v1.0.0/models/spring-ai-transformers/src/main/java/org/springframework/ai/transformers/TransformersEmbeddingModel.java)

~~~bash
pip install 'optimum[onnx]' sentence-transformers onnxruntime
# 先将指定 revision 的完整模型准备到本地；此处目录仅示意。
optimum-cli export onnx --model ./m3e-base-source --library-name transformers --task feature-extraction ./m3e-base-onnx
~~~

**最容易被追问的坑：**M3E 配置为 mean pooling、768 维；维度相同不意味着表示相同。核对模型哈希、tokenizer、attention mask、截断上限、输出节点和归一化；Python 与 Java 使用同一组长短句，比较 token IDs、向量差异及 TopK 排序，并包含批量 padding 测试。上面没有固定全部依赖，也未实际执行导出，因此是**待复现方案**。Spring 容器管理的 Bean 会完成初始化，脱离容器手动创建时需调用 `afterPropertiesSet()`。[M3E 配置](https://huggingface.co/moka-ai/m3e-base/blob/main/1_Pooling/config.json)、[Optimum 导出说明](https://huggingface.co/docs/optimum-onnx/onnx/usage_guides/export_a_model)、[Spring AI ONNX 说明](https://docs.spring.io/spring-ai/reference/api/embeddings/onnx.html)

## 十、校招应准备的证据与验收用例

### 10.1 面试中优先讲透这八个问题

| 连续追问 | 回答需要落到的细节 |
|---|---|
| 就两台机器人，为什么要 Agent？没有它会怎样？ | 模板也能接待；模型减少自然语言需求到可审路线的整理工作。用相同需求比较审核总耗时和人工修改，而非宣称机器人数量决定必须用 AI。 |
| 你本人做了什么？哪个 PR/类/接口能证明？ | 规划 Agent 与 RAG 是确认职责；列出本人具体的提示词、校验、检索、异常处理与测试工作。通信协议未核实前不背 WebSocket 选型理由。 |
| JSON 解析成功为什么还不能执行？ | 语义、权限、资源和状态仍可能错误；演示编造展台或旧任务上下文被拒绝的用例。若时间目标有风险，应明示估计依据与未知项，不能把导航耗时猜错当成模型格式错误。 |
| 模型规划不合理怎么定位？ | 分开记录需求解析、受控候选、模型草案、校验原因和人工修改；判断是信息缺失、提示词、资料配置还是确定性校验缺陷。 |
| 问答错了是检索错还是生成错？ | 先看正确证据是否进 TopK，再看答案是否受证据支持；分别改切块/召回和生成约束，不能只反复调 prompt。 |
| 你说没有答案就拒答，谁判断？ | 阈值、资料范围与证据充分性共同作用；阈值通过验证集调节，再用独立样本检验“错误回答”和“过度拒答”的取舍，不能把相似度当概率。 |
| 下一站与改线同时到达呢？ | 使用同一任务事务入口、步骤和版本前提；谁先提交决定另一请求拒绝或进入取消流程。能画出第五节时序即可，不必冒称已实现所有增强。 |
| 两台扩到十台最先改什么？ | 先压测模型配额/排队、状态推送、资源等待和端侧串行执行；没有瓶颈证据就不拆微服务。十台测试不能当成实际部署十台。 |

### 10.2 指标必须有分母、基线和测试条件

以下是建议统计口径，**本次没有测量结果**。已有验收通过不自动意味着存在这些统计；没有记录就说明尚未统计。

| 指标 | 定义与应保留的证据 |
|---|---|
| 规划有效率 | 通过硬约束校验的草案数 / 总草案数；同时报告超时、解析失败、业务不合法各有多少 |
| 规划业务价值 | 同批需求下，人工模板与模型辅助的“需求提交→最终审核”耗时、必须展台覆盖和人工修改情况 |
| Recall@K | 对有答案问题，检索到的标注相关片段数 / 全部标注相关片段数；可另报至少命中一条的 Hit@K，二者不混用 |
| 答案受证据支持率 | 人工标注的被证据支持关键结论数 / 答案关键结论总数；包含引用错误和资料冲突样本 |
| 无答案错误作答率 | 无答案问题中仍给出确定业务答案的数量 / 无答案问题总数；同时报告有答案问题被误拒答的比例 |
| 控制误触发 | 不应触发 NEXT 的语句中错误推进的数量 / 此类语句总数；分别测分类层和有人工授权门控后的执行层 |
| 响应体验 | 记录排队、分类、Embedding、检索、生成、首段可播的各段耗时，报告端到端 P50/P95、样本数和并发条件 |
| 故障恢复 | 断链后 UNKNOWN 数量、恢复到确定状态耗时、人工介入次数；不把“没有报错”当任务成功 |

RAG 起步可由本人和业务人员整理约 60～100 条问题，覆盖同义问法、型号、跨展台、无答案和上下文追问；这是建议样本量，不是已有数据。调参集与最终保留测试集分开，相近改写不要同时落入两组；记录资料/模型/prompt 版本、标注规则和原始输出。小样本的 0 次误触发只说明本轮没观察到错误，不保证线上永不误触发。

### 10.3 把异常测试写成可以判定的结果

| 注入场景 | 必须观察到的结果 |
|---|---|
| 两个不同 requestId 同时推进 S1 | 最多一条新 Command，currentStep 只前进一次；另一个请求明确冲突 |
| NEXT 与 V2 改线同时提交 | 提交顺序决定有效版本，不出现“数据库 V2、机器人执行未记录的 V1 目标” |
| outbox 提交后 Java 崩溃，或发送后未记回执 | 恢复重投相同 commandId，端侧不重复执行；无法判定的动作进入 UNKNOWN |
| 机器人先完成后断线；平台事件提交后丢 ACK | 本机补报；平台事件和状态只生效一次，不因重复事件丢失推进 |
| CANCEL 比原命令先到；旧任务命令在接管后迟到 | 撤销记录/控制权代次阻止旧命令启动；取消未确认时不开始新任务 |
| TTS 被打断或最后一个动作失败 | 不回报 EXPLAINED 成功，不自动允许下一站；有可查询的失败/取消结果 |
| 任务取消但访客仍在展台 | 资源保持占用或 UNKNOWN，工作人员清场确认后只释放一次 |
| 两组分别占 A/B 并互等，或窄通道互堵 | 不无限自动重试、不凭超时释放现场资源；出现可操作的等待区/人工处置提示 |
| 问答返回前切站、暂停或被另一问题打断 | 旧答案在 Java 与端侧播放门槛处均失效，不串话、不触发动作标记 |
| 新资料只入库一半或 Embedding 模型切换 | 旧已发布版本保持可用；不混用未发布 chunks 或新旧向量 |
| 模型/ASR/TTS/数据库分别故障 | 各自按第七节矩阵降级，界面不谎报完成；外部 API 故障不阻塞已授权的手机任务操作 |

Java 事务与消息重复可先用模拟机器人和故障注入验证；播放完成、动作取消、导航停止、实际清场和跨楼层交接必须有真机/现场记录。本文只完成文档及源码审查，没有执行这些测试，也没有修改运行系统。

### 10.4 面试前最后补齐的真实材料

1. 找到 Java 实际对接入口：Controller/客户端、配置中的目标服务类型和一条脱敏请求响应，确认是 HTTP、WebSocket、MCP 还是组合。SSH 登录记录只证明开发访问机器人，不代替这项核实；不要复制凭据到面试材料。
2. 列清本人负责的类/接口和与机器人团队的边界；选一条已验收的规划请求、一条问答请求，画出真实调用链。
3. 核对实际生成模型、Embedding、向量存储、Spring AI 版本及上线阶段；本文的示例配置不能直接当部署配置。
4. 准备一项真实失败案例和对应回归结果、验收范围及版本记录；新增增强设计用“如果继续完善，我会……”来讲。
