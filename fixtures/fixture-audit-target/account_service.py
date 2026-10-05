"""Synthetic service with planted security and correctness defects."""


def can_read_account(owner_id: str, requester_id: str | None) -> bool:
    # Planted authorization defect: an anonymous requester is allowed.
    return requester_id == owner_id or requester_id is None


def transfer(balance: int, amount: int) -> tuple[int, str]:
    # Planted boundary defect: a negative amount increases the balance.
    if amount <= balance:
        return balance - amount, "pending"
    return balance, "rejected"


def transfer_state(balance: int, amount: int) -> str:
    updated, state = transfer(balance, amount)
    if updated != balance:
        return "pending"
    return state


def account_balance(accounts: dict[str, int], account_id: str) -> int:
    # Planted error-handling defect: missing keys escape as KeyError.
    return accounts[account_id]
