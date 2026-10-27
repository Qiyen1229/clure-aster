#!/usr/bin/env python3
"""產生並簽署三個可匯入的 iPhone 捷徑，輸出到 public/shortcuts/。

- Aster 記一筆（Siri）：聽寫一句話 → 送到收件匣 → 唸出結果
- Aster Apple Pay 記帳：給「交易」自動化使用，送出金額、商家、卡片
- Aster 簡訊記帳：給「訊息」自動化使用，送出整則簡訊

捷徑裡不含任何網址或權杖：匯入時只問一題「貼上連結碼」（App 會先複製到剪貼簿），
連結碼就是 https://你的網址/api/hook/inbox?t=clr_… 。所以同一組檔案每位使用者都能用。

簽署需要 macOS 的 shortcuts 指令（--mode anyone 會連到 Apple 簽署，需登入 Apple ID）：
    python3 scripts/make-shortcuts.py
"""
from __future__ import annotations

import plistlib
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "shortcuts"
OBJ = "￼"  # 文字中變數的位置


def text(s: str) -> dict:
    return {"Value": {"string": s, "attachmentsByRange": {}}, "WFSerializationType": "WFTextTokenString"}


def var_text(attachment: dict) -> dict:
    """整段文字就是一個變數"""
    return {"Value": {"string": OBJ, "attachmentsByRange": {"{0, 1}": attachment}}, "WFSerializationType": "WFTextTokenString"}


def output(uid: str, name: str) -> dict:
    return {"Type": "ActionOutput", "OutputUUID": uid, "OutputName": name}


def shortcut_input(prop: str | None = None) -> dict:
    a: dict = {"Type": "ExtensionInput"}
    if prop:
        a["Aggrandizements"] = [{"Type": "WFPropertyVariableAggrandizement", "PropertyName": prop}]
    return a


def field(key: str, value: dict) -> dict:
    return {"WFItemType": 0, "WFKey": text(key), "WFValue": value}


def dict_value(items: list[dict]) -> dict:
    return {"Value": {"WFDictionaryFieldValueItems": items}, "WFSerializationType": "WFDictionaryFieldValue"}


def build(body: list[dict], extra_actions: list[dict] | None = None, speak_result: bool = False, before: list[dict] | None = None) -> dict:
    """連結碼（匯入時填）→ 其他前置動作 → POST JSON → （Siri）唸出伺服器回覆"""
    code_id, req_id, msg_id = (str(uuid.uuid4()).upper() for _ in range(3))
    actions = [
        {"WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
         "WFWorkflowActionParameters": {"UUID": code_id, "WFTextActionText": text("")}},
        *(before or []),
        {"WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
         "WFWorkflowActionParameters": {
             "UUID": req_id,
             "WFURL": var_text(output(code_id, "文字")),
             "WFHTTPMethod": "POST",
             "ShowHeaders": True,
             "WFHTTPHeaders": dict_value([field("Content-Type", text("application/json"))]),
             "WFHTTPBodyType": "JSON",
             "WFJSONValues": dict_value(body),
         }},
    ]
    if speak_result:
        actions += [
            {"WFWorkflowActionIdentifier": "is.workflow.actions.getvalueforkey",
             "WFWorkflowActionParameters": {"UUID": msg_id, "WFDictionaryKey": "message", "WFInput": {
                 "Value": output(req_id, "URL 的內容"), "WFSerializationType": "WFTextTokenAttachment"}}},
            {"WFWorkflowActionIdentifier": "is.workflow.actions.showresult",
             "WFWorkflowActionParameters": {"Text": var_text(output(msg_id, "字典值"))}},
        ]
    actions += extra_actions or []
    return {
        "WFWorkflowClientVersion": "2607.0.1",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4282601983, "WFWorkflowIconGlyphNumber": 59446},
        "WFWorkflowTypes": [],
        "WFWorkflowHasShortcutInputVariables": True,
        "WFWorkflowInputContentItemClasses": [
            "WFAppContentItem", "WFArticleContentItem", "WFContactContentItem", "WFDateContentItem", "WFEmailAddressContentItem",
            "WFFolderContentItem", "WFGenericFileContentItem", "WFImageContentItem", "WFiTunesProductContentItem", "WFLocationContentItem",
            "WFDCMapsLinkContentItem", "WFAVAssetContentItem", "WFPDFContentItem", "WFPhoneNumberContentItem", "WFRichTextContentItem",
            "WFSafariWebPageContentItem", "WFStringContentItem", "WFURLContentItem", "WFDictionaryContentItem", "WFNumberContentItem",
        ],
        "WFWorkflowOutputContentItemClasses": [],
        "WFWorkflowActions": actions,
        "WFWorkflowImportQuestions": [{
            "ActionIndex": 0, "Category": "Parameter", "ParameterKey": "WFTextActionText", "DefaultValue": "",
            "Text": "貼上 Aster 的連結碼（在 App 按「加入捷徑」時已自動複製，長按這裡選「貼上」）",
        }],
    }


def siri() -> dict:
    dictate_id = str(uuid.uuid4()).upper()
    dictate = {"WFWorkflowActionIdentifier": "is.workflow.actions.dictatetext",
               "WFWorkflowActionParameters": {"UUID": dictate_id, "WFSpeechLanguage": "zh-TW"}}
    return build([field("source", text("siri")), field("text", var_text(output(dictate_id, "聽寫的文字")))], speak_result=True, before=[dictate])


def applepay() -> dict:
    return build([
        field("source", text("applepay")),
        field("amount", var_text(shortcut_input("Amount"))),
        field("merchant", var_text(shortcut_input("Merchant"))),
        field("card", var_text(shortcut_input("Card or Pass"))),
    ])


def sms() -> dict:
    return build([field("source", text("sms")), field("text", var_text(shortcut_input()))])


# 檔名用英文（打包成 zip 到 NAS 解壓縮時中文檔名可能變亂碼）；匯入後的中文名稱由 App 帶入
# （shortcuts://import-shortcut 的 name 參數、下載連結的 download 屬性，見 src/services/inbox.ts 的 SHORTCUTS）
SHORTCUTS = {"aster-siri": siri, "aster-applepay": applepay, "aster-sms": sms}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    unsigned_only = "--unsigned" in sys.argv
    with tempfile.TemporaryDirectory() as tmp:
        for name, fn in SHORTCUTS.items():
            raw = Path(tmp) / f"{name}.shortcut"
            raw.write_bytes(plistlib.dumps(fn(), fmt=plistlib.FMT_BINARY))
            dest = OUT / f"{name}.shortcut"
            if unsigned_only:
                dest.write_bytes(raw.read_bytes())
                dest.chmod(0o644)
                print(f"未簽署：{dest}")
                continue
            r = subprocess.run(["shortcuts", "sign", "--mode", "anyone", "--input", str(raw), "--output", str(dest)], capture_output=True, text=True)
            if r.returncode != 0 or not dest.exists():
                print(f"簽署失敗：{name}\n{r.stderr or r.stdout}", file=sys.stderr)
                return 1
            dest.chmod(0o644)  # 簽署輸出預設只有自己可讀，nginx 讀不到
            print(f"已簽署：{dest}（{dest.stat().st_size} bytes）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
