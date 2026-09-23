# 多机器人中央调度平台 V2 实施设计

> 状态：**拟实施的详细设计，不是已上线功能清单**。本文件将原《多机器人中央调度平台：设计、执行与面试》中的资源候补、可靠命令、等待问答和重规划方案收敛为一套可拆任务、可联调、可验收的目标实现。已确认的现场事实仍是两台机器人、一楼十几个展台和二楼约十个展台；中央规划 Agent 与 RAG 问答已在原项目验收范围。实际 Java—机器人业务协议和中央工程版本尚未取得，V2 不能据此冒充原系统的既有实现。

## 1. 交付边界与开工门槛

V2 首次交付覆盖**两台机器人、单展厅、人工审核路线、每展台可配置接待组容量**。同一机器人一次只服务一个接待任务；机器人本机继续负责导航、避障和动作安全。Java 只管理接待任务、资源名额、业务命令与反馈。跨楼层接力、自动强制结束另一组问答、全局无碰撞轨迹规划、真实人流计数均不进入首次交付。

开工前必须完成四项现场核对，产出脱敏接口记录和负责人签字，而不是从 SSH 联调方式推断协议：

1. 找到已验收 Java 工程、数据库迁移脚本、机器人业务调用入口和设备认证方式；列出原系统已有 Task、Step、Command、Event 能力。若没有可复用表，按本文件新建；若已有表，做字段映射和数据迁移，不并行维护两套事实。
2. 真机检查机器人到展厅本地服务器的连通方向、TLS 可用性、断网行为、导航取消与结果查询。V2 选用**机器人主动轮询 Java 的 HTTPS 命令接口 + 向 Java 上报事件**；若现场网络不允许机器人主动访问，先解决网络和证书，不私自退回 SSH 执行业务命令。
3. 确认机器人已有的 navigate_to、booth_show、TTS 和位置能力。现有 bot_mind 的 navigate_to 返回导航结果；booth_show 基于当前点位读取讲稿。现有 /voice/tts/speak 会起后台线程且可能在 ASR 期间忽略请求，**HTTP 200 不是播放完成**。新增适配器须提供真实的“回答已结束/被打断”事件，并通过联调验证。
4. 确定谁有权确认访客组离开展台。首次交付要求工作人员在界面确认“机器人和本组访客已离开讲解区域”；机器人位置只作辅助证据。没有这个确认，不自动释放容量。

建议技术基线是现有 Java 应用内的独立调度模块、MySQL 8.0.16+/InnoDB 作为业务事实库、机器人本地 SQLite 作为命令收件箱与结果发件箱。DDL 中的 CHECK 约束必须在实际 MySQL 版本验证确实生效；不满足版本门槛时由迁移方案调整，而不是假定数据库已强制约束。Redis 只允许存可重建的最新心跳/位置，不能承担展台名额的唯一真相。Spring Boot 与 JDK 版本以实际中央工程为准；不要为了本方案强行升级生产运行时。数据库事务按短事务设计，模型调用、TTS、HTTP、导航均在事务外。[MySQL 锁定读](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)在事务结束后释放锁，[Spring 声明式事务](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/annotations.html)默认只拦截经代理的外部方法调用；事务入口须放在独立 Service bean，避免同类自调用使注解失效。

## 2. 不可违反的业务不变量

| 编号 | 不变量 | 违反时处理 |
|---|---|---|
| I1 | 有效预约数不超过展台容量；WAITING 候补不占容量 | 拒绝新导航；计数与明细不一致时冻结新分配并告警 |
| I2 | 没有已提交的 RESERVED 预约，不存在指向该展台的新 VISIT 命令 | 事务回滚；不向机器人发目标 |
| I3 | 同一机器人至多一条未终结的普通执行命令；本机停止优先 | 拒绝第二条；UNKNOWN 时先对账 |
| I4 | 讲稿结束、点击下一站或心跳超时都不代表机器人和访客已离开展台 | 保留 OCCUPIED/UNKNOWN，等待确认 |
| I5 | 候补顺位不能自行导航；PROMOTED 的短时预约还要验证任务版本、机器人控制权与真实播报结束 | 失效则取消预约，兑现下一顺位 |
| I6 | 模型只能提出草案；不能写资源计数、跳过审核、生成机器人的硬件命令 | Java 校验或人工处理 |
| I7 | 设备重连后的同一 commandId 不重复执行；无法证明执行结局时保持 UNKNOWN | 停止自动推进并对账 |

