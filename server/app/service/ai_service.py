"""AI 功能的業務邏輯：狀態與額度、一句話解析（規則式解析失敗時的後備）、管理員設定。

安全原則：使用者文字只當資料；模型輸出一律經過驗證（欄位型別、金額範圍、分類／帳戶必須在使用者給的名單內、日期合理），
驗證不過的項目直接丟棄。不記錄文字與模型回應，只記錄次數。
"""
from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterator
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import utcnow
from app.core.request_info import ClientInfo
from app.model import AiUsage, AppSetting, User
from app.schema.ai import (
    AgentPlanRequest, AgentPlanResult, StatementEntry, StatementRequest, StatementResult, AiAdminOut, AiAdminUpdate, AiConsole, AiProviderInfo, AiStatus, AskRequest, AskResult, ChatRequest, BudgetPlanRequest, BudgetPlanResult, CategorizeItem,
    CategorizeRequest, CategorizeResult, ConsoleProvider, DayCount, InsightsRequest, InsightsResult, ParsedEntry, ParseEntryRequest,
    ParseEntryResult, PriceCheckRequest, PriceCheckResult, ReceiptRequest, RecentCall, SearchPlanRequest, SearchPlanResult, ExplainRequest, TestResult, TranscribeRequest, TranscribeResult, UsageTotals, UserUsage,
)
from app.service import ai_providers, ai_quota, ai_tasks
from app.service.audit_service import AuditService
from app.service.errors import ServiceError

CHAT_PER_HOUR = 40


def _history(body: object) -> dict:
    """前面幾句對話（最多 8 句、每句 400 字）。使用者的文字只當資料。"""
    h = getattr(body, "history", None) or []
    return {"對話紀錄": [{"誰": "使用者" if x.role == "user" else "助手", "說": x.text} for x in h]} if h else {}

log = logging.getLogger("aster.ai")

MAX_ENTRIES = 8

def _clean_names(names: list[str]) -> list[str]:
    seen: list[str] = []
    for n in names:
        n = n.strip()[:30]
        if n and n not in seen:
            seen.append(n)
    return seen


def _valid_date(v: object, today: date) -> str | None:
    if not isinstance(v, str):
        return None
    try:
        d = date.fromisoformat(v)
    except ValueError:
        return None
    # 合理範圍：過去 2 年到未來 30 天，否則視為模型亂猜
    return v if today - timedelta(days=730) <= d <= today + timedelta(days=30) else None


def validate_entries(data: object, categories: list[str], accounts: list[str], today: date) -> list[ParsedEntry]:
    raw = data.get("entries") if isinstance(data, dict) else data
    if not isinstance(raw, list):
        return []
    out: list[ParsedEntry] = []
    for item in raw[:MAX_ENTRIES]:
        if not isinstance(item, dict):
            continue
        try:
            amount = float(str(item.get("amount", "")).replace(",", ""))
            typ = item.get("type") if item.get("type") in ("expense", "income", "transfer") else "expense"
            pick = lambda v, allowed: v if isinstance(v, str) and v in allowed else None  # noqa: E731
            e = ParsedEntry(
                type=typ, amount=amount, note=str(item.get("note") or "").strip()[:60],
                category=pick(item.get("category"), categories), account=pick(item.get("account"), accounts),
                to_account=pick(item.get("to_account"), accounts) if typ == "transfer" else None,
                date=_valid_date(item.get("date"), today),
            )
        except (ValueError, TypeError):
            continue
        out.append(e)
    return out


