from permissions import PermissionManager


def make(answer):
    calls = []

    def ask(name, args):
        calls.append(name)
        return answer, ""

    return PermissionManager(ask=ask), calls


def test_read_needs_no_confirm():
    pm, calls = make("n")
    assert pm.check("read_file", {"path": "README.md"}).allowed
    assert calls == []


def test_path_escape_denied_even_if_user_would_allow():
    pm, calls = make("y")
    assert not pm.check("read_file", {"path": "../../etc/passwd"}).allowed
    assert not pm.check("write_file", {"path": "/etc/hosts", "content": "x"}).allowed
    assert calls == []          # 硬规则拦截，根本没问人


def test_dangerous_shell_denied():
    pm, calls = make("y")
    assert not pm.check("run_shell", {"command": "sudo rm -rf /"}).allowed
    assert calls == []


def test_shell_needs_confirm():
    pm, calls = make("y")
    assert pm.check("run_shell", {"command": "ls"}).allowed
    assert calls == ["run_shell"]


def test_unknown_tool_defaults_to_confirm():
    pm, calls = make("n")
    assert not pm.check("send_email", {}).allowed
    assert calls == ["send_email"]


def test_always_only_applies_to_write_file():
    pm, calls = make("a")
    pm.check("write_file", {"path": "a.txt", "content": ""})
    pm.check("write_file", {"path": "b.txt", "content": ""})
    assert calls == ["write_file"]            # 第二次没再问
    pm.check("run_shell", {"command": "ls"})
    pm.check("run_shell", {"command": "ls"})
    assert calls.count("run_shell") == 2      # run_shell 每次都问