“预约”在本文件里有两个不同概念：未来路线上的预估时间段只是**排程提示**；真正占容量的是目标即将出发时的 RESERVED，或 B 清场后给予首位候补的短时 RESERVED。不得在 14:00 就把 14:20 任务的整条路线全部硬锁。

## 3. 组件与真实接口边界

~~~text
工作人员/手机 ──任务、审核、清场确认──► Java ReceptionService
机器人适配器 ──轮询/ACK/执行事件──► Java RobotGateway
Java PlanningService ──受控候选和状态快照──► 规划模型（只出草案）
Java QaService ──当前展台和已发布知识──► RAG/问答模型（只出文本）
Java Scheduler ──Task/Step/Claim/Reservation/Command──► MySQL
Java RobotGateway ◄──HTTPS──► 每台机器人新增 Adapter ──► bot_mind ──► g1_base/Nav2
~~~

机器人适配器是**需要开发和部署的新组件**，不是现有 bot_mind 已经具备的中央平台接口。它负责保存收到的 commandId、校验 robotId/assignmentEpoch/commandSeq、串行调用已验证的本机能力、持久保存待上报事件。命令轮询与事件上报在导航/播报期间也要继续运行；本机安全停止不能排在普通导航队列尾部。每台设备使用独立凭据经 TLS 认证，Java 校验凭据与 robotId 绑定；同一展厅 Wi-Fi 不是身份凭据。

首次交付不要求 Kafka、分布式锁或多实例 Java。Java 单实例加 MySQL 事务足以调度两台机器人；若扩成多实例，仍以数据库条件更新和唯一约束维持正确性，另加消息领取及连接负载验证。可用性目标和容量目标必须来自压测，不从巡检项目借用“千台”“P95 780ms”等数字。

### 3.1 外部接口合同

| 接口 | 调用者 | 成功响应与幂等语义 |
|---|---|---|
| POST /api/v2/tasks/{taskId}/advance | 已授权工作人员 | 请求含 requestId、expectedTaskVersion、expectedPlanVersion、expectedStepId；返回 202 WAITING(claimId) 或 202 DISPATCH_QUEUED(commandId)。相同 requestId 与相同摘要返回原结果，摘要不同返回 409 |
| POST /api/v2/reservations/{reservationId}/clear | 已授权工作人员 | 请求含 requestId、mode=NORMAL/MANUAL_CLEAR、clearReason；NORMAL 须带 robotDepartureEventId，MANUAL_CLEAR 须主管权限与现场复核记录。重复确认返回原结果 |
| GET /api/robot/v2/{robotId}/messages | 本机适配器 | 拉取待确认的 PREPARE_DEPART、VISIT、CANCEL；重复拉取保持 messageId 和 commandId 不变 |
| POST /api/robot/v2/{robotId}/events | 本机适配器 | 事件含 eventId、messageId/commandId、assignmentEpoch、eventSeq、payloadHash；Java 落库后返回 ACK。重复 eventId 同内容返回原 ACK，异内容拒绝 |
| GET /api/robot/v2/{robotId}/snapshot | 本机适配器/对账任务 | 返回平台记录的活跃命令和控制权代次；机器人也须上报本机 inbox 的实际阶段，双方不一致时冻结新命令 |

例如机器人 2 在 A 请求下一站 B，B 被占用时响应：

~~~json
{
  "status": "WAITING",
  "taskId": "T-02",
  "fromStepId": "A-STEP",
  "targetExhibitCode": "B",
  "claimId": 1027,
  "currentPlanVersion": 3,
  "message": "B 展台正在接待，已进入候补"
}
~~~

接口没有“先回 200 已导航、后台再试预约”的路径。待审核改线返回单独的 DRAFT/PENDING_REVIEW，不复用 WAITING；版本冲突返回 409 并带当前版本，权限失败返回 403，机器人/展台状态不明返回可解释的 CONFLICT 而非假成功。同一 requestId 重试返回原操作结果；UI 要通过任务查询接口读取其后发生的候补晋升与命令状态，不能把旧 WAITING 响应理解为最新状态。所有写入口的 requestId、操作者、请求摘要和结果同业务事务持久化。机器人消息中的 payloadHash 要对规范化后的业务载荷计算，禁止同一 commandId 对应两个不同目标。