class AiService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def status(self, user: User) -> AiStatus:
        lim = ai_quota.read_limits(self.db)
        configured = any(p.configured for p in ai_providers.providers())
        quota = ai_quota.quota_for(self.db, user.id, user.role, lim)
        if not lim.enabled:
            msg, available = "管理員已關閉 Cilo", False
        elif not configured:
            msg, available = "伺服器尚未設定 AI 供應商", False
        elif ai_quota.global_exhausted(self.db, lim):
            msg, available = "今日全站 Cilo 額度已用完，明天 00:00 重置", False
        else:
            msg, available = "可以使用", True
        return AiStatus(role=user.role, enabled=lim.enabled, configured=configured, available=available, message=msg, quota=quota)

    def _quota(self, user: User):  # noqa: ANN202
        return ai_quota.quota_for(self.db, user.id, user.role)

    def parse_entry(self, user: User, body: ParseEntryRequest) -> ParseEntryResult:
        categories, accounts = _clean_names(body.categories), _clean_names(body.accounts)
        today = date.fromisoformat(body.today)
        msg = ai_tasks.dumps({"今天": body.today, "可選分類": categories, "可選帳戶": accounts, "使用者文字": body.text})

        def validate(data: object) -> list[ParsedEntry]:
            entries = validate_entries(data, categories, accounts, today)
            if not entries:
                raise ValueError("no entries")
            return entries

        entries = ai_tasks.run_task(self.db, user, "parse_entry", ai_tasks.PARSE_ENTRY, msg, validate, fail_message="AI 沒能看懂這句話，請改用一般記帳")
        return ParseEntryResult(entries=entries, quota=self._quota(user))  # type: ignore[arg-type]

    def ask(self, user: User, body: AskRequest) -> AskResult:
        msg = ai_tasks.dumps({"問題": body.question, "摘要": body.summary, **_history(body)})
        r = ai_tasks.run_task(self.db, user, "ask", ai_tasks.ASK, msg, ai_tasks.v_ask, fail_message="AI 沒能回答這個問題，請換個說法")
        return AskResult(**r, quota=self._quota(user))  # type: ignore[arg-type]

    def _chat_guard(self, user_id: int) -> None:
        """閒聊不扣額度，所以另外限制每人每小時的次數，避免被當成免費的萬用聊天機器人。"""
        since = utcnow() - timedelta(hours=1)
        n = self.db.scalar(select(func.count()).select_from(AiUsage).where(AiUsage.user_id == user_id, AiUsage.kind == "chat", AiUsage.created_at >= since)) or 0
        if n >= CHAT_PER_HOUR:
            raise ServiceError(429, f"閒聊太頻繁了（每小時 {CHAT_PER_HOUR} 次），請稍後再試；記帳與查帳不受影響")

    def chat(self, user: User, body: ChatRequest) -> AskResult:
        self._chat_guard(user.id)
        r = ai_tasks.run_task(self.db, user, "chat", ai_tasks.CHAT, ai_tasks.dumps({"使用者說": body.question, **_history(body)}), ai_tasks.v_ask, fail_message="AI 沒能回答，請換個說法")
        return AskResult(**r, quota=self._quota(user))  # type: ignore[arg-type]

    def chat_sse(self, user_id: int, body: ChatRequest) -> Iterator[str]:
        """閒聊的串流版：不扣額度（cost 0），但有每小時次數上限。"""
        try:
            self._chat_guard(user_id)
        except ServiceError as e:
            return iter([f"event: error\ndata: {json.dumps({'status': e.status_code, 'detail': e.message}, ensure_ascii=False)}\n\n"])
        return self._sse(user_id, "chat", ai_tasks.CHAT, ai_tasks.dumps({"使用者說": body.question, **_history(body)}), ai_tasks.v_ask, "answer", "AI 沒能回答，請換個說法")

    def ask_sse(self, user_id: int, body: AskRequest) -> Iterator[str]:
        """問 AI 的串流版（SSE）：回答一邊生成一邊傳給前端，不用等整段寫完。"""
        msg = ai_tasks.dumps({"問題": body.question, "摘要": body.summary, **_history(body)})
        return self._sse(user_id, "ask", ai_tasks.ASK, msg, ai_tasks.v_ask, "answer", "AI 沒能回答這個問題，請換個說法")

    def agent_plan_sse(self, user_id: int, body: AgentPlanRequest) -> Iterator[str]:
        """操作助手的串流版：先把「規劃摘要」一邊生成一邊傳回（讓使用者知道它在做什麼），步驟要等完整驗證後才在 done 事件一次送出。"""
        cats, accs = _clean_names(body.categories), _clean_names(body.accounts)
        today = date.fromisoformat(body.today)
        people, goals, stocks = _clean_names(body.people), _clean_names(body.goals), _clean_names(body.stocks)
        payload: dict = {"今天": body.today, "需求": body.text, "可選分類": cats, "可選帳戶": accs}
        for key, names in (("可選對象", people), ("可選目標", goals), ("可選標的代號", stocks)):
            if names:
                payload[key] = names
        return self._sse(user_id, "agent_plan", ai_tasks.AGENT_PLAN, ai_tasks.dumps(payload),
                         lambda d: ai_tasks.v_agent_plan(d, cats, accs, today, people=people, goals=goals, stocks=stocks), "summary",
                         "AI 沒有對應的操作可以做這件事，請換個說法，或到各功能頁手動操作")

    def _sse(self, user_id: int, kind: str, system: str, msg: str, validate: Callable[[object], dict], partial_key: str, fail_message: str) -> Iterator[str]:
        """串流版的 run_task。事件：delta（{"t": 這次新增的文字}，只送 partial_key 這個欄位的內容）、done（和一般版相同的結果＋額度）、error（{"status", "detail"}）。
        額度規則和一般版一致：先預留，成功才扣，失敗、中斷、使用者關掉都會還回去。
        用自己的資料庫連線：串流回應送完之前，請求本身的連線可能已經收掉。"""
        def ev(name: str, data: object) -> str:
            return f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

        from app.db import session_scope  # 避免循環匯入
        try:
            for db in session_scope():
                user = db.get(User, user_id)
                if not user or not user.is_active:
                    raise ServiceError(401, "請先登入")
                if not any(p.configured for p in ai_providers.providers()):
                    raise ServiceError(503, "伺服器尚未設定 AI 供應商")
                ai_tasks._global_rpm_guard()  # noqa: SLF001
                row = ai_quota.reserve(db, user.id, kind, ai_tasks.COST[kind], user.role)
                confirmed = False
                try:
                    full, provider, model, sent, buf = "", "", "", "", ""
                    for ev_kind, payload in ai_providers.stream_text(system, msg, max_tokens=ai_tasks.MAX_TOKENS[kind]):
                        if ev_kind == "delta":
                            buf += payload  # type: ignore[operator]
                            shown = ai_providers.partial_json_string(ai_providers.visible_text(buf), partial_key)
                            if len(shown) > len(sent) and shown.startswith(sent):
                                yield ev("delta", {"t": shown[len(sent):]})
                                sent = shown
                        else:
                            full, provider, model = payload  # type: ignore[misc]
                    try:
                        result = validate(ai_providers.extract_json(ai_providers.clean_content(full)))
                    except (ValueError, TypeError, KeyError):
                        raise ServiceError(422, fail_message) from None
                    ai_quota.confirm(db, row, provider, model)
                    confirmed = True
                    log.info("AI %s(stream) user_id=%s provider=%s", kind, user.id, provider)
                    yield ev("done", {**result, "quota": AiService(db)._quota(user).model_dump(mode="json")})  # noqa: SLF001
                finally:
                    if not confirmed:  # 失敗、中斷（含使用者關掉）：不扣額度
                        ai_quota.release(db, row)
        except ServiceError as e:
            yield ev("error", {"status": e.status_code, "detail": e.message})
        except ValueError:
            yield ev("error", {"status": 502, "detail": "AI 回答到一半中斷了，沒有扣額度，請再試一次"})
        except Exception:  # noqa: BLE001
            log.exception("AI 串流失敗")
            yield ev("error", {"status": 500, "detail": "AI 暫時無法使用，請稍後再試"})

    def budget_plan(self, user: User, body: BudgetPlanRequest) -> BudgetPlanResult:
        cats = _clean_names(body.categories)
        msg = ai_tasks.dumps({"可選分類": cats, "摘要": body.summary})
        r = ai_tasks.run_task(self.db, user, "budget_plan", ai_tasks.BUDGET, msg, lambda d: ai_tasks.v_budget(d, cats), fail_message="AI 沒能產生預算建議，請稍後再試")
        return BudgetPlanResult(**r, quota=self._quota(user))  # type: ignore[arg-type]

    def insights(self, user: User, body: InsightsRequest) -> InsightsResult:
        msg = ai_tasks.dumps({"期間": body.label, "摘要": body.summary})
        r = ai_tasks.run_task(self.db, user, "insights", ai_tasks.INSIGHTS, msg, ai_tasks.v_insights, fail_message="AI 沒能產生洞察，請稍後再試")
        return InsightsResult(**r, quota=self._quota(user))  # type: ignore[arg-type]

    def categorize(self, user: User, body: CategorizeRequest) -> CategorizeResult:
        cats = _clean_names(body.categories)
        n = len(body.notes)
        msg = ai_tasks.dumps({"類型": "支出" if body.kind == "expense" else "收入", "可選分類": cats, "帳目": [{"i": i, "備註": t} for i, t in enumerate(body.notes)]})
        r = ai_tasks.run_task(self.db, user, "categorize", ai_tasks.CATEGORIZE, msg, lambda d: ai_tasks.v_categorize(d, n, cats), fail_message="AI 沒能分類這批帳目")
        return CategorizeResult(items=[CategorizeItem(**i) for i in r["items"]], quota=self._quota(user))  # type: ignore[index]

    def search_plan(self, user: User, body: SearchPlanRequest) -> SearchPlanResult:
        cats, accs, tags = _clean_names(body.categories), _clean_names(body.accounts), _clean_names(body.tags)
        today = date.fromisoformat(body.today)
        msg = ai_tasks.dumps({"今天": body.today, "描述": body.text, "可選分類": cats, "可選帳戶": accs, "可選標籤": tags})
        r = ai_tasks.run_task(self.db, user, "search_plan", ai_tasks.SEARCH_PLAN, msg, lambda d: ai_tasks.v_search_plan(d, cats, accs, tags, today), fail_message="AI 看不出要找什麼，請換個說法")
        return SearchPlanResult(**r, quota=self._quota(user))  # type: ignore[arg-type]

    def statement(self, user: User, body: StatementRequest) -> StatementResult:
        """帳單截圖 → 逐筆明細（2 點額度）。數字只是擷取結果，前端會用「明細加總＝帳單合計」驗證，且對帳比對在本機完成。"""
        today = date.fromisoformat(body.today)
        msg = ai_tasks.dumps({"今天": body.today})
        r = ai_tasks.run_task(self.db, user, "statement", ai_tasks.STATEMENT, msg, lambda d: ai_tasks.v_statement(d, today), images=[body.image],
                              fail_message="看不出這張截圖裡的交易明細，請拍清楚一點、一次截一頁，或改用 CSV 對帳")
        return StatementResult(entries=[StatementEntry(**e) for e in r["entries"]], total=r["total"], quota=self._quota(user))  # type: ignore[index]

    def agent_plan(self, user: User, body: AgentPlanRequest) -> AgentPlanResult:
        """把一句話整理成「工具＋參數」的步驟計畫。AI 只規劃，不執行；App 會在本機先預覽、使用者確認後才執行（可一鍵還原）。"""
        cats, accs = _clean_names(body.categories), _clean_names(body.accounts)
        today = date.fromisoformat(body.today)
        people, goals, stocks = _clean_names(body.people), _clean_names(body.goals), _clean_names(body.stocks)
        payload: dict = {"今天": body.today, "需求": body.text, "可選分類": cats, "可選帳戶": accs}
        # 只在有資料時才送（沒有欠款、目標或標的就不必多送一個空清單）
        for key, names in (("可選對象", people), ("可選目標", goals), ("可選標的代號", stocks)):
            if names:
                payload[key] = names
        msg = ai_tasks.dumps(payload)
        r = ai_tasks.run_task(self.db, user, "agent_plan", ai_tasks.AGENT_PLAN, msg,
                              lambda d: ai_tasks.v_agent_plan(d, cats, accs, today, people=people, goals=goals, stocks=stocks),
                              fail_message="AI 沒有對應的操作可以做這件事，請換個說法，或到各功能頁手動操作")
        return AgentPlanResult(**r, quota=self._quota(user))  # type: ignore[arg-type]

    def price_check(self, user: User, body: PriceCheckRequest) -> PriceCheckResult:
        msg = ai_tasks.dumps({"日期": body.date, "分類": body.category, "備註": body.note, "金額": body.amount, "幣別": body.currency.upper(), "usual": body.usual})
        r = ai_tasks.run_task(self.db, user, "price_check", ai_tasks.PRICE_CHECK, msg, ai_tasks.v_price_check, fail_message="AI 沒能判斷這筆的行情", free=True)
        return PriceCheckResult(**r)  # type: ignore[arg-type]

    def explain(self, user: User, body: ExplainRequest) -> InsightsResult:
        msg = ai_tasks.dumps({"對象": body.subject, "摘要": body.summary})
        r = ai_tasks.run_task(self.db, user, "explain", ai_tasks.EXPLAIN, msg, ai_tasks.v_insights, fail_message="AI 沒能產生解說，請稍後再試")
        return InsightsResult(**r, quota=self._quota(user))  # type: ignore[arg-type]

    def receipt(self, user: User, body: ReceiptRequest) -> ParseEntryResult:
        cats, accs = _clean_names(body.categories), _clean_names(body.accounts)
        today = date.fromisoformat(body.today)
        msg = ai_tasks.dumps({"今天": body.today, "可選分類": cats})

        def validate(data: object) -> list[ParsedEntry]:
            entries = validate_entries(data, cats, accs, today)
            if not entries:
                raise ValueError("no entries")
            return entries[:3]

        entries = ai_tasks.run_task(self.db, user, "receipt", ai_tasks.RECEIPT, msg, validate, images=[body.image], fail_message="看不出這張照片的消費金額，請拍清楚一點或改用手動記帳")
        return ParseEntryResult(entries=entries, quota=self._quota(user))  # type: ignore[arg-type]

    def transcribe(self, user: User, body: TranscribeRequest) -> TranscribeResult:
        text = ai_tasks.run_task(
            self.db, user, "transcribe", ai_tasks.TRANSCRIBE, "請將這段語音轉成繁體中文文字。",
            ai_tasks.v_transcribe, audio=(body.audio_b64, body.format), prefer=("gemini",),
            fail_message="語音辨識失敗，請再說一次或改用打字",
        )
        return TranscribeResult(text=str(text), quota=self._quota(user))  # type: ignore[arg-type]

    # ── 管理員 ──

    def admin_read(self) -> AiAdminOut:
        lim = ai_quota.read_limits(self.db)
        start = ai_quota.window_bounds()["daily"][0]
        by = dict(self.db.execute(
            select(AiUsage.provider, func.coalesce(func.sum(AiUsage.cost), 0)).where(AiUsage.created_at >= start, AiUsage.pending.is_(False)).group_by(AiUsage.provider)
        ).all())
        return AiAdminOut(
            enabled=lim.enabled, user_daily=lim.user_daily, user_weekly=lim.user_weekly, user_monthly=lim.user_monthly,
            global_daily=lim.global_daily, admin_daily=lim.admin_daily, admin_weekly=lim.admin_weekly, admin_monthly=lim.admin_monthly, overridden=lim.overridden,
            providers=[AiProviderInfo(name=p.name, model=p.model, configured=p.configured, cooling_down=ai_providers.cooling_down(p.name)) for p in ai_providers.providers()],
            used_today=ai_quota.global_used_today(self.db), used_today_by_provider={k or "-": int(v) for k, v in by.items()},
        )

    def admin_update(self, body: AiAdminUpdate, admin: User, client: ClientInfo) -> AiAdminOut:
        changes = {
            "ai_enabled": None if body.enabled is None else ("1" if body.enabled else "0"),
            "ai_user_daily": body.user_daily, "ai_user_weekly": body.user_weekly,
            "ai_user_monthly": body.user_monthly, "ai_global_daily": body.global_daily,
            "ai_admin_daily": body.admin_daily, "ai_admin_weekly": body.admin_weekly, "ai_admin_monthly": body.admin_monthly,
        }
        applied: dict[str, object] = {}
        for key, value in changes.items():
            if value is None:
                continue
            row = self.db.get(AppSetting, key)
            if row is None:
                self.db.add(AppSetting(key=key, value=str(value)))
            else:
                row.value = str(value)
            applied[key] = value
        if applied:
            AuditService(self.db).record("admin.settings", client, actor_id=admin.id, detail=applied)
        self.db.commit()
        return self.admin_read()

    # ── 主控台 ──

    def _by_user(self, since: datetime) -> dict[int, int]:
        rows = self.db.execute(
            select(AiUsage.user_id, func.coalesce(func.sum(AiUsage.cost), 0)).where(AiUsage.created_at >= since, AiUsage.pending.is_(False)).group_by(AiUsage.user_id)
        ).all()
        return {int(u): int(c) for u, c in rows}

    def console(self) -> AiConsole:
        b = ai_quota.window_bounds()
        day, week, month = (self._by_user(b[k][0]) for k in ("daily", "weekly", "monthly"))
        users = {u.id: u for u in self.db.scalars(select(User).where(User.id.in_(set(month) | set(week) | set(day))))} if (month or week or day) else {}
        names = {uid: u.username for uid, u in users.items()}
        by_role = {role: UsageTotals(
            today=sum(c for uid, c in day.items() if (users[uid].role if uid in users else "user") == role),
            week=sum(c for uid, c in week.items() if (users[uid].role if uid in users else "user") == role),
            month=sum(c for uid, c in month.items() if (users[uid].role if uid in users else "user") == role)) for role in ("user", "admin")}
        by_user = sorted(
            (UserUsage(user_id=uid, username=names.get(uid, f"#{uid}"), role=users[uid].role if uid in users else "user", today=day.get(uid, 0), week=week.get(uid, 0), month=month.get(uid, 0)) for uid in set(month)),
            key=lambda x: (-x.month, x.username),
        )[:30]
        recent_rows = self.db.execute(
            select(AiUsage, User.username).join(User, User.id == AiUsage.user_id, isouter=True).where(AiUsage.pending.is_(False)).order_by(AiUsage.id.desc()).limit(20)
        ).all()
        # 近 7 天（台北日）每日次數，沒有紀錄的日子補 0
        tz = ZoneInfo(get_settings().timezone)
        today_local = datetime.now(timezone.utc).astimezone(tz).date()
        counts: dict[str, int] = {(today_local - timedelta(days=i)).isoformat(): 0 for i in range(6, -1, -1)}
        first = datetime.combine(today_local - timedelta(days=6), datetime.min.time(), tzinfo=tz).astimezone(timezone.utc).replace(tzinfo=None)
        for at, cost in self.db.execute(select(AiUsage.created_at, AiUsage.cost).where(AiUsage.created_at >= first, AiUsage.pending.is_(False))):
            k = at.replace(tzinfo=timezone.utc).astimezone(tz).date().isoformat()
            if k in counts:
                counts[k] += int(cost)
        s = get_settings()
        providers = []
        for p in ai_providers.providers(s):
            h = ai_providers.health(p.name)
            providers.append(ConsoleProvider(
                name=p.name, model=p.model, base_host=urlparse(p.base_url).hostname or "", configured=p.configured,
                key_hint=("••••" + p.api_key[-4:]) if len(p.api_key) >= 12 else ("••••" if p.api_key else ""),
                cooling_down=ai_providers.cooling_down(p.name), cooldown_remaining_s=ai_providers.cooldown_remaining(p.name),
                ok=h.ok, fail=h.fail, last_ok_at=h.last_ok_at, last_fail_at=h.last_fail_at, last_error=h.last_error, last_latency_ms=h.last_latency_ms, extra_keys=sorted(p.extra),
            ))
        return AiConsole(
            settings=self.admin_read(), providers=providers,
            totals=UsageTotals(today=sum(day.values()), week=sum(week.values()), month=sum(month.values())),
            by_role=by_role, by_user=by_user,
            recent=[RecentCall(at=r.created_at, username=name or "（已刪除）", kind=r.kind, provider=r.provider, model=r.model, cost=r.cost) for r, name in recent_rows],
            daily=[DayCount(date=k, count=v) for k, v in counts.items()], timezone=s.timezone, server_time=utcnow(),
        )

    def test_provider(self, name: str, admin: User, client: ClientInfo) -> TestResult:
        r = ai_providers.check_provider(name)
        AuditService(self.db).record("admin.ai_test", client, success=r["ok"], actor_id=admin.id, detail={"provider": name, "result": r["detail"]})
        self.db.commit()
        return TestResult(**r)
