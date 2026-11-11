import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

path = Path(__file__).resolve().parents[1] / 'mods/hakoniwa/py/codex_conversation.py'
spec = importlib.util.spec_from_file_location('codex_conversation', path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def record(role, text):
    return {'type': 'response_item', 'payload': {'type': 'message', 'role': role,
            'content': [{'type': 'input_text' if role == 'user' else 'output_text', 'text': text}]}}


class ConversationTest(unittest.TestCase):
    def test_unique_match_and_roles(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = root / '2026/11/12'
            folder.mkdir(parents=True)
            target = folder / 'rollout-1.jsonl'
            target.write_text('\n'.join(json.dumps(v) for v in [record('user', '이것은 충분히 길고 구별되는 테스트 요청 문장입니다'),
                {'type': 'response_item', 'payload': {'type': 'function_call', 'name': 'exec', 'arguments': '{"cmd":"test"}'}},
                record('assistant', '응답')]), encoding='utf8')
            screen = '› 이것은 충분히 길고 구별되는 테스트 요청 문장입니다\n› Ask Codex to do anything'
            self.assertEqual(mod.locate_codex(screen, root), target)
            self.assertEqual([m['role'] for m in mod.codex_messages(target, 10)], ['user', 'tool', 'assistant'])
            (folder / 'rollout-2.jsonl').write_text(json.dumps(record('user', '이것은 충분히 길고 구별되는 테스트 요청 문장입니다')), encoding='utf8')
            self.assertIsNone(mod.locate_codex(screen, root))
            self.assertIsNone(mod.locate_codex('› 짧음', root))


if __name__ == '__main__':
    unittest.main()
