# CWcomm API 草案（MVP）

> 状态：Draft v0.1（用于架构评审与并行开发对齐）

---

## 1. 设计约定

- 协议：HTTPS + JSON（实时链路另含 WSS 事件协议）。
- API 前缀：`/api/v1`。
- 时间格式：ISO 8601（UTC），示例 `2026-04-14T11:30:00Z`。
- 认证：Bearer Token（JWT/Opaque Token 均可，MVP 不锁死实现）。
- 幂等：写操作支持 `Idempotency-Key` 请求头（推荐 UUID）。

---

## 2. 通用规范

### 2.1 请求头

- `Authorization: Bearer <access_token>`
- `Content-Type: application/json`
- `Idempotency-Key: <uuid>`（可选，推荐用于创建/状态变更）
- `X-Request-Id: <trace-id>`（可选，用于链路追踪）

### 2.2 统一响应包络

成功：

```json
{
  "code": "OK",
  "message": "success",
  "data": {}
}
```

失败：

```json
{
  "code": "ACTIVITY_STATE_INVALID",
  "message": "Activity cannot transition from LIVE to READY",
  "requestId": "req_8f2...",
  "details": {
    "currentState": "LIVE",
    "targetState": "READY"
  }
}
```

---

## 3. 数据模型（接口视角）

### 3.1 Activity

```json
{
  "id": "act_01JX...",
  "source": "local",
  "externalSource": null,
  "externalId": null,
  "title": "Climate Week Keynote",
  "description": "...",
  "venue": "Hall A",
  "startAt": "2026-05-01T01:00:00Z",
  "endAt": "2026-05-01T03:00:00Z",
  "sourceLanguage": "en-US",
  "targetLanguages": ["zh-CN", "ja-JP", "es-ES"],
  "state": "READY",
  "join": {
    "joinCode": "K8F3P2",
    "joinUrl": "https://cwcomm.example.com/join/K8F3P2",
    "qrCodeUrl": "https://.../qr/act_01JX....png"
  },
  "sync": {
    "lastSyncedAt": null,
    "sourceVersion": null,
    "syncStatus": "NOT_APPLICABLE"
  },
  "createdAt": "2026-04-14T10:00:00Z",
  "updatedAt": "2026-04-14T10:05:00Z"
}
```

`source` 枚举：`local | climate_week_api`

`state` 枚举：`DRAFT | READY | LIVE | ENDED | ARCHIVED`

### 3.2 UserProfile

```json
{
  "id": "usr_01JX...",
  "displayName": "Alex",
  "email": "alex@example.com",
  "authProvider": "climate_week",
  "externalSubject": "cw_sub_9d...",
  "defaultRole": "viewer",
  "createdAt": "2026-04-14T09:10:00Z"
}
```

### 3.3 ActivityMemberRole

```json
{
  "activityId": "act_01JX...",
  "userId": "usr_01JX...",
  "role": "operator"
}
```

`role` 枚举：`viewer | operator | admin`

---

## 4. 认证与会话接口

### 4.1 发起气候周登录

`GET /api/v1/auth/climate-week/login?redirectUri=<url>&state=<opaque>`

行为：
- 服务端生成并返回跳转 URL，前端重定向到气候周授权页。

响应：

```json
{
  "code": "OK",
  "message": "success",
  "data": {
    "authorizeUrl": "https://id.climate-week.example.com/oauth2/authorize?..."
  }
}
```

### 4.2 登录回调（服务端）

`POST /api/v1/auth/climate-week/callback`

请求：

```json
{
  "code": "auth_code_xxx",
  "state": "opaque_from_client"
}
```

响应：

```json
{
  "code": "OK",
  "message": "success",
  "data": {
    "accessToken": "cwcomm_at_xxx",
    "refreshToken": "cwcomm_rt_xxx",
    "expiresIn": 3600,
    "user": {
      "id": "usr_01JX...",
      "displayName": "Alex",
      "defaultRole": "viewer"
    }
  }
}
```

说明：
- 首次登录时自动建档并绑定 `externalSubject`。
- 绑定冲突时返回 `AUTH_BINDING_CONFLICT`。

### 4.3 刷新令牌

`POST /api/v1/auth/refresh`

```json
{
  "refreshToken": "cwcomm_rt_xxx"
}
```

### 4.4 登出

`POST /api/v1/auth/logout`

行为：
- 本地会话失效，可选调用外部 IdP 登出端点。

---

## 5. 活动管理接口

### 5.1 创建活动

`POST /api/v1/activities`

请求：

```json
{
  "title": "Climate Week Keynote",
  "description": "Main hall keynote",
  "venue": "Hall A",
  "startAt": "2026-05-01T01:00:00Z",
  "endAt": "2026-05-01T03:00:00Z",
  "sourceLanguage": "en-US",
  "targetLanguages": ["zh-CN", "ja-JP", "es-ES"]
}
```

