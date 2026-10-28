"""Web Push：訂閱管理、排程（前端算好未來的提醒時間）、背景發送。

- 每台裝置一個訂閱；同一個 endpoint 重新訂閱會更新擁有者
- 排程以「使用者＋裝置」為單位整批取代：前端每次開啟 App 時重算接下來 14 天的提醒
- 背景迴圈每 30 秒找出到期的排程，先以 UPDATE 標記已送出（多個 worker 也不會重複），再送到該使用者的所有訂閱
"""
from __future__ import annotations

import asyncio
import logging
import time
from urllib.parse import urlparse

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.core import webpush
from app.core.request_info import ClientInfo
from app.core.security import utcnow
from app.model import PushSchedule, PushSubscription, User
from app.schema.push import PushStatus, ScheduleRequest, SubscribeRequest
from app.service.audit_service import AuditService
from app.service.errors import ServiceError

log = logging.getLogger("aster.push")

# 只允許瀏覽器內建的推播服務，避免伺服器被拿去對任意網址發送請求（SSRF）
PUSH_HOST_SUFFIXES = (
    ".googleapis.com", ".push.apple.com", ".mozilla.com", ".mozaws.net", ".notify.windows.com", ".push.services.mozilla.com",
)
MAX_SUBS_PER_USER = 20
LOOP_SECONDS = 30
# 錯過太久（伺服器停機）的提醒不再補發
STALE_MS = 6 * 3600 * 1000


def valid_endpoint(endpoint: str) -> bool:
    u = urlparse(endpoint)
    host = (u.hostname or "").lower()
    return u.scheme == "https" and any(host.endswith(s) or host == s.lstrip(".") for s in PUSH_HOST_SUFFIXES)


class SendReport:
    """一次發送的結果：有幾台裝置、成功幾台、失敗原因、是否值得稍後重試。"""

    def __init__(self) -> None:
        self.devices = 0
        self.ok = 0
        self.gone = 0
        self.retry = False
        self.failed: list[str] = []


# 暫時性失敗的重試次數（記憶體內；重啟歸零）
_attempts: dict[int, int] = {}
MAX_ATTEMPTS = 6


