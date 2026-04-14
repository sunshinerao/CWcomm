# CWcomm 指标与 SLO 草案（MVP）

> 状态：Draft v0.1（与 `docs/functional-analysis.md` AC-01~AC-10 对齐）

---

## 1. 指标分层

- `SLI`：可量化服务表现指标。
- `SLO`：在统计窗口内对 SLI 的目标约束。
- `Alert`：当 SLI 偏离目标时触发运维动作的阈值。

统计窗口建议：
- 实时运行指标：5 分钟滚动窗口 + 1 小时窗口。
- 稳定性指标：24 小时窗口 + 7 天窗口。

---

## 2. 与 AC 映射

### AC-01 管理员 2 分钟内完成活动创建并发布

- SLI：`activity_publish_duration_seconds`
- 定义：从“创建活动请求成功”到“状态变更为 READY 成功”的耗时。
- SLO：P95 <= 120s（7 天窗口）。
- Alert：连续 15 分钟 P95 > 150s。

### AC-02 听众 10 秒内进入可收听状态

- SLI：`audience_join_ready_seconds`
- 定义：提交加入码到收到 `session.ready` 事件耗时。
- SLO：P95 <= 10s（24 小时窗口）。
- Alert：5 分钟窗口 P95 > 12s 且样本数 >= 100。

### AC-03 LIVE 期间稳定输出多语种字幕

- SLI：`subtitle_delivery_success_ratio`
- 定义：成功下发字幕片段数 / 应下发字幕片段数（按语种统计）。
- SLO：>= 99.0%（1 小时窗口）。
- Alert：任一语种 10 分钟窗口 < 98.0%。

### AC-04 单语种故障不影响其他语种

- SLI：`cross_language_isolation_ratio`
- 定义：单语种失败期间，其他语种持续输出事件占比。
- SLO：>= 99.5%（7 天窗口）。
- Alert：出现单语种失败并导致其他语种中断 >= 3 次/小时。

### AC-05 网络短断后自动恢复

- SLI：`session_reconnect_success_ratio`
- 定义：发生断连后在 15 秒内恢复会话的比例。
- SLO：>= 97.0%（24 小时窗口）。
- Alert：30 分钟窗口 < 95.0%。

### AC-06 TTS 故障时字幕链路持续可用

- SLI：`subtitle_survival_during_tts_failure_ratio`
- 定义：TTS 故障期间字幕持续输出活动占比。
- SLO：>= 99.9%（30 天窗口）。
- Alert：任意 TTS 故障导致字幕不可用即告警（P1）。

### AC-07 同步失败可重试且管理员可感知

- SLI-1：`sync_retry_success_ratio`
- 定义：首次失败任务在重试窗口内成功比例。
- SLO：>= 95.0%（7 天窗口）。

- SLI-2：`sync_failure_notification_latency_seconds`
- 定义：同步失败到管理员可见告警的耗时。
- SLO：P95 <= 60s（24 小时窗口）。
- Alert：失败告警延迟 > 120s 持续 10 分钟。

### AC-08 首次 SSO 登录可自动建档并映射角色

- SLI：`first_login_provision_success_ratio`
- 定义：首次外部登录成功创建本地用户并赋默认角色比例。
- SLO：>= 99.5%（7 天窗口）。
- Alert：30 分钟窗口 < 98.0%。

### AC-09 未授权用户不可进入受限活动

- SLI：`unauthorized_access_block_ratio`
- 定义：受限活动未授权访问被正确拦截比例。
- SLO：= 100%（30 天窗口）。
- Alert：出现 1 次漏拦截即 P1。

### AC-10 关键操作可审计追踪

- SLI：`audit_log_coverage_ratio`
- 定义：关键操作中成功写入审计日志的比例。
- SLO：>= 99.99%（30 天窗口）。
- Alert：5 分钟窗口 < 99.9%。

---

## 3. 全局平台 SLO（补充）

- `api_availability_ratio`：核心 API 可用性 >= 99.9%（30 天）。
- `ws_session_success_ratio`：WebSocket 建连成功率 >= 99.5%（24 小时）。
- `e2e_latency_ms`：端到端延迟 P95 <= 6000ms（1 小时），P50 <= 3500ms（1 小时）。
- `activity_sync_success_ratio`：活动同步任务成功率 >= 98.0%（24 小时）。

---

## 4. 指标埋点建议

服务端埋点：
- API 层：请求量、状态码、延迟、鉴权失败。
- Realtime 层：建连、重连、ACK 延迟、每语种片段吞吐。
- AI 链路：ASR/翻译/TTS 各阶段耗时与错误率。
- Integration：外部调用成功率、限流、重试次数、冲突数。

客户端埋点：
- 加入耗时、首帧时间、缓冲时长、断连次数。
- 语种切换耗时、字幕渲染失败率。

---

## 5. 告警分级建议

- `P1`：安全穿透、字幕全局不可用、审计链路中断。
- `P2`：多语种大面积异常、加入时延显著恶化、同步大面积失败。
- `P3`：单语种波动、局部时延抖动、重试成功率下降。

响应目标：
- P1：5 分钟内响应，30 分钟内给出缓解动作。
- P2：15 分钟内响应，2 小时内恢复至 SLO 警戒线内。
- P3：工作时段内处理并纳入迭代优化。

---

## 6. 仪表盘最小集（MVP）

- 实时运营看板：在线人数、加入成功率、E2E 延迟、降级状态。
- 语种质量看板：各语种字幕成功率、翻译失败率、TTS 可用率。
- 集成看板：OpenAPI 调用成功率、同步失败重试、冲突待处理量。
- 安全审计看板：登录失败、越权拦截、关键操作审计覆盖率。

---

## 7. 待确认项

1. 最终 SLO 是否区分活动等级（大型主会场 vs 普通活动）。
2. P1/P2/P3 的值班策略与通知渠道（短信/IM/电话）。
3. 监控系统选型与数据保留周期（原始明细、聚合指标）。
4. 是否引入错误预算机制（Error Budget）驱动发布节奏。