返回：`201 Created` + `Activity`

### 5.2 活动列表

`GET /api/v1/activities?state=LIVE&source=local&page=1&pageSize=20`

### 5.3 活动详情

`GET /api/v1/activities/{activityId}`

### 5.4 更新活动（非 LIVE 关键字段）

`PATCH /api/v1/activities/{activityId}`

说明：
- `LIVE` 状态下若修改 `sourceLanguage` 或音频输入关键配置，返回 `ACTIVITY_IMMUTABLE_WHEN_LIVE`。

### 5.5 活动状态迁移

`POST /api/v1/activities/{activityId}/state`

```json
{
  "targetState": "LIVE"
}
```

校验：
- `DRAFT -> READY` 要求最小配置完整。
- `READY -> LIVE` 要求音频健康检查通过。

### 5.6 生成/刷新加入信息

`POST /api/v1/activities/{activityId}/join-token`

响应：

```json
{
  "code": "OK",
  "message": "success",
  "data": {
    "joinCode": "K8F3P2",
    "joinUrl": "https://cwcomm.example.com/join/K8F3P2",
    "qrCodeUrl": "https://.../qr/act_01JX....png",
    "expiresAt": "2026-05-01T03:30:00Z"
  }
}
```

### 5.7 活动成员与角色

- `GET /api/v1/activities/{activityId}/members`
- `PUT /api/v1/activities/{activityId}/members/{userId}/role`

```json
{
  "role": "operator"
}
```

---

## 6. 气候周 OpenAPI 同步接口

### 6.1 手动触发单活动重同步

`POST /api/v1/integrations/climate-week/activities/{externalActivityId}/resync`

响应：

```json
{
  "code": "OK",
  "message": "queued",
  "data": {
    "jobId": "job_sync_01JX...",
    "status": "QUEUED"
  }
}
```

### 6.2 触发时间窗口增量同步

`POST /api/v1/integrations/climate-week/activities/sync`

```json
{
  "windowStartAt": "2026-04-14T00:00:00Z",
  "windowEndAt": "2026-04-14T23:59:59Z"
}
```

### 6.3 查询同步任务状态

`GET /api/v1/integrations/climate-week/sync-jobs/{jobId}`

```json
{
  "code": "OK",
  "message": "success",
  "data": {
    "jobId": "job_sync_01JX...",
    "status": "RUNNING",
    "total": 120,
    "success": 96,
    "failed": 5,
    "conflicted": 19,
    "startedAt": "2026-04-14T12:00:00Z",
    "finishedAt": null
  }
}
```

### 6.4 冲突查询与处理

- `GET /api/v1/integrations/climate-week/conflicts?status=PENDING`
- `POST /api/v1/integrations/climate-week/conflicts/{conflictId}/resolve`

```json
{
  "resolution": "USE_REMOTE"
}
```

`resolution` 枚举：`USE_REMOTE | KEEP_LOCAL | MERGE_FIELDS`

---

## 7. 终端加入与播放前接口

### 7.1 通过加入码解析活动

`POST /api/v1/join/resolve`

```json
{
  "joinCode": "K8F3P2"
}
```

返回：活动基础信息 + 可选语种 + 当前状态。

### 7.2 创建听众会话

`POST /api/v1/audience-sessions`

```json
{
  "activityId": "act_01JX...",
  "preferredLanguage": "zh-CN",
  "client": {
    "platform": "ios_safari",
    "appVersion": "web-0.1.0"
  }
}
```

响应包含：
- `sessionId`
- `wsUrl`（字幕与控制）
- `webrtcOffer` 或媒体协商参数（按实现方案）

### 7.3 切换语种

`POST /api/v1/audience-sessions/{sessionId}/language`

```json
{
  "language": "ja-JP"
}
```

---

## 8. 实时事件协议草案（WSS）

连接：`wss://cwcomm.example.com/ws?sessionId=<id>&token=<short_token>`

### 8.1 事件包结构

```json
{
  "event": "subtitle.delta",
  "eventId": "evt_01JX...",
  "activityId": "act_01JX...",
  "sessionId": "aud_01JX...",
  "timestamp": "2026-04-14T12:20:18.120Z",
  "payload": {}
}
```

### 8.2 服务端下行事件

`session.ready`

```json
{
  "event": "session.ready",
  "eventId": "evt_...",
  "payload": {
    "sessionId": "aud_01JX...",
    "activityState": "LIVE",
    "language": "zh-CN"
  }
}
```

`subtitle.delta`

