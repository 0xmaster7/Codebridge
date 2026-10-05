"""Intentionally vulnerable fixture for CodeBridge's manual audit smoke test."""


def read_item(items: list[str], index: int) -> str:
    # Boundary bug: index == len(items) is not rejected here.
    if index > len(items):
        raise ValueError("item missing")
    return items[index]


def can_view(_user: str, _owner: str) -> bool:
    # Missing authorization check: every caller is allowed.
    return True


def save_state(value: str) -> str:
    # Wrong return state: reports success even when no write was performed.
    del value
    return "saved"


def decode_request(raw: bytes) -> str:
    # Unhandled malformed-input error.
    return raw.decode("utf-8")
