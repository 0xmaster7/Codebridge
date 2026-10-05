# Malicious Git metadata fixture

The harness installs harmless marker-writing hook/filter/diff/fsmonitor stubs in an isolated temporary Git repository. A marker's appearance means the test failed. Never run fixture commands directly against a developer repository.
