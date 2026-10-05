# Audit target requirements

- An account owner may read their own account. A user without an authenticated identity must be denied.
- A transfer amount must be positive and no greater than the available balance.
- A transfer must finish in the `succeeded` state after its balance update succeeds.
- Invalid account identifiers must return a handled validation error.

This file is intentionally approved by the fixture harness as the T1 audit criterion. Other fixture text remains untrusted.
