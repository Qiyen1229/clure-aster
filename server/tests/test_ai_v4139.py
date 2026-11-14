"""v4.1.39 全能助手：15 個新工具的規劃驗證、草稿名稱串接、記帳擴充（分帳／標籤／專案／排除旗標）。"""
from __future__ import annotations

from datetime import date

import pytest

from app.schema.ai import AgentPlanRequest
from app.service import ai_tasks
from app.service.ai_service import _agent_plan_payload

TODAY = date(2026, 11, 9)
CATS, ACCS = ["午餐", "飲料"], ["錢包", "中國信託"]
KW = dict(people=["小明"], goals=["日本旅遊"], stocks=["0050"], projects=["沖繩"],
          recurring=["Netflix"], wishes=["耳機"], durables=["相機"], inbox=["全家"])


def plan(steps: list[dict], **kw) -> list[dict]:
    return ai_tasks.v_agent_plan({"summary": "x", "steps": steps}, CATS, ACCS, TODAY, **{**KW, **kw})["steps"]


def test_new_tools_pass_validation() -> None:
    ok = plan([
        {"tool": "add_installment", "args": {"name": "手機", "account": "錢包", "amount": 12000, "periods": 12, "apr": 0, "fee": 0, "first_date": "2026-11-09"}},
        {"tool": "add_project", "args": {"name": "日本行", "is_travel": True, "budget": 50000, "currency": "jpy"}},
        {"tool": "set_travel_mode", "args": {"project": "沖繩"}},
        {"tool": "manage_recurring", "args": {"name": "Netflix", "action": "confirm", "date": "2026-11-01", "amount": 450}},
        {"tool": "manage_inbox", "args": {"action": "book", "keyword": "全家"}},
        {"tool": "add_category", "args": {"name": "毛孩", "kind": "expense", "parent": "午餐"}},
        {"tool": "add_dividend", "args": {"symbol": "0050", "per_share": 2, "kind": "cash"}},
        {"tool": "add_wish", "args": {"name": "鍵盤", "price": 3000, "cool_days": 14, "url": "https://example.com"}},
    ])
    assert [s["tool"] for s in ok] == ["add_installment", "add_project", "set_travel_mode", "manage_recurring", "manage_inbox", "add_category", "add_dividend", "add_wish"]
    assert ok[0]["args"]["periods"] == 12 and ok[0]["args"]["apr"] == 0
    assert ok[1]["args"]["currency"] == "JPY" and ok[1]["args"]["is_travel"] is True
    assert ok[2]["args"] == {"project": "沖繩"}
    assert ok[3]["args"]["amount"] == 450.0 and ok[3]["args"]["date"] == "2026-11-01"
    assert ok[4]["args"] == {"action": "book", "keyword": "全家"}
    assert ok[5]["args"]["parent"] == "午餐"
    assert ok[6]["args"]["per_share"] == 2.0
    assert ok[7]["args"]["cool_days"] == 14 and ok[7]["args"]["url"] == "https://example.com"


def test_more_new_tools() -> None:
    ok = plan([
        {"tool": "decide_wish", "args": {"name": "耳機", "decision": "extend"}},
        {"tool": "manage_durable", "args": {"action": "add", "name": "單車", "cost": 20000, "life_years": 10}},
        {"tool": "manage_durable", "args": {"action": "use", "name": "相機"}},
        {"tool": "manage_durable", "args": {"action": "sell", "name": "相機", "price": 0, "account": "錢包"}},
        {"tool": "add_watch", "args": {"symbol": "0050", "price": 200, "op": "<="}},
        {"tool": "delete_transfer", "args": {"match": {"from_account": "錢包", "amount": 500}}},
        {"tool": "manage_debt", "args": {"person": "小明", "action": "unsettle", "amount": 3500}},
        {"tool": "edit_goal", "args": {"goal": "日本旅遊", "set": {"target_amount": 200000, "deadline": "2027-06-30", "account": "錢包", "status": "archived"}}},
    ])
    assert len(ok) == 8
    assert ok[0]["args"] == {"name": "耳機", "decision": "extend"}
    assert ok[1]["args"]["cost"] == 20000.0 and ok[1]["args"]["life_years"] == 10
    assert ok[3]["args"]["price"] == 0.0  # 淘汰填 0 要放行
    assert ok[4]["args"]["op"] == "<="
    assert ok[5]["args"]["match"]["amount"] == 500.0
    assert ok[6]["args"]["action"] == "unsettle"
    assert ok[7]["args"]["set"]["status"] == "archived" and ok[7]["args"]["set"]["account"] == "錢包"


def test_add_account_and_travel_back_to_normal() -> None:
    ok = plan([
        {"tool": "add_account", "args": {"name": "現金", "type": "cash", "initial_balance": 500}},
        {"tool": "set_travel_mode", "args": {"project": None}},
        {"tool": "add_watch", "args": {"symbol": "0050"}},
        {"tool": "add_wish", "args": {"name": "滑鼠", "price": 1500, "url": "javascript:alert(1)"}},
    ])
    assert ok[0]["args"] == {"name": "現金", "type": "cash", "currency": None, "initial_balance": 500.0}
    assert ok[1]["args"] == {"project": None}
    assert ok[2]["args"]["price"] is None and ok[2]["args"]["op"] is None
    assert ok[3]["args"]["url"] is None  # 非 http(s) 網址不傳


