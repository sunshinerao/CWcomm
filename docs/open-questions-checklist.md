# CWcomm 开放问题清单（评审版）

> 状态：Draft v0.1（汇总自 `requirements-and-plan`、`api-draft`、`system-architecture`、`metrics-slo`、`data-model-draft`、`iteration-plan`）

---

## 1. 使用说明

- 本清单用于“编码前冻结评审会”。
- 优先级定义：
  - `P0`：不决策会阻塞开发启动。
  - `P1`：不决策会显著影响联调与稳定性。
  - `P2`：可在实现后期确认，但会影响上线质量。
- 状态定义：`OPEN | IN_PROGRESS | DECIDED | DEFERRED`。

---

## 2. 决策清单（按优先级排序）

| ID | 主题 | 问题描述 | 优先级 | 建议决策阶段 | 主要影响 | 建议默认值 | 来源 | 状态 |
|---|---|---|---|---|---|---|---|---|
| Q-001 | 媒体分发主方案 | MVP 主链路采用 `WebRTC` 还是 `WS 音频分片` | P0 | 阶段0（冻结周） | Realtime 架构、前后端协议、性能指标 | `WebRTC 主链路 + 字幕兜底` | system-architecture/api-draft | OPEN |
| Q-002 | Token 方案 | 会话令牌采用 `JWT` 还是 `Opaque Token` | P0 | 阶段0 | Auth 实现、网关校验、会话撤销策略 | `Opaque + Redis 会话`（撤销更直接） | api-draft/system-architecture | OPEN |
| Q-003 | SSO 协议 | 气候周登录协议最终是 OAuth2/OIDC/SAML 哪一种 | P0 | 阶段0 | 登录链路、SDK 选型、回调流程 | `OIDC` 优先 | requirements-and-plan | OPEN |
| Q-004 | OpenAPI 字段字典 | 活动字段映射与必填规则是否冻结 | P0 | 阶段0 | 同步任务、冲突策略、数据模型 | 先冻结 MVP 字段最小集 | requirements-and-plan/api-draft | OPEN |
| Q-005 | 外部接入 SLA | OpenAPI 限流与可用性 SLA 是否明确 | P0 | 阶段0 | 重试退避、告警阈值、同步频次 | 以保守限流值设计（低 QPS） | requirements-and-plan | OPEN |
| Q-006 | MVP 语种范围 | MVP 必须支持的语种列表与优先级 | P0 | 阶段0 | 翻译/TTS 成本、压测场景、验收标准 | 先锁定 3 个主语种 | requirements-and-plan | OPEN |
| Q-007 | 并发目标 | 目标并发与峰值活动时长是否确认 | P0 | 阶段0 | 容量规划、成本预算、压测口径 | 500 并发、2 小时峰值基线 | requirements-and-plan/metrics-slo | OPEN |
| Q-008 | 数据合规 | 数据驻留、留存周期、审计要求边界 | P0 | 阶段0 | 表设计、归档、日志策略 | 先按最严格留存最小化原则 | requirements-and-plan/data-model-draft | OPEN |
| Q-009 | 冲突默认策略 | 同步冲突默认自动远端覆盖还是人工处理 | P1 | 阶段1前 | 同步效率、数据一致性风险 | 默认 `PENDING` + 人工确认 | api-draft/data-model-draft | OPEN |
| Q-010 | 字幕重放窗口 | `lastEventId` 补发窗口时长设定 | P1 | 阶段1前 | Redis/存储成本、重连体验 | 60 秒窗口起步 | api-draft/system-architecture | OPEN |
| Q-011 | 错误码规范 | 错误码是否按模块分段（如 AUTH_1xxx） | P1 | 阶段1 | 可维护性、前端处理一致性 | 模块化编号 | api-draft | OPEN |
| Q-012 | ID 生成策略 | `snowflake` / `ulid` / DB 序列选型 | P1 | 阶段1 | DB 设计、跨服务生成、一致性 | `ulid`（可读排序） | data-model-draft | OPEN |
| Q-013 | 会话存储安全 | `auth_sessions` 保存 hash 还是明文 token | P1 | 阶段1 | 安全合规、排障复杂度 | 仅存 hash | data-model-draft | OPEN |
| Q-014 | SLO 分层 | 是否按活动等级区分 SLO | P1 | 阶段2前 | 告警策略、运营预期管理 | 先统一 SLO，后续分层 | metrics-slo | OPEN |
| Q-015 | 告警值班机制 | P1/P2/P3 的通知渠道与值班流程 | P1 | 阶段2前 | 事故响应、试点风险 | P1 电话+IM，P2 IM，P3 工单 | metrics-slo | OPEN |
| Q-016 | 监控系统选型 | 指标/日志/链路追踪平台选型 | P1 | 阶段2前 | 埋点格式、运维成本 | 先一体化托管方案 | metrics-slo | OPEN |
| Q-017 | 错误预算机制 | 是否引入 Error Budget 约束发布 | P2 | 阶段3 | 发布节奏、质量治理 | MVP 可先不强制 | metrics-slo | OPEN |
| Q-018 | 冲突批处理能力 | 是否支持字段级批量冲突处理规则 | P2 | 阶段3 | 运营效率、后台复杂度 | MVP 暂不做批处理 | data-model-draft | OPEN |
| Q-019 | 团队并行度 | 是否具备 3 条泳道并行人力 | P0 | 阶段0 | 迭代计划可信度、上线时间 | 至少保障 2 条泳道稳定并行 | iteration-plan | OPEN |
| Q-020 | 试点窗口 | 试点活动日期与倒排发布时间 | P0 | 阶段0 | 发布计划、验收节奏 | 预留 2 周缓冲 | iteration-plan | OPEN |

---

## 3. 评审会议建议议程（90 分钟）

1. `P0` 决策（40 分钟）：Q-001~Q-008、Q-019、Q-020。
2. `P1` 决策（30 分钟）：Q-009~Q-016。
3. `P2` 处理策略（10 分钟）：Q-017~Q-018（可延后）。
4. 决策记录与责任人确认（10 分钟）。

---

## 4. 决策记录模板

```md
- ID: Q-00X
- 决策结果: （DECIDED / DEFERRED）
- 结论: ...
- 责任人: ...
- 截止日期: YYYY-MM-DD
- 影响文档: docs/api-draft.md, docs/data-model-draft.md
- 后续动作: ...
```

---

## 5. 文档联动规则

- 任一问题状态变为 `DECIDED` 后，必须在同一工作日更新相关文档。
- 涉及接口或数据模型的决策，需同步更新：
  - `docs/api-draft.md`
  - `docs/data-model-draft.md`
- 涉及稳定性目标的决策，需同步更新：
  - `docs/metrics-slo.md`
  - `docs/iteration-plan.md`
