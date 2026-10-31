"""對外通知：通道管理、測試、把事件轉送到使用者開啟的通道。

- 通道設定的機密加密存放；列表只回遮罩後的提示
- 事件由 App（偵測到異常、預算超支…）或排程提醒（週報、月報、繳款）觸發；每個通道各自勾選要收哪些類型
- 發送是同時進行的，單一通道失敗或逾時不影響其他通道；失敗原因記在通道上讓使用者看得到
- 每人最多 10 個通道；連續失敗不會自動停用（可能只是暫時），由使用者在畫面上看到錯誤後處理
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import outgoing, secretbox
from app.core.config import get_settings
from app.core.outgoing import DEFAULT_EVENTS, ConfigError, Notice
from app.core.request_info import ClientInfo
from app.core.security import utcnow
from app.model import NotifyChannel, User
from app.schema.notify import ChannelCreate, ChannelOut, ChannelPatch, EventRequest, EventResult
from app.service.audit_service import AuditService
from app.service.errors import ServiceError

log = logging.getLogger("aster.notify")
MAX_CHANNELS = 10
KIND_NAME = {"discord": "Discord", "telegram": "Telegram", "line": "LINE", "webhook": "Webhook"}


def to_out(c: NotifyChannel) -> ChannelOut:
    return ChannelOut(id=c.id, kind=c.kind, name=c.name, hint=c.hint, events=[e for e in c.events.split(",") if e], enabled=c.enabled,
                      last_ok_at=c.last_ok_at, last_error=c.last_error)


def app_link(path: str) -> str:
    """App 內路徑 → 完整網址；沒設定 CLURE_PUBLIC_URL 或路徑不是站內路徑就不附連結"""
    base = get_settings().public_url.strip()
    if not base or not path.startswith("/") or path.startswith("//"):
        return ""
    return urljoin(base.rstrip("/") + "/", path.lstrip("/"))


class NotifyService:
    def __init__(self, db: Session) -> None:
        self.db = db

    # ── 管理 ──
    def channels(self, user: User) -> list[NotifyChannel]:
        return list(self.db.scalars(select(NotifyChannel).where(NotifyChannel.user_id == user.id).order_by(NotifyChannel.id)).all())

    def _get(self, user: User, cid: int) -> NotifyChannel:
        c = self.db.scalar(select(NotifyChannel).where(NotifyChannel.id == cid, NotifyChannel.user_id == user.id))
        if c is None:
            raise ServiceError(404, "找不到這個通知通道")
        return c

    def create(self, user: User, body: ChannelCreate, client: ClientInfo) -> NotifyChannel:
        if len(self.channels(user)) >= MAX_CHANNELS:
            raise ServiceError(413, f"最多 {MAX_CHANNELS} 個通知通道，請先刪除不用的")
        try:
            cfg = outgoing.validate_config(body.kind, body.config)
        except ConfigError as e:
            raise ServiceError(422, str(e)) from e
        events = body.events or list(DEFAULT_EVENTS)
        c = NotifyChannel(user_id=user.id, kind=body.kind, name=(body.name.strip() or KIND_NAME[body.kind])[:40], secret=secretbox.seal(cfg),
                          hint=outgoing.hint_for(body.kind, cfg), events=",".join(events), enabled=True)
        self.db.add(c)
        self.db.flush()
        AuditService(self.db).record("notify.channel_create", client, user_id=user.id, detail={"kind": c.kind})
        return c

    def update(self, user: User, cid: int, body: ChannelPatch) -> NotifyChannel:
        c = self._get(user, cid)
        if body.name is not None:
            c.name = body.name.strip()[:40] or KIND_NAME[c.kind]
        if body.enabled is not None:
            c.enabled = body.enabled
        if body.events is not None:
            c.events = ",".join(body.events)
        if body.config is not None:
            try:
                cfg = outgoing.validate_config(c.kind, body.config)
            except ConfigError as e:
                raise ServiceError(422, str(e)) from e
            c.secret = secretbox.seal(cfg)
            c.hint = outgoing.hint_for(c.kind, cfg)
            c.last_error = ""
        self.db.flush()
        return c

    def delete(self, user: User, cid: int, client: ClientInfo) -> None:
        c = self._get(user, cid)
        self.db.delete(c)
        AuditService(self.db).record("notify.channel_delete", client, user_id=user.id, detail={"kind": c.kind})

    # ── 發送 ──
    def _send_one(self, c: NotifyChannel, notice: Notice) -> outgoing.SendResult:
        try:
            cfg = secretbox.open_(c.secret)
        except Exception:  # noqa: BLE001 — 伺服器金鑰換過，舊設定解不開
            return outgoing.SendResult(False, 0, "設定無法解密（伺服器金鑰變更過），請刪除後重新新增")
        return outgoing.send(c.kind, cfg, notice)

    def _record(self, c: NotifyChannel, r: outgoing.SendResult) -> None:
        if r.ok:
            c.last_ok_at = utcnow()
            c.last_error = ""
        else:
            c.last_error = r.detail[:200]

    def test(self, user: User, cid: int) -> outgoing.SendResult:
        c = self._get(user, cid)
        notice = Notice(event="test", title="Aster 測試通知 🔔", body="收到這則訊息代表通知設定成功！之後有異常大額、預算超支、週報出爐時，會直接傳到這裡。",
                        level="success", url=app_link("/settings/channels"), fields=[("通道", c.name)])
        r = self._send_one(c, notice)
        self._record(c, r)
        self.db.flush()
        return r

    def fan_out(self, user_id: int, notice: Notice) -> EventResult:
        """轉送給這位使用者「已開啟、且勾選了這類通知」的所有通道"""
        chans = [c for c in self.db.scalars(select(NotifyChannel).where(NotifyChannel.user_id == user_id, NotifyChannel.enabled.is_(True))).all()
                 if notice.event in c.events.split(",")]
        if not chans:
            return EventResult(channels=0, sent=0, failed=[])
        with ThreadPoolExecutor(max_workers=min(5, len(chans))) as pool:
            results = list(pool.map(lambda c: self._send_one(c, notice), chans))
        failed: list[str] = []
        for c, r in zip(chans, results):
            self._record(c, r)
            if not r.ok:
                failed.append(f"{c.name}：{r.detail}")
        self.db.flush()
        return EventResult(channels=len(chans), sent=sum(1 for r in results if r.ok), failed=failed)

    def event(self, user: User, body: EventRequest) -> EventResult:
        return self.fan_out(user.id, Notice(event=body.event, title=body.title, body=body.body, level=body.level, url=app_link(body.path), fields=list(body.fields)))


# 排程提醒（週報、月報、繳款…）的 item_id 前綴 → 通知類型
_PREFIX_EVENT = {"daily": "daily", "weekly": "weekly", "monthly": "monthly", "card": "reminder", "sub": "reminder", "wish": "reminder", "backup": "reminder"}


def schedule_notice(item_id: str, title: str, body: str, url: str) -> Notice:
    event = _PREFIX_EVENT.get(item_id.split(":", 1)[0], "reminder")
    return Notice(event=event, title=title, body=body, level="info", url=app_link(url))
