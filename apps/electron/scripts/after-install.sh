#!/bin/bash
# Ubuntu 24.04+ ограничивает unprivileged user namespaces (AppArmor), из-за чего
# стандартный postinst снимает setuid с chrome-sandbox, полагаясь на userns, и
# SUID-песочница Electron падает. Принудительно возвращаем SUID-песочницу.
chmod 4755 '/opt/MailSense/chrome-sandbox' || true
