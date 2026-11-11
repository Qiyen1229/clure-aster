#!/usr/bin/env python3
"""產生並簽署六個可匯入的 iPhone 捷徑，輸出到 public/shortcuts/。

- Aster 通知記帳：內建台灣主流銀行 App、LINE Pay、街口支付等通知自動化觸發器，刷實體卡、網購、掃碼跳通知自動送到收件匣
- Aster Apple Pay 記帳：內建「錢包（交易）」自動化觸發器，感應付款後自動送出金額、商家、卡片
- Aster 記一筆（Siri）：聽寫一句話 → 送到收件匣 → 唸出結果
- Aster 快速記帳：跳出輸入框，打一句話（「午餐 120」）→ 送到收件匣（適合動作按鈕、背面輕點、主畫面）
- Aster 貼上記帳：把剪貼簿的文字（從銀行 App、LINE 複製的交易明細）送到收件匣
- Aster 分享記帳：出現在任何 App 的分享選單，把分享的文字送到收件匣

捷徑裡不含任何網址或權杖：匯入時只問一題「貼上連結碼」（App 會先複製到剪貼簿），
連結碼就是 https://你的網址/api/hook/inbox?t=clr_… 。所以同一組檔案每位使用者都能用。

簽署需要 macOS 的 shortcuts 指令（--mode anyone 會連到 Apple 簽署並產生 iCloud 分享識別碼，需登入 Apple ID）：
    python3 scripts/make-shortcuts.py                      # 全部
    python3 scripts/make-shortcuts.py --only notify,applepay  # 只重做指定的（不動已經發布過的檔案）
"""
from __future__ import annotations

import plistlib
import re
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "shortcuts"
OBJ = "￼"  # 文字中變數的位置

# 預先內建於「Aster 通知記帳」自動化觸發器（WFNotificationTrigger）的台灣主流銀行與行動支付 App
NOTIFY_APPS = [
    # 行動支付／掃碼付款
    {"BundleIdentifier": "com.linepaytw.upay", "Name": "LINE Pay"},
    {"BundleIdentifier": "jp.naver.line", "Name": "LINE"},
    {"BundleIdentifier": "com.jkos.JKOS", "Name": "街口支付"},
    {"BundleIdentifier": "com.pxpayplus.app", "Name": "全支付"},
    {"BundleIdentifier": "com.ipass.ipassmoney", "Name": "iPASS MONEY"},
    {"BundleIdentifier": "tw.com.easycard.easycardwallet", "Name": "Easy Wallet"},
    {"BundleIdentifier": "tw.com.icash.i.icashpay", "Name": "icash Pay"},
    {"BundleIdentifier": "tw.com.openpoint.member", "Name": "OPENPOINT"},
    {"BundleIdentifier": "com.etmgup.pxmart", "Name": "全聯福利中心"},
    {"BundleIdentifier": "tw.com.twmp.twhcewallet", "Name": "台灣行動支付"},
    # 銀行與信用卡 App（刷實體卡／網購／綁定支付）
    {"BundleIdentifier": "com.cathaybk.cathaybk", "Name": "國泰世華"},
    {"BundleIdentifier": "com.cathayholdings.mymobione", "Name": "國泰優惠"},
    {"BundleIdentifier": "com.chinatrust.mobilebank", "Name": "中國信託"},
    {"BundleIdentifier": "tw.com.esunbank.app.esunwallet", "Name": "玉山 Wallet"},
    {"BundleIdentifier": "tw.com.ESunbank.mobilebanking.release", "Name": "玉山行動銀行"},
    {"BundleIdentifier": "tw.com.taishinbank.richart", "Name": "Richart"},
    {"BundleIdentifier": "tw.com.taishinbank.cardaily", "Name": "Richart Life"},
    {"BundleIdentifier": "tw.com.taishinbank.mobile", "Name": "台新銀行"},
    {"BundleIdentifier": "com.fubon.aibank", "Name": "台北富邦 Fubon+"},
    {"BundleIdentifier": "tw.com.mma.xphone", "Name": "永豐行動銀行"},
    {"BundleIdentifier": "com.sinopac.dawho", "Name": "永豐 DAWHO"},
    {"BundleIdentifier": "com.linebank.tw", "Name": "LINE Bank"},
    {"BundleIdentifier": "com.nextbank.ncbportal", "Name": "將來銀行 NextBank"},
    {"BundleIdentifier": "com.firstbank.mbank", "Name": "第一銀行 第e行動"},
    {"BundleIdentifier": "com.firstbank.mBankForLite", "Name": "第一銀行 iLEO"},
    {"BundleIdentifier": "tw.com.megabank.mobilebank.pre", "Name": "兆豐銀行"},
    {"BundleIdentifier": "tw.com.hncb.NMBank", "Name": "華南銀行+"},
    {"BundleIdentifier": "com.bot.ibank.p", "Name": "臺銀行動+"},
    {"BundleIdentifier": "tw.com.tcb-bank.mbbank.released", "Name": "合作金庫"},
    {"BundleIdentifier": "tw.gov.post.mpost", "Name": "行動郵局"},
    {"BundleIdentifier": "com.obank.tw.ebank", "Name": "王道銀行 O-Bank"},
    {"BundleIdentifier": "com.feib.mobile.pmb", "Name": "遠東商銀"},
    {"BundleIdentifier": "com.dbs.mbanking.tw", "Name": "星展 digibank"},
    {"BundleIdentifier": "com.dbs.cardplus.tw", "Name": "星展 Card+"},
    {"BundleIdentifier": "tw.com.hsbc.hsbctaiwan", "Name": "滙豐台灣"},
    {"BundleIdentifier": "tw.com.SCBreeze", "Name": "渣打行動銀行"},
]


