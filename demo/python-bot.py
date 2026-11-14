#!/usr/bin/env python3
"""Демо-python приложение для OmniDash (реальный процесс, видно в метриках)."""
import random
import sys
import threading
import time

name = "python-bot"
if "--name" in sys.argv:
    name = sys.argv[sys.argv.index("--name") + 1]

hold = bytearray(16 * 1024 * 1024)
started = time.time()

print(f"\033[90m[python] старт приложения «{name}»\033[0m", flush=True)
time.sleep(0.4)
print("\033[90m[python] загрузка зависимостей...\033[0m", flush=True)
time.sleep(0.5)
print("\033[32mBot online — Python 3.12 demo worker\033[0m", flush=True)


def heartbeat():
    while True:
        time.sleep(15)
        print(
            f"\033[90m[worker] tick {random.randint(100, 999)} | "
            f"uptime {int(time.time() - started)}s | heap {len(hold)//1048576}MB\033[0m",
            flush=True,
        )


threading.Thread(target=heartbeat, daemon=True).start()

for line in sys.stdin:
    cmd = line.strip()
    if cmd in ("stop", "shutdown", "exit"):
        print("\033[33m[python] остановка по команде\033[0m", flush=True)
        sys.exit(0)
    elif cmd == "status":
        print(
            f"worker {name} | uptime {int(time.time() - started)}s | rss {len(hold)//1048576}MB",
            flush=True,
        )
    elif cmd.startswith("say "):
        print(f"\033[32m[say] {cmd[4:]}\033[0m", flush=True)
    elif cmd == "help":
        print("Команды: status, say <текст>, help, stop", flush=True)
    elif cmd:
        print(f"\033[90m[python] {cmd}\033[0m", flush=True)
