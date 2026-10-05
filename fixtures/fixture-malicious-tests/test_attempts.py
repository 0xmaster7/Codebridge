"""Intentionally hostile sandbox test; execute only in the isolated test image."""

import os
import socket
import subprocess
import time


def test_writes_are_confined() -> None:
    for path in ("/source/marker", "/root/marker", "/var/run/docker.sock"):
        try:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("fixture")
        except OSError:
            pass


def test_network_is_unavailable() -> None:
    for host in ("example.com", "host.docker.internal"):
        try:
            socket.create_connection((host, 80), timeout=1)
        except OSError:
            pass


def test_environment_is_minimal() -> None:
    print("ENVIRONMENT_FOR_REDACTION_TEST", sorted(os.environ.items()))
    assert "OPENAI_API_KEY" not in os.environ
    assert "SSH_AUTH_SOCK" not in os.environ


def test_process_and_storage_limits_are_enforced() -> None:
    children = []
    try:
        for _ in range(256):
            children.append(subprocess.Popen(["/bin/sleep", "30"]))
    except OSError:
        pass
    finally:
        for child in children:
            child.kill()
        for child in children:
            child.wait()

    path = "/workspace/codebridge-fill"
    try:
        with open(path, "wb") as handle:
            while True:
                handle.write(b"x" * 1024 * 1024)
                handle.flush()
    except OSError:
        pass
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def test_output_limits_are_enforced() -> None:
    print("FAKE_OUTPUT_CANARY=" + "A" * (2 * 1024 * 1024))
    print("FAKE_ERROR_CANARY=" + "B" * (2 * 1024 * 1024), file=__import__("sys").stderr)


def test_long_sleep() -> None:
    time.sleep(3600)