def text(s: str) -> dict:
    return {"Value": {"string": s, "attachmentsByRange": {}}, "WFSerializationType": "WFTextTokenString"}


def var_text(attachment: dict) -> dict:
    """整段文字就是一個變數"""
    return {"Value": {"string": OBJ, "attachmentsByRange": {"{0, 1}": attachment}}, "WFSerializationType": "WFTextTokenString"}


def multi_var_text(attachments: list[dict], sep: str = "\n") -> dict:
    """多個變數以分隔符串接成一段文字"""
    s = sep.join(OBJ for _ in attachments)
    step = len(sep) + 1
    ranges = {f"{{{i * step}, 1}}": att for i, att in enumerate(attachments)}
    return {"Value": {"string": s, "attachmentsByRange": ranges}, "WFSerializationType": "WFTextTokenString"}


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


def build(
    body: list[dict],
    extra_actions: list[dict] | None = None,
    speak_result: bool = False,
    before: list[dict] | None = None,
    types: list[str] | None = None,
    triggers: list[dict] | None = None,
) -> dict:
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
    wf: dict = {
        "WFWorkflowClientVersion": "2607.0.1",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4282601983, "WFWorkflowIconGlyphNumber": 59446},
        "WFWorkflowTypes": types or [],
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
    if triggers:
        wf["WFWorkflowTriggers"] = triggers
    return wf


def siri() -> dict:
    dictate_id = str(uuid.uuid4()).upper()
    dictate = {"WFWorkflowActionIdentifier": "is.workflow.actions.dictatetext",
               "WFWorkflowActionParameters": {"UUID": dictate_id, "WFSpeechLanguage": "zh-TW"}}
    return build([field("source", text("siri")), field("text", var_text(output(dictate_id, "聽寫的文字")))], speak_result=True, before=[dictate])


def quick() -> dict:
    ask_id = str(uuid.uuid4()).upper()
    ask = {"WFWorkflowActionIdentifier": "is.workflow.actions.ask",
           "WFWorkflowActionParameters": {"UUID": ask_id, "WFAskActionPrompt": "記一筆（例如：午餐 120、昨天計程車 230）", "WFInputType": "Text"}}
    return build([field("source", text("quick")), field("text", var_text(output(ask_id, "詢問的輸入")))], speak_result=True, before=[ask])


def clipboard() -> dict:
    clip_id = str(uuid.uuid4()).upper()
    clip = {"WFWorkflowActionIdentifier": "is.workflow.actions.getclipboard", "WFWorkflowActionParameters": {"UUID": clip_id}}
    return build([field("source", text("clipboard")), field("text", var_text(output(clip_id, "剪貼簿")))], speak_result=True, before=[clip])


def share() -> dict:
    # WFWorkflowTypes 含 ActionExtension 才會出現在分享選單；內容是分享進來的文字
    return build([field("source", text("share")), field("text", var_text(shortcut_input()))], speak_result=True, types=["ActionExtension"])


def applepay() -> dict:
    return build(
        [
            field("source", text("applepay")),
            field("amount", var_text(shortcut_input("Amount"))),
            field("merchant", var_text(shortcut_input("Merchant"))),
            field("card", var_text(shortcut_input("Card or Pass"))),
        ],
        triggers=[{
            "WFTriggerIdentifier": "WFWalletTransactionTrigger",
            "WFTriggerUUID": str(uuid.uuid4()).upper(),
            "WFTriggerSerializedParameters": {},
        }],
    )


def notify() -> dict:
    """銀行 App／LINE Pay／街口支付等通知自動記帳（內建 30+ 個台灣銀行與行動支付 App 觸發器）"""
    return build(
        [
            field("source", text("notify")),
            field("card", var_text(shortcut_input("App"))),
            field("text", multi_var_text([shortcut_input("Subtitle"), shortcut_input()])),
        ],
        triggers=[{
            "WFTriggerIdentifier": "WFNotificationTrigger",
            "WFTriggerUUID": str(uuid.uuid4()).upper(),
            "WFTriggerSerializedParameters": {
                "SelectedApps": NOTIFY_APPS,
            },
        }],
    )


# 檔名用英文（打包成 zip 到 NAS 解壓縮時中文檔名可能變亂碼）；簽署時的暫存檔名用中文，讓 iCloud 分享頁直接顯示中文捷徑名稱
SHORTCUTS: dict[str, tuple[str, object]] = {
    "aster-notify": ("Aster 通知記帳", notify),
    "aster-applepay": ("Aster Apple Pay 記帳", applepay),
    "aster-siri": ("Aster 記一筆", siri),
    "aster-quick": ("Aster 快速記帳", quick),
    "aster-clipboard": ("Aster 貼上記帳", clipboard),
    "aster-share": ("Aster 分享記帳", share),
}


def extract_icloud_id(signed_bytes: bytes) -> str | None:
    m = re.search(b"[0-9a-f]{32}", signed_bytes[:8192])
    return m.group(0).decode("ascii") if m else None


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    unsigned_only = "--unsigned" in sys.argv
    only = {f"aster-{k.strip()}" for k in sys.argv[sys.argv.index("--only") + 1].split(",")} if "--only" in sys.argv else None
    with tempfile.TemporaryDirectory() as tmp:
        for name, (display_name, fn) in SHORTCUTS.items():
            if only is not None and name not in only:
                continue
            raw = Path(tmp) / f"{display_name}.shortcut"
            raw.write_bytes(plistlib.dumps(fn(), fmt=plistlib.FMT_BINARY))  # type: ignore[operator]
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
            icloud_id = extract_icloud_id(dest.read_bytes())
            print(f"已簽署：{dest}（{dest.stat().st_size} bytes） icloud={icloud_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
