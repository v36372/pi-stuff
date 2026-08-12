from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).parents[1] / "scripts" / "session_recall.py"
SPEC = importlib.util.spec_from_file_location("session_recall", SCRIPT)
assert SPEC and SPEC.loader
recall = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recall)


def entry(entry_type: str, entry_id: str, parent_id: str | None, **values):
    return {"type": entry_type, "id": entry_id, "parentId": parent_id, **values}


def message(entry_id: str, parent_id: str | None, role: str, content):
    return entry("message", entry_id, parent_id, message={"role": role, "content": content})


class SessionRecallTests(unittest.TestCase):
    def test_active_branch_follows_final_leaf(self):
        entries = [
            {"type": "session", "version": 3, "cwd": "/tmp/project"},
            message("one", None, "user", [{"type": "text", "text": "start"}]),
            message("abandoned", "one", "assistant", [{"type": "text", "text": "old answer"}]),
            message("new", "one", "assistant", [{"type": "text", "text": "new answer"}]),
        ]
        self.assertEqual(recall.session_messages(entries), [("user", "start"), ("assistant", "new answer")])

    def test_message_projection_omits_thinking_and_tool_results(self):
        assistant = message(
            "one",
            None,
            "assistant",
            [
                {"type": "thinking", "thinking": "secret"},
                {"type": "text", "text": "public"},
                {"type": "toolCall", "name": "read", "arguments": {"path": "a.ts"}},
            ],
        )
        tool_result = message("two", "one", "toolResult", [{"type": "text", "text": "large output"}])
        role, text = recall.message_text(assistant)
        self.assertEqual(role, "assistant")
        self.assertIn("public", text)
        self.assertIn('[tool] read({"path":"a.ts"})', text)
        self.assertNotIn("secret", text)
        self.assertIsNone(recall.message_text(tool_result))

    def test_window_keeps_bookends_and_relevant_section(self):
        messages = [("user", f"message {index}" + (" passkey decision" if index == 8 else "") + " x" * 400) for index in range(12)]
        output = recall.window_conversation(messages, "What was the passkey decision?", 3_000)
        self.assertIn("message 0", output)
        self.assertIn("message 8 passkey decision", output)
        self.assertIn("message 11", output)
        self.assertIn("omitted", output)

    def test_search_uses_readable_messages_and_excludes_current(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = root / "2026-01-02T00-00-00_session.jsonl"
            (root / ".gitignore").write_text("*.jsonl\n")
            rows = [
                {"type": "session", "version": 3, "cwd": str(Path.home() / "code" / "demo")},
                message("one", None, "user", [{"type": "text", "text": "Investigate TypeBox failure"}]),
            ]
            session.write_text("\n".join(json.dumps(row) for row in rows) + "\n")

            with patch.dict("os.environ", {"PI_SESSION_FILE": str(root / "different.jsonl")}):
                results = recall.search_sessions("TypeBox", root, 10, 3, False)
            self.assertEqual(len(results), 1)
            self.assertEqual(results[0][2], "2026-01-02")
            self.assertEqual(results[0][3], "~/code/demo")

            with patch.dict("os.environ", {"PI_SESSION_FILE": str(session)}):
                self.assertEqual(recall.search_sessions("TypeBox", root, 10, 3, False), [])

    def test_session_path_cannot_escape_sessions_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "sessions"
            root.mkdir()
            outside = Path(temporary) / "outside.jsonl"
            outside.write_text("")
            with self.assertRaises(ValueError):
                recall.validate_session_path(outside, root)


if __name__ == "__main__":
    unittest.main()