class PushService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def status(self, user: User, device_id: str | None) -> PushStatus:
        subs = self.db.scalars(select(PushSubscription).where(PushSubscription.user_id == user.id)).all()
        fail = webpush.last_failure
        q = select(PushSchedule).where(PushSchedule.user_id == user.id, PushSchedule.sent.is_(False))
        if device_id:
            q = q.where(PushSchedule.device_id == device_id)
        return PushStatus(public_key=webpush.vapid_public_key(), subscribed=any(not device_id or s.device_id == device_id for s in subs),
                          scheduled=len(self.db.scalars(q).all()), devices=len(subs),
                          last_error=(f"{fail['host']} 回應 {fail['status'] or '連線失敗'} {fail['detail']}".strip() if fail else ""))

    def subscribe(self, user: User, body: SubscribeRequest, client: ClientInfo) -> None:
        if not valid_endpoint(body.endpoint):
            raise ServiceError(422, "不支援的推播服務網址")
        sub = self.db.scalar(select(PushSubscription).where(PushSubscription.endpoint == body.endpoint))
        if sub is None:
            count = len(self.db.scalars(select(PushSubscription.id).where(PushSubscription.user_id == user.id)).all())
            if count >= MAX_SUBS_PER_USER:
                raise ServiceError(413, "推播裝置數已達上限")
            sub = PushSubscription(endpoint=body.endpoint, user_id=user.id, device_id=body.device_id, p256dh=body.keys.p256dh, auth=body.keys.auth)
            self.db.add(sub)
            AuditService(self.db).record("push.subscribe", client, user_id=user.id)
        sub.user_id = user.id
        sub.device_id = body.device_id
        sub.p256dh = body.keys.p256dh
        sub.auth = body.keys.auth
        self.db.flush()

    def unsubscribe(self, user: User, endpoint: str) -> None:
        self.db.execute(delete(PushSubscription).where(PushSubscription.user_id == user.id, PushSubscription.endpoint == endpoint))

    def schedule(self, user: User, body: ScheduleRequest) -> int:
        self.db.execute(delete(PushSchedule).where(PushSchedule.user_id == user.id, PushSchedule.device_id == body.device_id,
                                                   PushSchedule.sent.is_(False)))
        now = int(time.time() * 1000)
        seen: set[str] = set()
        n = 0
        for it in body.items:
            if it.id in seen or it.at < now - 60_000:
                continue
            seen.add(it.id)
            # 已送出的同一個提醒不再排
            exists = self.db.scalar(select(PushSchedule.id).where(PushSchedule.user_id == user.id, PushSchedule.device_id == body.device_id,
                                                                  PushSchedule.item_id == it.id))
            if exists:
                continue
            self.db.add(PushSchedule(user_id=user.id, device_id=body.device_id, item_id=it.id, at=it.at, title=it.title, body=it.body, url=it.url))
            n += 1
        self.db.flush()
        return n

    def send_to_user(self, user_id: int, message: dict) -> int:
        """送給使用者的所有訂閱；回傳成功數。失效的訂閱一併刪除。"""
        return self.send_detailed(user_id, message).ok

    def send_detailed(self, user_id: int, message: dict) -> SendReport:
        rep = SendReport()
        for sub in self.db.scalars(select(PushSubscription).where(PushSubscription.user_id == user_id)).all():
            rep.devices += 1
            r = webpush.send(sub.endpoint, sub.p256dh, sub.auth, message)
            if r.ok:
                rep.ok += 1
                sub.last_ok_at = utcnow()
            else:
                rep.failed.append(f"{urlparse(sub.endpoint).hostname} 回應 {r.status or '連線失敗'}" + (f"（{r.detail[:80]}）" if r.detail else ""))
                rep.retry = rep.retry or r.retry
                if r.gone:
                    self.db.delete(sub)
                    rep.gone += 1
        self.db.flush()
        return rep

    def deliver_due(self, now_ms: int | None = None) -> int:
        now = now_ms or int(time.time() * 1000)
        due = self.db.scalars(select(PushSchedule).where(PushSchedule.sent.is_(False), PushSchedule.at <= now).order_by(PushSchedule.at).limit(200)).all()
        sent = 0
        for item in due:
            claimed = self.db.execute(update(PushSchedule).where(PushSchedule.id == item.id, PushSchedule.sent.is_(False)).values(sent=True)).rowcount
            self.db.commit()
            if not claimed or now - item.at > STALE_MS:
                continue
            rep = self.send_detailed(item.user_id, {"title": item.title, "body": item.body, "url": item.url, "tag": item.item_id})
            if rep.ok:
                sent += 1
                _attempts.pop(item.id, None)
            elif rep.retry and not rep.ok and _attempts.get(item.id, 0) < MAX_ATTEMPTS:
                # 推播服務暫時連不上：不要把提醒吞掉，標回未送出，下一輪再試
                _attempts[item.id] = _attempts.get(item.id, 0) + 1
                self.db.execute(update(PushSchedule).where(PushSchedule.id == item.id).values(sent=False))
                log.warning("推播暫時失敗，稍後重試（第 %s 次）：%s", _attempts[item.id], "；".join(rep.failed))
            elif rep.devices == 0:
                log.warning("使用者 %s 沒有推播訂閱，略過提醒 %s（請在通知設定重新開啟背景推播）", item.user_id, item.item_id)
            else:
                log.warning("推播失敗：%s", "；".join(rep.failed))
            self.db.commit()
        # 清掉一週前已送出的排程
        self.db.execute(delete(PushSchedule).where(PushSchedule.sent.is_(True), PushSchedule.at < now - 7 * 86400_000))
        self.db.commit()
        return sent


async def push_loop() -> None:
    """背景發送迴圈（在 FastAPI lifespan 中啟動）。"""
    from app.db import session_scope

    while True:
        try:
            def run() -> int:
                n = 0
                for db in session_scope():  # 不可在迴圈內提前 return（會跳過 commit）
                    n = PushService(db).deliver_due()
                return n
            n = await asyncio.to_thread(run)
            if n:
                log.info("已發送 %s 則推播", n)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — 推播失敗不能讓迴圈停止
            log.exception("推播迴圈錯誤")
        await asyncio.sleep(LOOP_SECONDS)