## 4. 最小持久化模型与索引

下列是**目标逻辑表及迁移基线**。实施时先与原工程现有表做映射，保留原主键和审计字段；以下 SQL 以 MySQL 8 为例，需在与生产相同的版本和隔离级别下跑迁移及并发测试。所有 DATETIME(3) 统一保存 UTC；lease_until 由数据库当前时间计算，客户端时钟只用于展示，避免机器人与 Java 时钟漂移导致提前放号。

~~~sql
CREATE TABLE exhibit_slot (
  exhibit_code       VARCHAR(64) PRIMARY KEY,
  capacity           INT NOT NULL,
  used_slots         INT NOT NULL DEFAULT 0,
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  version            BIGINT NOT NULL DEFAULT 0,
  CHECK (capacity > 0),
  CHECK (used_slots >= 0 AND used_slots <= capacity)
) ENGINE=InnoDB;

CREATE TABLE exhibit_wait_claim (
  claim_id           BIGINT PRIMARY KEY AUTO_INCREMENT, -- 自增值兼作同优先级 FIFO 顺位
  exhibit_code       VARCHAR(64) NOT NULL,
  task_id            VARCHAR(64) NOT NULL,
  robot_id           VARCHAR(64) NOT NULL, -- 入队时的归属快照，派发前还要核对当前归属
  from_step_id       VARCHAR(64) NOT NULL,
  target_step_id     VARCHAR(64) NOT NULL,
  base_plan_version  BIGINT NOT NULL,
  status             ENUM('WAITING','PROMOTED','CLAIMED','CANCELLED','EXPIRED') NOT NULL,
  reservation_id     BIGINT NULL,
  created_at         DATETIME(3) NOT NULL,
  -- 只有 WAITING/PROMOTED 才占“该任务的活跃候补位”；历史行可保留。
  active_task_key    VARCHAR(64) GENERATED ALWAYS AS (
    CASE WHEN status IN ('WAITING','PROMOTED') THEN task_id ELSE NULL END
  ) STORED,
  UNIQUE KEY uq_one_active_claim_per_task (active_task_key),
  KEY ix_wait_order (exhibit_code, status, claim_id)
) ENGINE=InnoDB;

CREATE TABLE exhibit_reservation (
  reservation_id     BIGINT PRIMARY KEY AUTO_INCREMENT,
  exhibit_code       VARCHAR(64) NOT NULL,
  task_id            VARCHAR(64) NOT NULL,
  step_id            VARCHAR(64) NOT NULL,
  claim_id           BIGINT NULL,
  command_id         VARCHAR(64) NULL,
  state              ENUM('RESERVED','OCCUPIED','UNKNOWN','RELEASED') NOT NULL,
  lease_until        DATETIME(3) NULL,
  cleared_by         VARCHAR(64) NULL,
  cleared_at         DATETIME(3) NULL,
  version            BIGINT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_reservation_claim (claim_id),
  UNIQUE KEY uq_reservation_command (command_id),
  KEY ix_exhibit_active (exhibit_code, state),
  KEY ix_task_reservation (task_id, state)
) ENGINE=InnoDB;