```json
{
  "event": "subtitle.delta",
  "eventId": "evt_...",
  "payload": {
    "segmentId": "seg_01JX...",
    "sourceText": "Welcome to Climate Week",
    "translatedText": "欢迎来到气候周",
    "language": "zh-CN",
    "startMs": 102340,
    "endMs": 104880,
    "isFinal": false
  }
}
```

`subtitle.final`

```json
{
  "event": "subtitle.final",
  "eventId": "evt_...",
  "payload": {
    "segmentId": "seg_01JX...",
    "isFinal": true
  }
}
```

`audio.chunk.meta`（如需单独媒体片段元信息）

```json
{
  "event": "audio.chunk.meta",
  "eventId": "evt_...",
  "payload": {
    "chunkId": "tts_01JX...",
    "language": "zh-CN",
    "codec": "opus",
    "seq": 1029,
    "durationMs": 240
  }
}
```

`pipeline.degraded`

```json
{
  "event": "pipeline.degraded",
  "eventId": "evt_...",
  "payload": {
    "reason": "TTS_UNAVAILABLE",
    "fallback": "SUBTITLE_ONLY",
    "effectiveAt": "2026-04-14T12:22:10Z"
  }
}
```

`error`

```json
{
  "event": "error",
  "eventId": "evt_...",
  "payload": {
    "code": "SESSION_EXPIRED",
    "message": "session token expired"
  }
}
```

### 8.3 客户端上行事件

`client.ping`

```json
{
  "event": "client.ping",
  "eventId": "evt_c_1",
  "payload": {
    "sentAt": "2026-04-14T12:20:20.100Z"
  }
}
```

`session.switch_language`

```json
{
  "event": "session.switch_language",
  "eventId": "evt_c_2",
  "payload": {
    "language": "es-ES"
  }
}
```

`client.ack`

```json
{
  "event": "client.ack",
  "eventId": "evt_c_3",
  "payload": {
    "ackEventId": "evt_01JX..."
  }
}
```

### 8.4 重连与补偿

- 客户端重连可携带 `lastEventId`。
- 服务端应支持短窗口补发（例如最近 30~60 秒字幕增量）。
- 超窗后返回 `REPLAY_WINDOW_EXCEEDED`，客户端走全量状态重建。

---

## 9. 监控与管理接口（MVP 最小）

### 9.1 活动运行态概览

`GET /api/v1/activities/{activityId}/runtime`

```json
{
  "code": "OK",
  "message": "success",
  "data": {
    "onlineAudience": 356,
    "avgE2eLatencyMs": 3380,
    "subtitleErrorRate": 0.004,
    "audioInputHealthy": true,
    "degradedMode": "NONE"
  }
}
```

### 9.2 操作审计查询

`GET /api/v1/audit-logs?activityId=act_01JX...&action=ACTIVITY_STATE_CHANGE&page=1&pageSize=50`

---

## 10. 错误码草案

- `AUTH_UNAUTHORIZED`：未认证。
- `AUTH_FORBIDDEN`：无权限。
- `AUTH_BINDING_CONFLICT`：外部账号绑定冲突。
- `TOKEN_EXPIRED`：访问令牌过期。
- `ACTIVITY_NOT_FOUND`：活动不存在。
- `ACTIVITY_STATE_INVALID`：非法状态迁移。
- `ACTIVITY_IMMUTABLE_WHEN_LIVE`：活动进行中不可修改关键字段。
- `ACTIVITY_NOT_JOINABLE`：活动不可加入。
- `JOIN_CODE_INVALID`：加入码无效。
- `SESSION_EXPIRED`：听众会话失效。
- `SYNC_JOB_NOT_FOUND`：同步任务不存在。
- `SYNC_RATE_LIMITED`：外部接口限流。
- `SYNC_UPSTREAM_UNAVAILABLE`：外部接口不可用。
- `SYNC_CONFLICT_PENDING`：存在待处理同步冲突。
- `REPLAY_WINDOW_EXCEEDED`：重放窗口超限。
- `INTERNAL_ERROR`：内部错误。

---

## 11. 安全与幂等建议

- 所有状态变更接口要求 `Idempotency-Key`。
- 对 `/state`、`/join-token`、`/sync` 建议增加角色与频率限制。
- WebSocket 短 token 与 audience session 强绑定，默认 15 分钟有效并可滚动续期。
- 审计事件最少覆盖：登录、角色变更、活动状态变更、同步触发/失败、降级切换。

---

## 12. 待确认项（进入开发前）

1. 最终确认是否采用 JWT 还是 Opaque Token。
2. 外部同步冲突默认策略（自动 `USE_REMOTE` 还是人工确认）。
3. 实时媒体链路最终采用 WebRTC 还是 WebSocket 音频片段分发。
4. 字幕重放窗口时长与存储成本上限。
5. 错误码是否要按模块分段（如 `AUTH_1xxx`、`ACT_2xxx`）。
