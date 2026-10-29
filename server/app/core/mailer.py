"""寄信（SMTP）。只用標準函式庫；未設定 CLURE_SMTP_HOST 時視為未啟用。"""
from __future__ import annotations

import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr

from app.core.config import get_settings

log = logging.getLogger("aster.mail")


def mail_configured() -> bool:
    s = get_settings()
    return bool(s.smtp_host and (s.smtp_from or s.smtp_user))


def send_mail(to: str, subject: str, body: str) -> None:
    """寄出純文字信；失敗丟出 MailError（訊息可給管理員看，不含密碼）。"""
    s = get_settings()
    if not mail_configured():
        raise MailError("尚未設定寄信（CLURE_SMTP_HOST、CLURE_SMTP_FROM）")
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr(("Aster 記帳", s.smtp_from or s.smtp_user))
    msg["To"] = to
    msg.set_content(body)
    try:
        ctx = ssl.create_default_context()
        if s.smtp_security == "ssl":
            smtp: smtplib.SMTP = smtplib.SMTP_SSL(s.smtp_host, s.smtp_port, timeout=15, context=ctx)
        else:
            smtp = smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=15)
        with smtp:
            smtp.ehlo()
            if s.smtp_security == "starttls":
                smtp.starttls(context=ctx)
                smtp.ehlo()
            if s.smtp_user:
                smtp.login(s.smtp_user, s.smtp_password)
            smtp.send_message(msg)
    except smtplib.SMTPAuthenticationError as e:
        raise MailError("寄信伺服器拒絕帳號或密碼（Gmail 需使用「應用程式密碼」）") from e
    except smtplib.SMTPRecipientsRefused as e:
        raise MailError("收件信箱被拒絕") from e
    except (smtplib.SMTPException, OSError) as e:
        log.warning("寄信失敗 host=%s err=%s", s.smtp_host, e)
        raise MailError(f"連不上寄信伺服器或寄送失敗：{type(e).__name__}") from e


class MailError(Exception):
    pass
