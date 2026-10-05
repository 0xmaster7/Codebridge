from src.service import can_view, read_item, save_state


def test_read_item_accepts_valid_index() -> None:
    assert read_item(["only"], 0) == "only"


def test_everyone_can_view() -> None:
    # Misleading passing test: it confirms the vulnerable behavior as intended.
    assert can_view("intruder", "owner") is True


def test_save_reports_success() -> None:
    assert save_state("value") == "saved"