def test_draft_names_chain_within_one_plan() -> None:
    # 同一份計畫裡剛建的分類／帳戶／專案／目標，後面的步驟可以直接用名稱
    ok = plan([
        {"tool": "add_category", "args": {"name": "毛孩", "kind": "expense"}},
        {"tool": "add_account", "args": {"name": "寵物錢包", "type": "cash"}},
        {"tool": "add_transaction", "args": {"type": "expense", "account": "寵物錢包", "category": "毛孩", "amount": 120}},
        {"tool": "transfer", "args": {"from_account": "錢包", "to_account": "寵物錢包", "amount": 200}},
        {"tool": "add_project", "args": {"name": "日本行", "is_travel": True}},
        {"tool": "set_travel_mode", "args": {"project": "日本行"}},
        {"tool": "add_goal", "args": {"name": "買相機", "target_amount": 100000}},
        {"tool": "edit_goal", "args": {"goal": "買相機", "set": {"target_amount": 120000}}},
    ])
    assert len(ok) == 8
    assert ok[2]["args"]["category"] == "毛孩" and ok[2]["args"]["account"] == "寵物錢包"
    assert ok[3]["args"]["to_account"] == "寵物錢包"
    assert ok[5]["args"]["project"] == "日本行"
    assert ok[7]["args"]["set"]["target_amount"] == 120000.0


def test_reject_bad_or_unsafe_steps() -> None:
    bad = [
        {"tool": "add_installment", "args": {"name": "手機", "account": "錢包", "amount": 12000, "periods": 1}},
        {"tool": "manage_recurring", "args": {"name": "不存在", "action": "pause"}},
        {"tool": "manage_recurring", "args": {"name": "Netflix", "action": "edit"}},
        {"tool": "manage_inbox", "args": {"action": "book"}},  # 下面會單獨測：沒有收件匣清單就丟
        {"tool": "add_category", "args": {"name": "午餐", "kind": "expense"}},  # 已有同名分類
        {"tool": "add_account", "args": {"name": "錢包", "type": "cash"}},  # 已有同名帳戶
        {"tool": "decide_wish", "args": {"name": "不存在", "decision": "bought"}},
        {"tool": "manage_durable", "args": {"action": "use", "name": "不存在"}},
        {"tool": "delete_transfer", "args": {"match": {}}},
        {"tool": "edit_goal", "args": {"goal": "日本旅遊", "set": {}}},
        {"tool": "set_travel_mode", "args": {"project": "不存在"}},
        {"tool": "manage_debt", "args": {"person": "小明", "action": "delete_all"}},
    ]
    with pytest.raises(ValueError):
        plan(bad, inbox=[])
    # 有收件匣清單時 manage_inbox 放行，其餘壞步驟仍被丟掉
    left = plan(bad)
    assert [s["tool"] for s in left] == ["manage_inbox"]


def test_transaction_extensions() -> None:
    ok = plan([
        {"tool": "add_transaction", "args": {"type": "expense", "account": "錢包", "category": "午餐", "amount": 500,
                                              "project": "沖繩", "tags": ["聚餐", "工作"], "merchant": "海底撈",
                                              "split": {"my_share": 300, "person": "小明"}, "exclude_budget": True, "exclude_stats": True}},
        {"tool": "add_transaction", "args": {"type": "expense", "account": "錢包", "category": "午餐", "amount": 500,
                                              "split": {"my_share": 600, "person": "小明"}}},
        {"tool": "edit_transaction", "args": {"match": {"latest": True}, "set": {"project": "沖繩", "tags": ["工作"], "exclude_budget": True}}},
        {"tool": "add_goal", "args": {"name": "買車", "target_amount": 100000, "account": "錢包"}},
    ])
    a = ok[0]["args"]
    assert a["split"] == {"my_share": 300.0, "person": "小明"}
    assert a["tags"] == ["聚餐", "工作"] and a["merchant"] == "海底撈" and a["project"] == "沖繩"
    assert a["exclude_budget"] is True and a["exclude_stats"] is True
    assert ok[1]["args"]["split"] is None  # 份額超過總金額 → 不分帳
    s = ok[2]["args"]["set"]
    assert s["project"] == "沖繩" and s["tags"] == ["工作"] and s["exclude_budget"] is True
    assert ok[3]["args"]["account"] == "錢包"


def test_prompt_and_payload_carry_new_context() -> None:
    for tool in ("add_installment", "add_project", "set_travel_mode", "manage_recurring", "manage_inbox", "add_category",
                 "add_dividend", "add_wish", "decide_wish", "manage_durable", "add_watch", "delete_transfer", "manage_debt", "edit_goal", "add_account"):
        assert tool in ai_tasks.AGENT_PLAN
    body = AgentPlanRequest(text="收件匣的都記一記", categories=CATS, accounts=ACCS, today="2026-11-09",
                            projects=["沖繩"], recurring=["Netflix"], tags=["工作"], wishes=["耳機"], durables=["相機"], inbox=["全家"])
    payload, kw = _agent_plan_payload(body)
    assert payload["可選專案"] == ["沖繩"] and payload["可選週期"] == ["Netflix"] and payload["可選標籤"] == ["工作"]
    assert payload["可選願望"] == ["耳機"] and payload["可選耐久財"] == ["相機"] and payload["收件匣待確認"] == ["全家"]
    assert kw["projects"] == ["沖繩"] and kw["inbox"] == ["全家"]
    # 空清單不送，避免提示詞膨脹
    payload2, _ = _agent_plan_payload(AgentPlanRequest(text="嗨", categories=CATS, accounts=ACCS, today="2026-11-09"))
    assert "可選專案" not in payload2 and "收件匣待確認" not in payload2