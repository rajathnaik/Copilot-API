from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, MagicMock
from urllib.error import HTTPError, URLError


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "generate-vscode-models.py"
SPEC = importlib.util.spec_from_file_location("generator", SCRIPT)
generator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(generator)
BASE = "https://example.test/v1"
SECRET = "${input:existing-secret}"


def chat(model_id="chat", endpoints=None):
    return {
        "id": model_id,
        "name": "Test Model",
        "supported_endpoints": endpoints or ["/chat/completions"],
        "capabilities": {
            "type": "chat",
            "limits": {
                "max_context_window_tokens": 1000,
                "max_prompt_tokens": 1000,
                "max_output_tokens": 200,
            },
            "supports": {"tool_calls": True, "vision": False},
        },
    }


class GeneratorTests(unittest.TestCase):
    def generate(self, entries, **kwargs):
        return generator.generate_config({"data": entries}, BASE, SECRET, "Test", **kwargs)

    def test_protocols_limits_and_embeddings(self):
        entries = [
            chat(),
            chat("responses", ["/v1/responses"]),
            chat("websocket", ["ws:/responses"]),
            chat("messages", ["/v1/messages"]),
            {"id": "embedding", "capabilities": {"type": "embeddings"}},
            {"id": "other", "capabilities": {"type": "other"}},
            chat("unsupported", ["/unknown"]),
        ]
        config, skipped = self.generate(entries)
        models = config[0]["models"]
        self.assertEqual(len(models), 4)
        self.assertEqual(len(skipped), 3)
        self.assertEqual([m["apiType"] for m in models],
                         ["chat-completions", "responses", "responses", "messages"])
        self.assertEqual(models[0]["maxInputTokens"], 800)
        self.assertEqual(models[3]["url"], BASE + "/messages")
        self.assertEqual(config[0]["apiKey"], SECRET)
        self.assertFalse(models[0]["vision"])

    def test_missing_context_and_name_fallback(self):
        model = chat()
        del model["capabilities"]["limits"]["max_context_window_tokens"]
        del model["name"]
        config, _ = self.generate([model])
        self.assertEqual(config[0]["models"][0]["maxInputTokens"], 1000)
        self.assertEqual(config[0]["models"][0]["name"], "chat")

    def test_invalid_metadata(self):
        changes = [
            ("id", ""),
            ("capabilities", None),
            ("supported_endpoints", [42]),
            ("name", 42),
        ]
        for key, value in changes:
            model = chat()
            model[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.generate([model])
        for section in ("limits", "supports"):
            model = chat()
            model["capabilities"][section] = None
            with self.subTest(section=section), self.assertRaises(ValueError):
                self.generate([model])
        for field, value in (("max_output_tokens", True), ("max_prompt_tokens", 0),
                             ("max_context_window_tokens", 10)):
            model = chat()
            model["capabilities"]["limits"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.generate([model])
        model = chat()
        model["capabilities"]["supports"]["vision"] = "true"
        with self.assertRaises(ValueError):
            self.generate([model])

    def test_invalid_catalogs_and_secret(self):
        for catalog in ([], {}, {"data": []}, {"data": [None]},
                        {"data": [chat(), chat()]}, {"data": [], "has_more": True}):
            with self.subTest(catalog=catalog), self.assertRaises(ValueError):
                generator.generate_config(catalog, BASE, SECRET, "Test")
        with self.assertRaises(ValueError):
            generator.generate_config({"data": [chat()]}, BASE, "raw-key", "Test")

    def test_url_normalization(self):
        self.assertEqual(generator.normalize_base_url("https://example.test/"), BASE)
        self.assertEqual(generator.normalize_base_url(BASE + "/"), BASE)
        self.assertEqual(generator.normalize_base_url("http://127.0.0.1:4141"),
                         "http://127.0.0.1:4141/v1")
        for url in ("ftp://example.test", "http://example.test", "https://user:pass@example.test",
                    BASE + "?key=x", BASE + "#x", BASE + "/models", "invalid"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                generator.normalize_base_url(url)

    def test_fetch_and_redirect_protection(self):
        response = MagicMock()
        response.__enter__.return_value = io.StringIO('{"data": []}')
        opener = MagicMock()
        opener.open.return_value = response
        with patch.object(generator, "build_opener", return_value=opener):
            self.assertEqual(generator.fetch_catalog(BASE, "test-only-key"), {"data": []})
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, BASE + "/models")
        self.assertEqual(request.get_header("Authorization"), "Bearer test-only-key")
        with self.assertRaises(ValueError):
            generator.NoRedirects().redirect_request(None, None, 302, "", {}, "https://other.test")

    def test_cli_saved_catalog_and_overwrite_guard(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "catalog.json"
            output = Path(directory) / "generated.json"
            source.write_text(json.dumps({"data": [chat()]}), encoding="utf-8")
            args = ["--base-url", BASE, "--secret-ref", SECRET, "--catalog", str(source),
                    "--output", str(output)]
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(generator.main(args), 0)
                expected = output.read_text(encoding="utf-8")
                self.assertEqual(generator.main(args), 1)
                self.assertEqual(output.read_text(encoding="utf-8"), expected)
                self.assertEqual(generator.main(args + ["--force"]), 0)
                args[args.index("--output") + 1] = str(source)
                self.assertEqual(generator.main(args + ["--force"]), 1)

    def test_cli_network_errors_and_hidden_key(self):
        with tempfile.TemporaryDirectory() as directory:
            args = ["--base-url", BASE, "--secret-ref", SECRET,
                    "--output", str(Path(directory) / "generated.json")]
            with patch.dict(generator.os.environ, {"COPILOT_API_KEY": "test-only-key"}):
                for error in (HTTPError(BASE, 401, "", {}, None), URLError("offline"),
                              ValueError("invalid JSON"), OSError("permission denied")):
                    with patch.object(generator, "fetch_catalog", side_effect=error):
                        with redirect_stderr(io.StringIO()) as stderr:
                            self.assertEqual(generator.main(args), 1)
                            self.assertIn("Error:", stderr.getvalue())
                            self.assertNotIn("test-only-key", stderr.getvalue())
                with patch.object(generator, "fetch_catalog", return_value={"data": [chat()]}):
                    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                        self.assertEqual(generator.main(args), 0)
            with patch.dict(generator.os.environ, {}, clear=True):
                with patch.object(generator.getpass, "getpass", return_value=""):
                    with redirect_stderr(io.StringIO()):
                        self.assertEqual(generator.main(args + ["--force"]), 1)

    def test_direct_update_preserves_providers_secret_and_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "chatLanguageModels.json"
            other = {"name": "Other", "vendor": "other", "models": [{"id": "keep"}]}
            existing = {"name": "My Copilot API", "vendor": "customendpoint",
                        "apiKey": SECRET, "url": BASE, "apiType": "chat-completions",
                        "custom": "preserved"}
            original = json.dumps([other, existing]).encode()
            target.write_bytes(original)
            args = ["--base-url", BASE, "--update-vscode", str(target)]
            with patch.dict(generator.os.environ, {"COPILOT_API_KEY": "test-key"}):
                with patch.object(generator, "fetch_catalog", return_value={"data": [chat()]}):
                    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                        self.assertEqual(generator.main(args), 0)
                        self.assertEqual(generator.main(args + ["--force"]), 1)
            updated = json.loads(target.read_text())
            self.assertEqual(updated[0], other)
            self.assertEqual(updated[1]["apiKey"], SECRET)
            self.assertEqual(updated[1]["custom"], "preserved")
            self.assertNotIn("url", updated[1])
            self.assertEqual(len(updated[1]["models"]), 1)
            backups = list(Path(directory).glob("*.backup-*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), original)
            self.assertFalse(list(Path(directory).glob("*.tmp-*")))

    def test_update_rejects_invalid_or_ambiguous_config(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "config.json"
            provider = {"name": "Test", "vendor": "customendpoint"}
            for text in ("// comment\n[]", "{}", "[null]", "[]",
                         json.dumps([provider, provider])):
                target.write_text(text)
                with self.subTest(text=text), self.assertRaises(ValueError):
                    generator.read_vscode_config(target, "Test")
                self.assertEqual(target.read_text(), text)

    def test_update_detects_concurrent_changes_and_cleans_failed_write(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "config.json"
            original = b'[{"name":"Test","vendor":"customendpoint"}]'
            target.write_bytes(original)
            providers = json.loads(original)
            generated = {"apiKey": SECRET, "models": []}
            target.write_text("[]")
            with self.assertRaises(ValueError):
                generator.update_vscode_config(target, original, providers, 0, generated)
            target.write_bytes(original)
            with patch.object(generator.os, "replace", side_effect=OSError("write failed")):
                with self.assertRaises(OSError):
                    generator.update_vscode_config(target, original, providers, 0, generated)
            self.assertEqual(target.read_bytes(), original)
            self.assertFalse(list(Path(directory).glob("*.tmp-*")))

    def test_missing_secret_fails_explicitly(self):
        with redirect_stderr(io.StringIO()):
            self.assertEqual(generator.main(["--base-url", BASE]), 1)


if __name__ == "__main__":
    unittest.main()