CREATE TABLE robot_command (
  command_id         VARCHAR(64) PRIMARY KEY,
  robot_id           VARCHAR(64) NOT NULL,
  task_id            VARCHAR(64) NOT NULL,
  step_id            VARCHAR(64) NOT NULL,
  assignment_epoch   BIGINT NOT NULL,
  command_seq        BIGINT NOT NULL,
  plan_version       BIGINT NOT NULL,
  waypoint_name      VARCHAR(128) NOT NULL,
  resource_version   VARCHAR(64) NOT NULL,
  state              ENUM('PENDING','RECEIVED','EXECUTING','SUCCEEDED',
                          'FAILED','CANCELLED','UNKNOWN') NOT NULL,
  created_at         DATETIME(3) NOT NULL,
  UNIQUE KEY uq_robot_sequence (robot_id, assignment_epoch, command_seq),
  KEY ix_task_command (task_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE robot_message_outbox (
  message_id         VARCHAR(64) PRIMARY KEY,
  robot_id           VARCHAR(64) NOT NULL,
  kind               ENUM('PREPARE_DEPART','RESUME_QA','VISIT','CANCEL') NOT NULL,
  command_id         VARCHAR(64) NULL,
  claim_id           BIGINT NULL,
  payload            JSON NOT NULL,
  state              ENUM('PENDING','ACKED') NOT NULL DEFAULT 'PENDING',
  created_at         DATETIME(3) NOT NULL,
  UNIQUE KEY uq_visit_message (command_id, kind),
  UNIQUE KEY uq_claim_message (claim_id, kind),
  KEY ix_robot_pending (robot_id, state, created_at)
) ENGINE=InnoDB;

CREATE TABLE robot_event (
  robot_id           VARCHAR(64) NOT NULL,
  event_id           VARCHAR(64) NOT NULL,
  command_id         VARCHAR(64) NULL,
  claim_id           BIGINT NULL,
  event_seq          BIGINT NOT NULL,
  event_type         VARCHAR(32) NOT NULL,
  payload            JSON NOT NULL, -- 包含 holdId/playbackEpoch 等可核对字段
  payload_hash       CHAR(64) NOT NULL,
  received_at        DATETIME(3) NOT NULL,
  PRIMARY KEY (robot_id, event_id),
  UNIQUE KEY uq_robot_event_seq (robot_id, event_seq),
  KEY ix_event_command (command_id, event_seq),
  KEY ix_event_claim (claim_id, received_at)
) ENGINE=InnoDB;

CREATE TABLE reception_operation (
  task_id            VARCHAR(64) NOT NULL,
  request_id         VARCHAR(64) NOT NULL,
  payload_hash       CHAR(64) NOT NULL,
  outcome            JSON NOT NULL,
  created_at         DATETIME(3) NOT NULL,
  PRIMARY KEY (task_id, request_id)
) ENGINE=InnoDB;

CREATE TABLE robot_assignment (
  robot_id           VARCHAR(64) PRIMARY KEY,
  owner_task_id      VARCHAR(64) NULL,
  assignment_epoch   BIGINT NOT NULL DEFAULT 0,
  last_command_seq   BIGINT NOT NULL DEFAULT 0,
  active_command_id  VARCHAR(64) NULL,
  status             ENUM('IDLE','BUSY','UNKNOWN','DISABLED') NOT NULL,
  version            BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB;
~~~

MySQL 唯一索引允许多个 NULL：因此 claim_id、command_id 可以在另一种预约路径中为空，但不能靠可空 command_id 判断“预约是否唯一”。真实接入还必须为 Task、Step 建表或映射既有表；最低要求是 Task 保存 planVersion/taskVersion/currentStepId。Claim 的 planVersion 只是快照，真正出发还要读 Task 当前版本。对上述新增表与既有表建立外键的时机由迁移方案决定；未完成映射前，Java 必须同事务检查引用，不能让孤儿命令可投递。

所有增加/减少 used_slots 的路径都锁同一 exhibit_slot 行，并在**同一 MySQL 事务**中更新 reservation；不得由定时任务根据 COUNT 直接覆写计数。每日对账比较占用态明细数与 used_slots，发现不一致先禁用该展台的新派发，记录异常并人工修复。迁移时先建表、导入当前占用且人工核对，再打开“强制预约”开关；不能把现有正在讲解的机器人默认为空闲。

## 5. 状态机与事务顺序

### 5.1 正常推进与 B 已占用

工作人员的 NEXT 请求携带 requestId、expectedTaskVersion、expectedPlanVersion、expectedStepId。Java 鉴权后开启事务，按**任务行 → 机器人分配行 → 按编码排序的展台行 → 预约/候补行**加锁。先查 operation_request：同编号同摘要返回原结果，同编号异内容报冲突。核对当前命令已确定完成；若目标 B 空闲且无更早的 WAITING 候补，执行以下条件更新：

~~~sql
UPDATE exhibit_slot
SET used_slots = used_slots + 1, version = version + 1
WHERE exhibit_code = :code
  AND enabled = TRUE
  AND used_slots < capacity;
-- 必须恰好影响 1 行；在同事务插入 RESERVED、Command、outbox 和操作结果。
-- 发送器只在 COMMIT 后向适配器投递，绝不持有数据库锁等待机器人。
~~~

若 B 满员，Task 和当前 A Step 不推进、不创建去 B 的 Command；插入一条 WAITING 候补并将结果返回页面。已有活跃候补的任务重试时复用原 claimId，不重新排队。机器人 2 可以在 A 回答关于 A 的问题或播放已审核补充讲稿；问答 Agent 的文本不能流入控制命令或动作解析器。A 仍占容量。等待太久、A 也需要让位、路线要求变更时，Java 提示工作人员选择安全等待点或审核改线；规划 Agent 可提出未执行步骤草案，但不能抢资源。

### 5.2 B 清场与首位候补兑现

只有工作人员确认机器人 1 和第一组已离开 B，且关联讲解命令已终结、机器人离开事件有效，Java 才接受普通 CLEAR 请求。请求带 reservationId 和幂等 requestId；审计确认人、机器人位置/命令证据和时间。机器人仅回报“讲完”不能触发 CLEAR。若定位/离开事件缺失但现场确已清空，须走主管权限的 MANUAL_CLEAR：记录现场复核人、原因和关联的安全停止/命令对账结果；命令仍为 UNKNOWN 且无法确认机器人安全状态时禁止强制清场。

~~~text
BEGIN
  锁原任务行，再锁 B 的 exhibit_slot 行和原 reservation 行
  原 reservation 已 RELEASED → 返回原清场结果
  校验确认人权限、原预约归属、命令已终结及清场证据
  原预约改 RELEASED；B.used_slots -= 1
  SELECT 首条 WAITING 候补 ORDER BY claim_id LIMIT 1 FOR UPDATE
  若 B 仍启用且有空位：
    B.used_slots += 1
    新增该候补的 RESERVED，lease_until = 数据库当前时间 + 配置的收尾窗口
    候补改 PROMOTED，写 PREPARE_DEPART outbox
COMMIT
~~~

B 行锁将“释放、选首位、再占名额”串行化；第三台机器人不能在两步之间插队。清场事务**不在持有 B 锁后再反向锁机器人 2 的任务行**，避免与 NEXT/取消入口形成锁环。即使机器人 2 在清场期间被取消，最多短暂生成无效 PROMOTED；后续校验会释放它并兑现下一位，不会给已取消任务发导航。B 被关闭时不兑现候补，通知工作人员。所有释放容量的入口，包括短时预约过期或取消，都调用同一兑现函数。

### 5.3 收尾、下发与租约

PREPARE_DEPART 是**收尾通知，不是导航命令**。机器人 2 的适配器收到后停止接收新的开放问题；若正在回答，等真正播放结束或被工作人员安全结束后，持久记录 READY_TO_DEPART(holdId, utteranceId, playbackEpoch) 事件并上报。现有 /voice/tts/speak 的返回值不满足这个条件，必须新增回调或由适配器围绕同步播放能力验证完成；无法取得可信结束事件时转人工确认，不把定时器当播报完成。

Java 消费 READY_TO_DEPART 时开启新事务，按任务→机器人→B→claim/reservation 锁序检查：任务仍 RUNNING、A 仍为当前 Step、计划版本及目标未变、claim=PROMOTED、hold=RESERVED 且未过期、robot assignmentEpoch 未变、播放事件绑定本次 hold。然后将 A Step 完成、B Step 设为当前，claim 改 CLAIMED，给 hold 绑定唯一 commandId，写 VISIT 命令和 outbox，一起提交。机器人适配器收到 VISIT 后先持久化去重，再执行 navigate_to；到站确认后才执行 booth_show。**机器人 2 与接待组实际离开 A 后**再清场 A；从准备出发到清场期间同时占用 A、B 两个名额是有意保守的。

短时预约过期扫描只可撤销“RESERVED + 无 commandId + 无待发送 VISIT + 已确认未出发”的 hold；同一事务将原 claim 改 EXPIRED、释放 B 并兑现下一候补。原任务仍停在 A，但不保留旧排队顺位；平台通知工作人员重新候补或改线，并向适配器发送“本次收尾已失效，可恢复 A 的问答”通知。迟到的 PREPARE_DEPART/READY_TO_DEPART 必须带 holdId 并经 Java 当前状态校验，不能让已过期 hold 创建导航。Command 一旦创建，网络超时或心跳过期只进入 UNKNOWN/对账，不得仅凭 lease_until 把 B 让给别人。若机器人已在路上但 Java 未收到 ACK，重投**同一** commandId，适配器按 SQLite inbox 返回已有状态，不再导航一次。

### 5.4 代码落点与避免虚假事务

以下接口是开发任务边界，实施时由独立 Service bean 对外提供事务方法；Mapper 只做单表读写，不在 Controller 中拼跨表更新：

~~~java
public interface ExhibitDispatchService {
    // 只做数据库判定；返回 WAITING 时绝不创建机器人导航命令。
    AdvanceResult advance(AdvanceRequest request);

    // 人工清场确认；释放旧占用与兑现首位候补必须同事务。
    ClearResult clearAndPromote(ClearRequest request);

    // READY_TO_DEPART 由机器人事件入口落库后调用；不得用 HTTP/TTS 请求返回代替。
    DispatchResult dispatchPromotedClaim(long claimId, String playbackEventId);

    // 仅允许回收无命令、未出发的短时预约；执行不明交给对账流程。
    int expireUndispatchedHolds(Instant databaseNow);
}
~~~

清场服务的关键实现应接近下面的事务代码。DAO 的 lock 方法必须使用 SELECT ... FOR UPDATE；改变容量和预约行的方法必须检查影响行数。认证与现场证据已在事务前提取，checkClearProof 只读取已落库事件，不调用网络服务：

~~~java
@Transactional(isolation = Isolation.READ_COMMITTED)
public ClearResult clearAndPromote(ClearRequest req) {
    TaskRow owner = taskDao.lock(req.ownerTaskId());
    ClearResult prior = operationDao.findReplayOrReject(req); // 同 ID 异内容抛冲突
    if (prior != null) return prior;                         // 网络重试直接返回原结果
    ExhibitRow booth = exhibitDao.lock(req.exhibitCode());
    ReservationRow old = reservationDao.lock(req.reservationId());
    if (old.state() == ReservationState.RELEASED) {
        operationDao.saveResultIfAbsent(req.ownerTaskId(), req.requestId(), "RELEASED");
        return ClearResult.released(); // 已由之前请求清场，本次不再扣容量
    }
    clearProofDao.checkClearProof(req, owner, old); // 校验机器人离开事件及人工确认

    requireOne(reservationDao.release(old.id(), old.version())); // CAS，重复释放不能扣两次
    requireOne(exhibitDao.decreaseUsed(booth.code()));           // 与预约更新同事务
    WaitClaimRow first = claimDao.lockFirstWaiting(booth.code());
    if (first != null && booth.enabled()) {
        requireOne(exhibitDao.increaseIfCapacity(booth.code()));
        long holdId = reservationDao.insertHold(first, databaseClock.deadline());
        requireOne(claimDao.promote(first.id(), holdId));        // WAITING → PROMOTED
        outboxDao.insertPrepareDepart(first.robotId(), first.id(), holdId);
    }
    operationDao.saveResult(req.ownerTaskId(), req.requestId(), "RELEASED");
    return ClearResult.released();
}
~~~

此代码只展示一个事务入口：外围还须实现请求摘要校验、MANUAL_CLEAR 主管权限、已失效首位候补的跳过/补偿，以及对数据库死锁的有限整事务重试。任何一步抛异常都必须回滚整个事务；不能捕获数据库异常后继续返回 RELEASED。booth.enabled() 是锁定行的当前值；如果容量被管理端修改，该写入口也必须先锁相同的 exhibit_slot 行。候补通知只在提交后由 outbox 投递。

事务方法须由 Controller/事件消费者调用 Spring 代理，不能在同一个类中用 this.dispatchPromotedClaim(...) 绕过事务代理。Mapper 的锁定查询必须在相同数据源和连接的事务内运行。锁等待和死锁可对**尚未向机器人发送消息的整笔数据库事务**做有限重试；机器人动作不能当作可回滚 SQL 重试。建议在本模块明确使用 READ COMMITTED，并用相同版本 MySQL 验证索引与锁行为；禁止在事务中混用旧快照 COUNT 判断容量。[MySQL 隔离级别说明](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html)。

## 6. 机器人协议与恢复契约

V2 目标传输选择机器人主动访问 Java：GET /api/robot/v2/{robotId}/messages 获取未 ACK 消息，POST /api/robot/v2/{robotId}/events 上报事件，GET /api/robot/v2/{robotId}/snapshot 用于重连对账。轮询间隔、网络超时和重试退避配置化，不能影响本机导航和紧急停止。所有业务报文含 protocolVersion、robotId、taskId、stepId、assignmentEpoch、commandId 或 holdId、单调序号、payloadHash；机器人认证身份必须与报文 robotId 一致。HTTP 接收成功只表示 Java 已持久化事件，不表示整场接待完成。

| 消息/事件 | 必须持久化后才能确认 | Java 可据此做什么 |
|---|---|---|
| PREPARE_DEPART(holdId) | 机器人记录本次收尾指令和 playbackEpoch | 等 READY_TO_DEPART；不得据此导航 |
| RESUME_QA(holdId) | 机器人记录该 hold 已失效，允许当前 A 展台继续问答 | 不回放旧问题、不自动重新排队 |
| READY_TO_DEPART(holdId, playbackEpoch) | 机器人确认当前播放已真实结束且不再接新问题 | 核对短时预约并创建 VISIT |
| VISIT(commandId, waypoint, resourceVersion) | 机器人 SQLite inbox 保存 commandId、payloadHash、epoch | 再执行导航；重复同 ID 回原状态，异 payload 拒绝 |
| ARRIVED / EXPLAINED / FAILED | 本机执行结果与待上报事件同存 | 更新当前 Command；EXPLAINED 不代表展台已清场 |
| CANCELLED / STOPPED / UNKNOWN | 必须区分“收到取消”与“已安全停止” | 只有确认停止才可改变目标；UNKNOWN 冻结后续自动下发 |

适配器调用现有 navigate_to 与 booth_show 的顺序需要真机合同测试：导航返回 success 后核验定位/目标点位；讲解工具返回后核验音频和必需动作确实结束。若工具无法提供完成/取消的确定证据，适配器不得伪造 EXPLAINED，先转人工或补机器人侧回调。CANCEL 即使先于目标 VISIT 到达，端侧也要持久化 commandId 撤销墓碑，拒绝随后迟到的旧命令；收到 CANCEL 的 ACK 仍不等于机器人已停，Java 等 STOPPED/安全状态。设备重启时读取 SQLite inbox/outbox，恢复未确认的事件；已开始但结局不明的物理动作返回 UNKNOWN，不能简单重播。Java 重启后重新扫描 PENDING outbox、活跃预约和 UNKNOWN 命令，先对账再恢复新任务。

## 7. 规划 Agent、RAG 与等待体验的上线条件

规划 Agent 的输入只能是有版本的展台候选、已审核业务约束和任务当前快照。输出以受约束 JSON Schema 为目标；解析失败可做有限次数格式修复，但展台不存在、必经点漏掉、资源不可用等语义错误由 Java 校验拒绝。模型调用不在数据库事务内。初次路线和改变接待顺序仍由工作人员审核；单纯“B 满员后在 A 候补”的固定规则不调用模型。若存在预先审核的备选顺序，Java 可用规则尝试下一站；没有授权就等待或提交重规划草案。

等待时可由机器人 2 在 A 邀请提问或播放**A 的已审核补充讲稿**。RAG 检索必须以可信 taskId/stepId 限定当前展台和已发布知识版本；证据不足则拒答。B 的短时预约成立后，适配器不再开始新问题，只完成当前回答，提示“接下来前往 B”。不能说“留在 A 继续向机器人 2 提问”，因为机器人 2 将离开。任何问答文本都只能走普通播报，不能作为动作或导航指令。

语音控制与问答分流：普通访客说“下一站”仅生成工作人员确认请求；授权工作人员手机 NEXT 才直接走任务接口。模型返回的 NEXT/ROUTE_CHANGE 只是候选意图，Java 再检验权限、任务版本、当前命令和资源。问题迟到时按 robotId/taskId/stepId/utteranceId 丢弃过期回答，切站后不播放 A 的 RAG 答案。

## 8. 失败矩阵、验收与发布顺序

| 用例 | 可判定结果 |
|---|---|
| 两个任务同时抢容量为 1 的 B | 只有一个 RESERVED/VISIT；另一个 WAITING；used_slots 始终不超过 1 |
| 机器人 1 还在 B 提问，机器人 2 在 A 请求下一站 | 机器人 2 不收到去 B 的 VISIT；A 可继续受控问答 |
| B 的 CLEAR 重复提交、事件乱序 | 只释放一次、只兑现一个首位候补；审计能关联原预约 |
| B 清场与机器人 2 取消并发 | 取消后不产生新导航；无效 hold 回收并兑现下一位；无锁环 |
| 两个候补依次排队，首位取消或短时预约过期 | 下一位取得名额，不能由新来的直接插队；旧 claim 仍可审计 |
| B 预约给机器人 2 后，A 的回答迟迟不结束 | 未下发时按收尾窗口撤销或由人延长；已下发/状态不明不自动释放 |
| PREPARE_DEPART 或 READY_TO_DEPART 在 hold 过期后迟到 | 校验 holdId/状态拒绝导航，机器人恢复 A 的问答或交工作人员 |
| 旧 ANSWER_DONE 事件在新 hold 后迟到 | playbackEpoch/holdId 不匹配，不能触发新 VISIT |
| 机器人 2 断网、Java 在提交 outbox 后重启 | 重投同 commandId；端侧不重复导航；不明动作转 UNKNOWN |
| A、B 两组互相等对方占用展台 | 检测业务循环等待，提示预设等待点或人工改线；不靠数据库死锁检测 |
| RAG 无答案、跨展台片段或过期回答 | 拒答/过滤/丢弃，不触发 NEXT 或动作 |
| 展台关闭、讲稿版本更新、跨楼层不可用 | 草案/审核/出发三处校验；不以旧版本直接下发 |

测试必须包含真实 MySQL 并发事务、机器人模拟器断网/重启和两台真机联调。最少留下三类证据：数据库约束与并发测试结果；一条正常命令及一次未知状态的完整 taskId/claimId/reservationId/commandId/eventId 追踪；工作人员清场确认和现场视频/日志对应关系。建议将“展台双重占用次数=0、未知命令不自动续派、两机器人问答不串站”设为发布阻断项；延迟目标在现场基线测量后确定，不能先写成已达到的 SLA。

发布顺序：先只读观测与数据迁移 → 开启人工清场和数据库预约但不自动下发 → 用机器人模拟器验证候补与恢复 → 单台真机灰度 → 两台真机冲突场景验收 → 最后开放等待期间问答。每步保留开关和回滚记录。关闭新功能时先停止产生新 Claim/Command，核对并清理**未下发**预约；仍在执行或 UNKNOWN 的命令不能因回滚脚本自动释放。现场工作人员始终可安全暂停并人工接管。

## 9. 开发任务拆分与完成定义

1. **事实核对与接口合同**：补齐原 Java 工程、机器人能力与网络认证清单；未完成不进入真机开发。
2. **MySQL 迁移与事务服务**：实现 Task/Step/Claim/Reservation/Command/outbox、幂等、条件更新和每日对账；并发测试通过。
3. **机器人适配器**：实现持久 inbox/outbox、轮询与事件、顺序导航/讲解、真实播放结束、停止和重连对账；真机验证每个事件语义。
4. **等待体验与规划规则**：受控 A 展台问答/补充讲稿、B 候补通知、预审核换序、人工处理入口；不把模型放在名额抢占事务中。
5. **可观测性与验收**：按 taskId、claimId、reservationId、commandId 串起日志、界面和验收记录；失败矩阵逐项签收。

完成定义是**部署产物、迁移脚本、接口合同、自动化并发测试、两台真机联调记录和人工操作说明同时具备**。本文件是可实施目标设计；只有这些交付证据齐全，才能将某项从“拟实施”改成“已实现/已验收”。
