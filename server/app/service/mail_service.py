"""Email 轉寄收帳單（方案 A）：把轉寄來的信解析成「收件匣項目＋附件」。

使用者在自己的信箱設定「銀行帳單信自動轉寄到專屬地址」，收信管道（例如 Cloudflare Email Routing 的 Email Worker）
把整封信 POST 到 /api/hook/mail；這裡用標準函式庫解析（不依賴任何第三方套件）：
- 本文：取純文字（沒有就把 HTML 去標籤），整理空白、截成收件匣項目的文字長度
- 附件：只收 CSV、帳單截圖（JPEG／PNG／WebP）、PDF，各有大小上限、最多 3 個；其餘略過並在文字裡註明
- 寄件人白名單（選用）：只收指定網域或地址的信，擋掉垃圾信
Aster 不會取得使用者信箱的帳號密碼，只收使用者主動轉寄的信。
"""
from __future__ import annotations

import base64
import binascii
import html
import re
from dataclasses import dataclass, field
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import parseaddr

MAX_RAW = 10 * 1024 * 1024  # 整封信上限
MAX_ATTACHMENTS = 3
TEXT_LIMIT = 1000  # 收件匣項目的文字長度（和 InboxItem.text 一致）
SIZE_LIMITS = {"csv": 1 * 1024 * 1024, "image": 3 * 1024 * 1024, "pdf": 4 * 1024 * 1024}
IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp")


@dataclass
class MailAttachment:
    filename: str
    content_type: str
    data: bytes


@dataclass
class ParsedMail:
    sender: str = ""  # 完整地址（小寫），白名單比對用
    sender_name: str = ""  # 顯示用
    subject: str = ""
    body: str = ""
    attachments: list[MailAttachment] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)  # 因類型或大小被略過的附件檔名


def _strip_html(s: str) -> str:
    s = re.sub(r"(?is)<(script|style).*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</(p|div|tr|li|h\d)>", "\n", s)
    return html.unescape(re.sub(r"<[^>]+>", " ", s))


def _tidy(s: str) -> str:
    s = s.replace("\r", "")
    s = re.sub(r"[ \t 　]+", " ", s)
    return re.sub(r"\n\s*\n+", "\n", s).strip()


def _kind(filename: str, ctype: str) -> str | None:
    name = filename.lower()
    if ctype in IMAGE_TYPES:
        return "image"
    if ctype == "application/pdf" or name.endswith(".pdf"):
        return "pdf"
    if name.endswith(".csv") or ctype in ("text/csv", "application/csv"):
        return "csv"
    return None


def _add_attachment(out: ParsedMail, filename: str, ctype: str, data: bytes) -> None:
    kind = _kind(filename, ctype.lower())
    if kind is None or len(data) == 0 or len(data) > SIZE_LIMITS[kind] or len(out.attachments) >= MAX_ATTACHMENTS:
        out.skipped.append(filename or ctype)
        return
    out.attachments.append(MailAttachment(filename=(filename or f"附件.{kind}")[:200], content_type=ctype.lower()[:80], data=data))


def _identify(out: ParsedMail, from_header: str) -> None:
    name, addr = parseaddr(from_header or "")
    out.sender = addr.strip().lower()[:200]
    out.sender_name = (name or addr).strip()[:120]


def parse_raw(raw: bytes) -> ParsedMail:
    """解析一整封 RFC 822 信（Cloudflare Email Worker 的 message.raw 就是這個格式）"""
    msg = BytesParser(policy=policy.default).parsebytes(raw)
    out = ParsedMail(subject=str(msg.get("subject") or "").strip()[:200])
    _identify(out, str(msg.get("from") or ""))
    body = ""
    part = msg.get_body(preferencelist=("plain", "html"))
    if part is not None:
        try:
            content = part.get_content()
        except (LookupError, UnicodeDecodeError):  # 宣告的字元集不存在或內容壞掉
            content = ""
        body = _strip_html(content) if part.get_content_type() == "text/html" else content
    out.body = _tidy(body)
    for att in msg.iter_attachments():
        filename = att.get_filename() or ""
        ctype = att.get_content_type()
        data = att.get_payload(decode=True) if not att.is_multipart() else None
        if isinstance(data, bytes):
            _add_attachment(out, filename, ctype, data)
    return out


def parse_json(d: object) -> ParsedMail:
    """備用格式：{"from","subject","text","attachments":[{"filename","content_type","content_base64"}]}（Mailgun、Postmark 之類轉成 JSON 時用）"""
    d = d if isinstance(d, dict) else {}
    out = ParsedMail(subject=str(d.get("subject") or "").strip()[:200])
    _identify(out, str(d.get("from") or ""))
    out.body = _tidy(str(d.get("text") or "") or _strip_html(str(d.get("html") or "")))
    atts = d.get("attachments")
    for a in (atts if isinstance(atts, list) else [])[:10]:
        if not isinstance(a, dict):
            continue
        try:
            data = base64.b64decode(str(a.get("content_base64") or ""), validate=False)
        except (binascii.Error, ValueError):
            continue
        _add_attachment(out, str(a.get("filename") or ""), str(a.get("content_type") or ""), data)
    return out


def allowed(sender: str, allow_from: str) -> bool:
    """白名單：空白＝不限；項目可以是完整地址或網域（esunbank.com.tw 也接受 @esunbank.com.tw、子網域）"""
    rules = [r.strip().lower().lstrip("@") for r in re.split(r"[,\s;]+", allow_from or "") if r.strip()]
    if not rules:
        return True
    s = (sender or "").lower()
    domain = s.rsplit("@", 1)[-1] if "@" in s else ""
    return any(s == r or domain == r or domain.endswith("." + r) for r in rules)


def item_text(m: ParsedMail) -> str:
    """收件匣項目的文字：主旨＋本文（附件被略過時註明），截到上限"""
    parts = [m.subject, m.body]
    if m.skipped:
        parts.append("（略過的附件：" + "、".join(m.skipped[:3]) + "）")
    return "\n".join(p for p in parts if p)[:TEXT_LIMIT]
