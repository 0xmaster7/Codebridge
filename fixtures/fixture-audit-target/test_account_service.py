"""Misleading tests that pass while known requirements remain violated."""

from account_service import account_balance, can_read_account, transfer_state


def test_owner_can_read_account() -> None:
    assert can_read_account("acct-1", "acct-1") is True


def test_small_positive_transfer_is_accepted() -> None:
    assert transfer_state(100, 25) == "pending"


def test_known_account_balance() -> None:
    assert account_balance({"acct-1": 100}, "acct-1") == 100
